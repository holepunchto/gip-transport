const test = require('brittle')
const tmp = require('test-tmp')
const fs = require('fs')
const path = require('path')
const process = require('process')
const { spawn } = require('child_process')
const b4a = require('b4a')
const createTestnet = require('hyperdht/testnet')

const { GipLocalDB } = require('../../lib/db')

const BIN = path.join(__dirname, '..', '..', 'bin.js')
const DATE = '1700000000 +0000'
const CONCURRENCY = 16
const TIMEOUT = 60000

// Differential conformance: the same scenario runs against a bare file://
// remote (the oracle) and against git+pear:// (a local store), and every
// observation the two record must match. Dates are pinned so both sides
// build identical oids.
//
// Scenarios start when they are registered and run CONCURRENCY at a time; the
// brittle test only awaits and compares. Every helper bootstraps from one
// local testnet, which goes when the last scenario has been compared.
//
// { todo: 'the bug' } registers a brittle todo. GIP_TODO=1 runs those for
// real, to reproduce the bug.

module.exports = conform
conform.loud = loud

let testnet = null
let registered = 0

function conform(name, opts, fn) {
  if (typeof opts === 'function') return conform(name, {}, opts)
  if (opts.todo && !process.env.GIP_TODO) return test.todo(`${name} (bug: ${opts.todo})`)

  // { only: 'pear' } is for what has no file:// equivalent, such as speaking
  // the helper protocol directly: there is no oracle, check(t, pear) decides.
  const kinds = opts.only ? [opts.only] : ['pear', 'file']
  const job = slot(() => Promise.all(kinds.map((kind) => scenario(kind, opts, fn))))
  job.catch(() => {})

  registered++

  test(name, { timeout: 600000 }, async (t) => {
    t.teardown(async () => {
      if (--registered === 0) await (await testnet).destroy()
    })

    const check = opts.check ?? same
    check(t, ...(await job))
  })
}

function same(t, pear, file) {
  t.is(pear.length, file.length, 'same number of observations')
  for (let i = 0; i < file.length; i++) t.alike(pear[i]?.[1], file[i][1], file[i][0])
}

// For features we do not support: matching the oracle is fine, and so is the
// command failing. Succeeding with a different result is not.
function loud(t, pear, file) {
  const i = pear.findIndex(([label, value], i) => {
    return label.startsWith('git ') && value !== 0 && file[i][1] === 0
  })
  if (i === -1) return same(t, pear, file)
  t.pass(`unsupported, fails loudly: ${pear[i][0]}`)
}

async function scenario(kind, opts, fn) {
  const w = await world(kind, opts)
  try {
    await fn(w)
    if (opts.snapshot !== false) await w.snapshot()
  } catch (err) {
    // A scenario that cannot finish is itself an observation — one side
    // throwing where the other does not is a difference like any other.
    w.note('threw', err.message)
  } finally {
    await w.gc()
  }
  return w.log
}

