const createTestnet = require('hyperdht/testnet')
const Hyperswarm = require('hyperswarm')
const b4a = require('b4a')
const tmp = require('test-tmp')
const fs = require('fs')
const path = require('path')
const process = require('process')
const { spawn } = require('child_process')

const { GipLocalDB } = require('../../lib/db')

const BIN = path.join(__dirname, '..', '..', 'bin.js')

const SEED = Number(process.env.GIP_CHAOS_SEED || 1)
const ITERS = Number(process.env.GIP_CHAOS_ITERS || 0)

const HANG = 30_000 + ITERS * 3_000

module.exports = { create, killPoints, random, ITERS }

// A testnet, a PATH shim for the helper and a git runner that can SIGKILL the helper.
async function create(t) {
  const testnet = await createTestnet(3, t.teardown)
  const dir = await tmp(t)

  // exec keeps the pid, so the pid file names the helper itself, not the shell.
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  const shim = path.join(bin, 'git-remote-git+pear')
  fs.writeFileSync(
    shim,
    `#!/bin/sh\necho $$ > "$GIP_CHAOS_PID"\nexec "${process.execPath}" "${BIN}" "$@"\n`
  )
  fs.chmodSync(shim, 0o755)

  const bootstrap = testnet.bootstrap
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GIP_NO_UPDATES: '1',
    GIP_BOOTSTRAP: bootstrap.map((node) => `${node.host}:${node.port}`).join(','),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'gc.auto',
    GIT_CONFIG_VALUE_0: '0',
    GIT_CONFIG_KEY_1: 'maintenance.auto',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_NOSYSTEM: '1'
  }

  let runs = 0

  // Never rejects: resolves { code, signal, stdout, stderr, killed, hung, ms }, hung meaning it
  // was still running after HANG ms and got killed.
  // opts.kill = { marker, delay } SIGKILLs the helper `delay` ms after `marker` shows on stderr.
  // opts.on = { marker, fn } runs fn once when `marker` shows on stderr.
  // Async spawn only: the testnet lives in this process, spawnSync would freeze it.
  function git(args, opts = {}) {
    const pidFile = path.join(dir, `helper-${runs++}.pid`)
    const started = Date.now()

    return new Promise((resolve) => {
      const child = spawn(
        'git',
        ['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args],
        { cwd: opts.cwd ?? dir, env: { ...env, GIP_CHAOS_PID: pidFile } }
      )

      let stdout = ''
      let stderr = ''
      let killed = false
      let hung = false
      let pending = opts.kill || opts.on || null
      let killTimer = null

      const killHelper = () => {
        try {
          process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL')
          killed = true
        } catch {
          // The helper already exited: the kill point fell after the command.
        }
      }

      const hangTimer = setTimeout(() => {
        hung = true
        killHelper()
        child.kill('SIGKILL')
      }, HANG)

      child.stdout.on('data', (data) => (stdout += data))
      child.stderr.on('data', (data) => {
        stderr += data
        if (!pending || !stderr.includes(pending.marker)) return
        if (opts.on) opts.on.fn()
        else killTimer = setTimeout(killHelper, opts.kill.delay)
        pending = null
      })

      child.on('exit', (code, signal) => {
        clearTimeout(hangTimer)
        clearTimeout(killTimer)
        if (hung) killed = false
        resolve({ code, signal, stdout, stderr, killed, hung, ms: Date.now() - started })
      })
    })
  }

  async function ok(args, opts) {
    const result = await git(args, opts)
    if (result.code === 0) return result.stdout
    const how = result.hung ? `hung ${result.ms}ms` : `exit ${result.code}`
    throw new Error(`git ${args.join(' ')} failed (${how}): ${result.stderr}`)
  }

  async function repo(name) {
    const cwd = path.join(dir, name)
    fs.mkdirSync(cwd)
    await ok(['init', '-q'], { cwd })
    return cwd
  }

  // `files` incompressible blobs of `size` bytes in one commit.
  async function commit(cwd, message, rand, { files = 1, size = 64 } = {}) {
    for (let i = 0; i < files; i++) {
      const data = b4a.alloc(size)
      for (let j = 0; j < size; j++) data[j] = rand() * 256
      fs.writeFileSync(path.join(cwd, `${message}-${i}.bin`), data)
    }
    await ok(['add', '-A'], { cwd })
    await ok(['commit', '-qm', message], { cwd })
    return (await ok(['rev-parse', 'HEAD'], { cwd })).trim()
  }

  async function store(name) {
    const storage = path.join(dir, name)
    const db = new GipLocalDB({ dir: storage, bootstrap })
    await db.ready()
    const remote = await db.createRemote('t')
    const link = remote.url
    await db.close()
    return { storage, link, url: `${link}?storage=${storage}` }
  }

  // A reader's view of `link` through its own empty store.
  function peer(link, name) {
    return `${link}?storage=${path.join(dir, name)}`
  }

  // In-process peer on a non-firewalled node, so a helper in another process connects first try.
  async function seed(storage) {
    const db = new GipLocalDB({
      dir: storage,
      swarm: new Hyperswarm({ dht: testnet.createNode({ firewalled: false }) })
    })
    await db.ready()
    t.teardown(() => db.close())
    await db.openRemotes()
    return db
  }

  // In-process read-only peer that keeps looking the topic up and downloads all it can.
  // A pushing helper holds the store lock and only announces for as long as it runs, so this
  // is the one peer that can serve readers while a push is in flight.
  async function mirror(link) {
    const db = new GipLocalDB({
      dir: path.join(dir, 'mirror'),
      swarm: new Hyperswarm({ dht: testnet.createNode({ firewalled: false }) })
    })
    await db.ready()

    let looking = true
    t.teardown(() => {
      looking = false
      return db.close()
    })

    const remote = await db.openRemote(link)
    remote.core.download({ start: 0, end: -1 })

    const discovery = db.swarm.status(remote.discoveryKey)
    const look = async () => {
      while (looking) {
        await discovery.refresh({ server: true, client: true }).catch(() => {})
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    look()

    return remote
  }

  // refname → oid of the branches and tags in a local repo.
  async function localRefs(cwd) {
    const out = await ok(
      ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags'],
      { cwd }
    )
    const map = {}
    for (const line of out.trim().split('\n')) {
      const [ref, oid] = line.split(' ')
      map[ref] = oid
    }
    return map
  }

  function readOnly(storage, on) {
    return new Promise((resolve) => {
      spawn('chmod', ['-R', on ? 'a-w' : 'u+w', storage]).on('exit', resolve)
    })
  }

  // ref → oid as the helper lists them, symrefs and peeled tags left out.
  async function refs(url) {
    const out = await ok(['ls-remote', '--refs', url])
    const map = {}
    for (const line of out.split('\n')) {
      const [oid, ref] = line.split('\t')
      if (ref && ref !== 'HEAD') map[ref] = oid
    }
    return map
  }

  // Fresh clone, fsck'd: proves every listed ref has its full closure in the store.
  async function verify(url, name) {
    const dest = path.join(dir, name)
    await ok(['clone', '-q', url, dest])
    await ok(['fsck', '--strict', '--full'], { cwd: dest })
    return dest
  }

  return {
    dir,
    git,
    ok,
    repo,
    commit,
    store,
    peer,
    seed,
    mirror,
    localRefs,
    readOnly,
    refs,
    verify
  }
}

// The kill points a test runs: every marker once by default, GIP_CHAOS_ITERS random ones on
// top, or exactly the one in GIP_CHAOS_KILL='<marker>+<ms>'.
function killPoints(name, markers, maxDelay = 30) {
  if (process.env.GIP_CHAOS_KILL) {
    const [marker, delay] = process.env.GIP_CHAOS_KILL.split('+')
    return [{ marker, delay: Number(delay || 0), seed: SEED }]
  }

  const rand = random(`${name}-points`)
  const points = markers.map((marker) => ({ marker, delay: 0, seed: SEED }))
  for (let i = 0; i < ITERS; i++) {
    points.push({
      marker: markers[Math.floor(rand() * markers.length)],
      delay: Math.floor(rand() * maxDelay),
      seed: SEED
    })
  }
  return points
}

// mulberry32, seeded from GIP_CHAOS_SEED and a per-use name.
function random(name) {
  let a = SEED
  for (let i = 0; i < name.length; i++) a = (Math.imul(a, 31) + name.charCodeAt(i)) | 0

  return () => {
    a = (a + 0x6d2b79f5) | 0
    let x = Math.imul(a ^ (a >>> 15), 1 | a)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}
