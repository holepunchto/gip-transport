const test = require('brittle')
const tmp = require('test-tmp')
const fs = require('fs')
const path = require('path')
const process = require('process')
const { spawnSync } = require('child_process')
const { isWindows } = require('which-runtime')

const { GipLocalDB } = require('../lib/db')

const BIN = path.join(__dirname, '..', 'bin.js')
// Bounds one helper process so a hang reports instead of wedging the job. Must fire before
// brittle's per-test timeout, or brittle reports first and the diagnostics are lost.
const HELPER_TIMEOUT = 25000
const TEST_TIMEOUT = 120000

async function setup(t) {
  t.timeout(TEST_TIMEOUT)
  const dir = await tmp(t)

  // git resolves the transport by scheme from PATH.
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  const shim = path.join(bin, 'git-remote-git+pear')

  if (isWindows) {
    // git only probes `<cmd>.exe` and the bare name, never `.cmd` or `.bat`, so the shim
    // stays extensionless. git then reads the shebang, but keeps only the basename after
    // the last separator and resolves that on PATH, so the leading `/` is just the marker
    // it needs to accept the line. Naming the runtime rather than spelling out its path
    // also dodges git reading only the first 100 bytes of the file.
    const runtime = path.basename(process.execPath)
    // Globals only in here: the shim sits in a tmp dir, so bare can resolve no packages
    // from it, and `process` is not a global under bare the way `Bare` is not under node.
    const watchdog =
      `setTimeout(() => {\n` +
      `  console.error('gip test shim: helper still alive after ${HELPER_TIMEOUT}ms, forcing exit')\n` +
      `  ;(typeof Bare === 'undefined' ? process : Bare).exit(70)\n` +
      `}, ${HELPER_TIMEOUT})\n`
    fs.writeFileSync(shim, `#!/${runtime}\n${watchdog}require(${JSON.stringify(BIN)})\n`)
  } else {
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`)
    fs.chmodSync(shim, 0o755)
  }

  // Windows names the variable `Path`, so spreading process.env and adding `PATH` leaves
  // both keys set and the child may resolve the one without the shim dir. Its separator
  // is `;` too, and a `:` would have glued the shim dir onto the next entry. The runtime
  // dir has to be on there as well: under bare it lives in node_modules, off PATH, and
  // git resolves the shebang interpreter by name.
  const runtimeDir = path.dirname(process.execPath)
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() !== 'path') env[key] = value
  }
  env.PATH = [bin, runtimeDir, process.env.PATH].join(path.delimiter)
  // The helper otherwise checks for updates over the public DHT, which this round-trip
  // never exercises and which leaves a swarm to tear down before it can exit.
  env.GIP_NO_UPDATES = '1'
  // Three views of the same exchange: the helper's step trace and heartbeat, its own debug
  // log, and git's record of what it sent. To files, because a hang loses piped stderr.
  const helperTrace = path.join(dir, 'helper-trace.log')
  const gitTrace = path.join(dir, 'git-trace.log')
  env.GIP_TRACE = helperTrace
  env.GIP_VERBOSITY = '3'
  env.GIT_TRACE = gitTrace.replace(/\\/g, '/')
  env.GIT_TRANSPORT_HELPER_DEBUG = '1'

  const read = (file) => {
    try {
      return fs.readFileSync(file, 'utf8').trimEnd() || '(empty)'
    } catch {
      return '(not created)'
    }
  }

  const repo = path.join(dir, 'repo')
  fs.mkdirSync(repo)

  const git = (args, opts = {}) => {
    for (const file of [helperTrace, gitTrace]) {
      try {
        fs.appendFileSync(file, `\n===== git ${args.join(' ')} =====\n`)
      } catch {}
    }

    const result = spawnSync(
      'git',
      [
        '-c',
        'user.email=t@t.t',
        '-c',
        'user.name=t',
        '-c',
        'init.defaultBranch=main',
        // Git for Windows defaults core.autocrlf to true, which rewrites LF to CRLF on
        // checkout and makes a byte-for-byte round-trip assertion fail there only.
        '-c',
        'core.autocrlf=false',
        ...args
      ],
      { cwd: opts.cwd ?? repo, env, stdio: 'pipe' }
    )
    const stdout = result.output?.[1]?.toString() ?? ''
    const stderr = result.output?.[2]?.toString() ?? ''
    if (result.status !== 0 || result.error) {
      throw new Error(
        [
          `git ${args[0]} failed: status=${result.status} signal=${result.signal ?? 'none'}` +
            (result.error ? ` error=${result.error.message}` : ''),
          `--- git stderr ---\n${stderr.trimEnd() || '(empty)'}`,
          `--- helper trace ---\n${read(helperTrace)}`,
          `--- git trace ---\n${read(gitTrace)}`
        ].join('\n')
      )
    }
    return stdout + stderr
  }

  const write = (name, content) => {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true })
    fs.writeFileSync(path.join(repo, name), content)
  }

  git(['init', '-q'])
  write('a.txt', 'hello\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'one'])

  const store = path.join(dir, 'store')
  let db = new GipLocalDB({ dir: store })
  await db.ready()
  const remote = await db.createRemote('t')
  const url = `${remote.url}?storage=${store}`
  await db.close()

  // Single-process store — callers must finish pushing before they look inside.
  const openStore = async () => {
    db = new GipLocalDB({ dir: store })
    await db.ready()
    t.teardown(() => db.close())
    return db
  }

  return { dir, repo, url, git, write, openStore }
}

function cloneAndLog(ctx, name, ref) {
  const dest = path.join(ctx.dir, name)
  const args = ['clone', '-q']
  if (ref) args.push('--branch', ref)
  ctx.git([...args, ctx.url, dest])
  return ctx.git(['log', '--oneline', '--format=%s'], { cwd: dest }).trim().split('\n')
}

test.solo('push and clone round-trip', async (t) => {
  const ctx = await setup(t)
  ctx.git(['push', ctx.url, '--all'])

  const log = cloneAndLog(ctx, 'clone')
  t.alike(log, ['one'])

  const cloned = fs.readFileSync(path.join(ctx.dir, 'clone', 'a.txt'), 'utf8')
  t.is(cloned, 'hello\n')

  ctx.git(['fsck', '--strict'], { cwd: path.join(ctx.dir, 'clone') })
  t.pass('fsck clean')
})

test('incremental push carries the delta and clones stay complete', async (t) => {
  const ctx = await setup(t)
  ctx.git(['push', ctx.url, '--all'])

  ctx.write('b.txt', 'second\n')
  ctx.git(['add', '-A'])
  ctx.git(['commit', '-qm', 'two'])
  ctx.git(['push', ctx.url, '--all'])

  const log = cloneAndLog(ctx, 'clone')
  t.alike(log, ['two', 'one'])

  const db = await ctx.openStore()
  await db.openRemotes()
  const remote = db.getRemote('t')
  const rows = []
  for await (const row of remote._db.find('@gip/objects')) rows.push(row)
  t.is(rows.length, 6, '(blob, tree, commit) per commit, no duplicates and nothing missing')

  const objs = await remote.getRefObjects((await remote.getBranchRef('main')).oid)
  t.is(objs.length, 6, 'branch record lists the full reachable set, not just the delta')
})

test('no-op push leaves the core untouched', async (t) => {
  const ctx = await setup(t)
  ctx.git(['push', ctx.url, '--all'])

  let db = await ctx.openStore()
  const before = (await db.getCore('t', { server: false, client: false })).core.length
  await db.close()

  const out = ctx.git(['push', ctx.url, '--all'])
  t.ok(out.includes('Everything up-to-date'), 'git sees it as up to date')

  db = await ctx.openStore()
  const after = (await db.getCore('t', { server: false, client: false })).core.length
  t.is(after, before)
})

test('new branch at an existing commit', async (t) => {
  const ctx = await setup(t)
  ctx.git(['push', ctx.url, '--all'])

  // Same tip, new name: the delta is empty but the tip must still resolve for indexing.
  ctx.git(['branch', 'other'])
  ctx.git(['push', ctx.url, '--all'])

  const log = cloneAndLog(ctx, 'clone', 'other')
  t.alike(log, ['one'])

  const db = await ctx.openStore()
  await db.openRemotes()
  const remote = db.getRemote('t')
  const ref = await remote.getBranchRef('other')
  t.ok(ref)
  t.is((await remote.getRefObjects(ref.oid)).length, 3)
})

test('head follows the local HEAD, not the first branch pushed', async (t) => {
  const ctx = await setup(t)

  // An alphabetically-earlier branch would win the remote's first-push head default.
  ctx.git(['branch', 'aaa-feature'])
  ctx.git(['push', ctx.url, '--all'])

  const dest = path.join(ctx.dir, 'clone')
  ctx.git(['clone', '-q', ctx.url, dest])
  t.is(ctx.git(['symbolic-ref', 'HEAD'], { cwd: dest }).trim(), 'refs/heads/main')

  const db = await ctx.openStore()
  await db.openRemotes()
  t.is(await db.getRemote('t').getHead(), 'main')
})

test('a push repairs a wrong head', async (t) => {
  const ctx = await setup(t)
  ctx.git(['branch', 'aaa-feature'])
  ctx.git(['push', ctx.url, '--all'])

  // git short-circuits an up-to-date push, so the repair has to ride the next real one.
  let db = await ctx.openStore()
  await db.openRemotes()
  await db.getRemote('t').setHead('aaa-feature')
  await db.close()

  ctx.write('b.txt', 'more\n')
  ctx.git(['add', '-A'])
  ctx.git(['commit', '-qm', 'two'])
  ctx.git(['push', ctx.url, '--all'])

  db = await ctx.openStore()
  await db.openRemotes()
  t.is(await db.getRemote('t').getHead(), 'main')
})

test('annotated tag pushes after the branch', async (t) => {
  const ctx = await setup(t)
  ctx.git(['push', ctx.url, '--all'])

  // Everything the tag reaches is a have — only the tag object itself goes.
  ctx.git(['tag', '-a', 'v1', '-m', 'release'])
  ctx.git(['push', ctx.url, '--tags'])

  const dest = path.join(ctx.dir, 'clone')
  ctx.git(['clone', '-q', ctx.url, dest])
  t.is(ctx.git(['tag'], { cwd: dest }).trim(), 'v1')
})

test('multi-megabyte payloads stream through the parser intact', async (t) => {
  const ctx = await setup(t)

  // Deterministic, non-uniform, and big enough to span many cat-file stdout chunks.
  const big = Buffer.allocUnsafe(3 * 1024 * 1024)
  for (let i = 0; i < big.byteLength; i++) big[i] = (i * 31 + 7) % 251
  fs.writeFileSync(path.join(ctx.repo, 'big.bin'), big)
  ctx.git(['add', '-A'])
  ctx.git(['commit', '-qm', 'big'])

  ctx.git(['push', ctx.url, '--all'])

  cloneAndLog(ctx, 'clone')
  const cloned = fs.readFileSync(path.join(ctx.dir, 'clone', 'big.bin'))
  t.is(Buffer.compare(cloned, big), 0)
})