async function world(kind, opts = {}) {
  if (!testnet) testnet = createTestnet(3)
  const { bootstrap } = await testnet

  const dir = await tmp()
  const repo = path.join(dir, 'repo')
  const log = []

  // git resolves the transport by scheme from PATH — shim git-remote-git+pear
  // to this checkout's bin.js, run by the same runtime running the tests.
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(
    path.join(bin, 'git-remote-git+pear'),
    `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`
  )
  fs.chmodSync(path.join(bin, 'git-remote-git+pear'), 0o755)

  fs.writeFileSync(
    path.join(dir, 'gitconfig'),
    '[user]\n\tname = t\n\temail = t@t.t\n' +
      '[init]\n\tdefaultBranch = main\n' +
      '[protocol "file"]\n\tallow = always\n' +
      '[advice]\n\tdetachedHead = false\n' +
      '[gc]\n\tauto = 0\n'
  )

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_DATE: DATE,
    GIT_COMMITTER_DATE: DATE,
    GIP_NO_UPDATES: '1',
    GIP_BOOTSTRAP: bootstrap.map((node) => `${node.host}:${node.port}`).join(','),
    ...opts.env
  }

  const git = (args, o = {}) => {
    return exec('git', args, { cwd: o.cwd ?? repo, env: { ...env, ...o.env }, input: o.input })
  }

  const w = {
    kind,
    pear: kind === 'pear',
    dir,
    repo,
    env,
    log,
    url: null,
    urls: [],
    git,

    // The helper itself, spoken to directly over the remote-helper protocol.
    helper(input, o = {}) {
      const cwd = o.cwd ?? repo
      return exec(process.execPath, [BIN, 'origin', w.url], {
        cwd,
        env: { ...env, GIT_DIR: path.join(cwd, '.git') },
        input,
        timeout: o.timeout
      })
    },

    // Local setup: must succeed, returns trimmed stdout.
    async ok(args, o) {
      const result = await git(args, o)
      if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
      return result.stdout.trim()
    },

    // The command under test: its exit status is an observation.
    async run(args, o) {
      const result = await git(args, o)
      w.note(`git ${args.join(' ')}`, result.status)
      return result
    },

    note(label, value) {
      log.push([neutral(label), value])
    },

    write(name, content, cwd = repo) {
      fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true })
      fs.writeFileSync(path.join(cwd, name), content)
    },

    async commit(name, o) {
      w.write(`${name}.txt`, `${name}\n`, o?.cwd)
      await w.ok(['add', '-A'], o)
      await w.ok(['commit', '-qm', name], o)
      return w.ok(['rev-parse', 'HEAD'], o)
    },

    // Every branch and tag, in one helper session.
    publish() {
      return w.run(['push', w.url, 'refs/heads/*:refs/heads/*', 'refs/tags/*:refs/tags/*'])
    },

    // main (two commits), side, an annotated and a lightweight tag — pushed.
    async seed() {
      await w.commit('one')
      await w.ok(['tag', 'light'])
      await w.commit('two')
      await w.ok(['tag', '-a', 'v1', '-m', 'v1'])
      await w.ok(['branch', 'side', 'HEAD~1'])
      await w.publish()
    },

    async clone(name = 'local', args = []) {
      const dest = path.join(dir, name)
      await w.run(['clone', '-q', ...args, w.url, dest])
      return dest
    },

    // A second remote next to the first.
    async second() {
      if (kind === 'file') {
        await w.ok(['init', '-q', '--bare', path.join(dir, 'second')])
        w.urls.push(`file://${dir}/second`)
      } else {
        w.urls.push(await create(path.join(dir, 'store'), 'second', bootstrap))
      }
      return w.urls[1]
    },

    // What a local repo ended up with after talking to the remote. `except`
    // leaves refs out of the comparison — an allowlist, so say why at the
    // call site.
    async inspect(cwd, { label = path.basename(cwd), except } = {}) {
      if (!fs.existsSync(cwd)) return w.note(`${label}: exists`, false)

      const out = async (args) => (await git(args, { cwd })).stdout.trim()
      const fetchHead = path.join(await out(['rev-parse', '--absolute-git-dir']), 'FETCH_HEAD')
      const head = (await out(['symbolic-ref', '-q', 'HEAD'])) || (await out(['rev-parse', 'HEAD']))
      const refs = await out(['for-each-ref', '--format=%(refname) %(objectname)'])
      const config = await out([
        'config',
        '--get-regexp',
        '^remote\\..*\\.(fetch|mirror|tagopt|promisor|partialclonefilter)$'
      ])

      w.note(
        `${label}: refs`,
        lines(refs).filter((ref) => !except?.test(ref))
      )
      w.note(`${label}: HEAD`, head)
      w.note(`${label}: remote config`, lines(config))
      w.note(`${label}: bare`, await out(['rev-parse', '--is-bare-repository']))
      w.note(`${label}: shallow`, await out(['rev-parse', '--is-shallow-repository']))
      w.note(
        `${label}: FETCH_HEAD`,
        fs.existsSync(fetchHead) ? lines(neutral(fs.readFileSync(fetchHead, 'utf8'))) : null
      )
      w.note(`${label}: fsck`, (await git(['fsck', '--strict'], { cwd })).status)
    },

    // The remote as everyone else sees it: its refs, and a fresh clone.
    async snapshot() {
      // Allowlisted: peeled tags (`refs/tags/v1^{}`) are not advertised.
      // protocol.js holds the one test for that; here it would only make
      // every scenario with an annotated tag fail for the same reason.
      const ls = await git(['ls-remote', '--symref', w.url], { cwd: dir })
      const refs = lines(ls.stdout).filter((line) => !line.endsWith('^{}'))
      w.note('ls-remote', { status: ls.status, refs })

      const dest = path.join(dir, 'snapshot')
      const clone = await git(['clone', '-q', w.url, dest], { cwd: dir })
      w.note('fresh clone', clone.status)
      if (clone.status !== 0) return

      const objects = await git(['rev-list', '--objects', '--all'], { cwd: dest })
      w.note('fresh clone objects', lines(objects.stdout))
      w.note('fresh clone fsck', (await git(['fsck', '--strict'], { cwd: dest })).status)
    },

    // A helper that hangs outlives the git that started it, and holds this
    // process open through the pipes it inherited.
    async gc() {
      await exec('pkill', ['-f', dir])
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  }

  await w.ok(['init', '-q', repo], { cwd: dir })

  if (kind === 'file') {
    await w.ok(['init', '-q', '--bare', path.join(dir, 'remote')], { cwd: dir })
    w.url = `file://${dir}/remote`
  } else {
    w.url = await create(path.join(dir, 'store'), 't', bootstrap)
  }
  w.urls.push(w.url)

  return w

  function neutral(s) {
    w.urls.forEach((url, i) => {
      s = s.split(url).join(i ? `<url ${i + 1}>` : '<url>')
    })
    return s.split(dir).join('<dir>')
  }
}

async function create(store, name, bootstrap) {
  const db = new GipLocalDB({ dir: store, bootstrap })
  await db.ready()
  const { url } = await db.createRemote(name)
  await db.close()
  return `${url}?storage=${store}`
}

function lines(s) {
  return s.split('\n').filter(Boolean).sort()
}

function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    })

    const timer = setTimeout(() => child.kill(), opts.timeout ?? TIMEOUT)
    const stdout = []
    const stderr = []
    child.stdout.on('data', (data) => stdout.push(data))
    child.stderr.on('data', (data) => stderr.push(data))
    child.on('error', reject)
    child.on('exit', (status, signal) => {
      clearTimeout(timer)
      resolve({
        status: status ?? signal,
        stdout: b4a.toString(b4a.concat(stdout)),
        stderr: b4a.toString(b4a.concat(stderr))
      })
    })

    if (opts.input !== undefined) child.stdin.end(opts.input)
  })
}

let active = 0
const waiting = []

async function slot(fn) {
  if (active === CONCURRENCY) await new Promise((resolve) => waiting.push(resolve))
  else active++
  try {
    return await fn()
  } finally {
    if (waiting.length) waiting.shift()()
    else active--
  }
}
