const fs = require('fs')
const os = require('os')
const path = require('path')
const process = require('process')
const { spawn } = require('child_process')
const tmp = require('test-tmp')
const b4a = require('b4a')

const { GipLocalDB } = require('../../lib/db')

const BIN = path.join(__dirname, '..', '..', 'bin.js')
const TIMEOUT = Number(process.env.GIP_CORPUS_TIMEOUT_MIN || 30) * 60 * 1000
const MAX_RSS_MB = Number(process.env.GIP_CORPUS_MAX_RSS_MB || 300)
const REPORT =
  process.env.GIP_CORPUS_REPORT || path.join(os.tmpdir(), `gip-corpus-${Date.now()}.json`)

// The user's git config (signing, hooks, templates) must not leak into either side.
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIP_NO_UPDATES: '1'
}

const report = { started: new Date().toISOString(), git: null, scale: null, cases: [] }

function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    // Own process group, so a hung helper dies with the git that spawned it.
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? ENV,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const out = []
    const err = []
    let timedOut = false
    child.stdout.on('data', (data) => out.push(data))
    child.stderr.on('data', (data) => err.push(data))

    const timer = setTimeout(() => {
      timedOut = true
      process.kill(-child.pid, 'SIGKILL')
    }, TIMEOUT)

    child.on('error', reject)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({
        status: timedOut ? 'timeout' : (code ?? signal),
        stdout: b4a.toString(b4a.concat(out)),
        stderr: b4a.toString(b4a.concat(err)),
        ms: Date.now() - started
      })
    })
  })
}

async function git(args, opts) {
  const result = await exec('git', args, opts)
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`)
  }
  return result.stdout
}

function sh(script, args, opts) {
  return exec('sh', ['-c', script, 'sh', ...args], opts)
}

// Wall time, exit status and the peak RSS of the largest process in the tree
// (the helper for git+pear, pack-objects/index-pack for file).
async function measure(args, opts) {
  const flag = os.platform() === 'darwin' ? '-l' : '-v'
  const result = await exec('/usr/bin/time', [flag, 'git', ...args], opts)
  const bytes = result.stderr.match(/(\d+)\s+maximum resident set size/)
  const kbytes = result.stderr.match(/Maximum resident set size \(kbytes\): (\d+)/)
  const rss = bytes ? Number(bytes[1]) : kbytes ? Number(kbytes[1]) * 1024 : null

  return {
    status: result.status,
    ms: result.ms,
    rssMB: rss && Math.round(rss / 1024 / 1024),
    stdout: result.stdout,
    stderr: result.stderr.replace(/^\s+[\d.]+ real[\s\S]*$/m, '')
  }
}

function summary(step) {
  return { status: step.status, ms: step.ms, rssMB: step.rssMB }
}

async function setup(t) {
  const dir = await tmp(t)

  // git resolves the transport by scheme from PATH.
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  const shim = path.join(bin, 'git-remote-git+pear')
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`)
  fs.chmodSync(shim, 0o755)
  const env = { ...ENV, PATH: `${bin}:${process.env.PATH}` }

  const bare = path.join(dir, 'file.git')
  await git(['init', '-q', '--bare', bare])

  const store = path.join(dir, 'store')
  const db = new GipLocalDB({ dir: store })
  await db.ready()
  const { url } = await db.createRemote('t')
  await db.close()

  return {
    dir,
    env,
    remotes: {
      file: { url: `file://${bare}`, disk: bare },
      pear: { url: `${url}?storage=${store}`, disk: store }
    }
  }
}

function begin(name, why) {
  const entry = { name, why, status: 'running', diffs: [], file: {}, pear: {} }
  report.cases.push(entry)
  return entry
}

function finish(entry) {
  if (entry.status === 'running') entry.status = entry.diffs.length ? 'fail' : 'pass'
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2))
}

function differ(entry, what, file, pear, detail = '') {
  if (file === pear) return
  entry.diffs.push(`${what}: file=${brief(file)} pear=${brief(pear)}${detail && ' | ' + detail}`)
}

function brief(value) {
  const text = String(value)
  return text.length > 200 ? text.slice(0, 200) + '…' : text
}

// Order is not part of the contract: report the lines only one side has.
function differLines(entry, what, file, pear) {
  const a = new Set(file.split('\n').filter(Boolean))
  const b = new Set(pear.split('\n').filter(Boolean))
  const lines = [...a].filter((line) => !b.has(line)).map((line) => `- ${line}`)
  for (const line of b) if (!a.has(line)) lines.push(`+ ${line}`)
  if (lines.length === 0) return

  const shown = lines.slice(0, 12).join(' | ')
  entry.diffs.push(`${what} (- file only, + pear only, ${lines.length} lines): ${shown}`)
}

function tail(text) {
  return text.trim().split('\n').slice(-3).join(' / ')
}

// The helper mirrors the pusher's HEAD onto the remote. A bare remote keeps
// whatever it was created with, so give the baseline the same default branch.
async function adoptHead(ctx, src) {
  const head = (await git(['symbolic-ref', 'HEAD'], { cwd: src })).trim()
  await git(['symbolic-ref', 'HEAD', head], { cwd: ctx.remotes.file.disk })
}

async function pushAll(ctx, src, entry) {
  for (const kind of ['file', 'pear']) {
    for (const [key, flag] of [
      ['pushAll', '--all'],
      ['pushTags', '--tags']
    ]) {
      const step = await measure(['push', '-q', ctx.remotes[kind].url, flag], {
        cwd: src,
        env: ctx.env
      })
      entry[kind][key] = summary(step)
      if (step.status !== 0) entry[kind][key].stderr = tail(step.stderr)
    }
  }

  for (const key of ['pushAll', 'pushTags']) {
    differ(
      entry,
      `${key} exit`,
      entry.file[key].status,
      entry.pear[key].status,
      entry.pear[key].stderr
    )
  }
}

// One push per commit, oldest first: the cost of a push must not grow with history.
async function pushEach(ctx, src, entry) {
  const oids = (await git(['rev-list', '--reverse', 'main'], { cwd: src })).trim().split('\n')
  const every = Math.max(1, Math.floor(oids.length / 20))

  for (const kind of ['file', 'pear']) {
    const remote = ctx.remotes[kind]
    const times = []
    const series = []
    const failures = []

    for (let i = 0; i < oids.length; i++) {
      const step = await exec('git', ['push', '-q', remote.url, `${oids[i]}:refs/heads/main`], {
        cwd: src,
        env: ctx.env
      })
      if (step.status !== 0) {
        failures.push({ push: i + 1, status: step.status, stderr: tail(step.stderr) })
      }
      times.push(step.ms)
      if (i % every === 0 || i === oids.length - 1) {
        series.push({ push: i + 1, ms: step.ms, diskKB: await diskKB(remote.disk) })
      }
    }

    const sorted = times.slice().sort((a, b) => a - b)
    entry[kind].pushEach = {
      pushes: oids.length,
      failed: failures.length,
      failures: failures.slice(0, 20),
      totalMs: times.reduce((a, b) => a + b, 0),
      firstMs: times[0],
      medianMs: sorted[sorted.length >> 1],
      p95Ms: sorted[Math.floor(sorted.length * 0.95)],
      lastMs: times[times.length - 1],
      series
    }
  }

  differ(entry, 'failed pushes', entry.file.pushEach.failed, entry.pear.pushEach.failed)
}

// The oracle (plan §3): what git sees on, and gets back from, each remote.
async function verify(ctx, entry) {
  const seen = {}

  for (const kind of ['file', 'pear']) {
    const remote = ctx.remotes[kind]
    const m = entry[kind]
    const s = (seen[kind] = {})

    const ls = await exec('git', ['ls-remote', '--symref', remote.url], { env: ctx.env })
    const lines = ls.stdout.split('\n').filter(Boolean)
    m.lsRemote = { status: ls.status, ms: ls.ms, refs: lines.length }
    m.lsRemote.peeled = lines.filter((line) => line.endsWith('^{}')).length
    s.ls = lines.join('\n')

    // Never check out: fixture trees carry hostile paths, and checkout is not the transport.
    const clone = path.join(ctx.dir, `${kind}-clone`)
    const step = await measure(['clone', '-q', '--no-checkout', remote.url, clone], {
      env: ctx.env
    })
    m.clone = summary(step)
    if (step.status !== 0) m.clone.stderr = tail(step.stderr)

    if (step.status === 0) {
      const objects = path.join(ctx.dir, `${kind}-objects`)
      await sh('git -C "$1" rev-list --objects --all | cut -c1-40 | sort -u > "$2"', [
        clone,
        objects
      ])
      m.clone.objects = Number((await sh('wc -l < "$1"', [objects])).stdout)

      const refs = await exec('git', ['for-each-ref', '--format=%(refname) %(objectname)'], {
        cwd: clone
      })
      s.refs = refs.stdout

      const fsck = await sh(
        'git -C "$1" fsck --strict > "$2" 2>&1; code=$?; sort "$2"; exit $code',
        [clone, path.join(ctx.dir, `${kind}-fsck`)]
      )
      m.clone.fsck = fsck.status
      s.fsck = fsck.stdout
    }

    m.diskKB = await diskKB(remote.disk)
  }

  entry.file.objects = await looseAndPacked(ctx.remotes.file.disk)
  Object.assign(entry.pear, await storeCounts(ctx.remotes.pear.disk))
  entry.diskRatio = Number((entry.pear.diskKB / entry.file.diskKB).toFixed(2))

  // Memory must not grow with the repository: the helper streams in both directions.
  entry.maxRssMB = MAX_RSS_MB
  for (const step of ['pushAll', 'pushTags', 'clone']) {
    const rss = entry.pear[step]?.rssMB
    if (rss > MAX_RSS_MB) {
      entry.diffs.push(`peak RSS: ${step} took ${rss} MB, over the ${MAX_RSS_MB} MB bound`)
    }
  }

  differ(entry, 'ls-remote exit', entry.file.lsRemote.status, entry.pear.lsRemote.status)
  differLines(entry, 'ls-remote', seen.file.ls, seen.pear.ls)
  differ(
    entry,
    'clone exit',
    entry.file.clone.status,
    entry.pear.clone.status,
    entry.pear.clone.stderr
  )

  if (entry.file.clone.status !== 0 || entry.pear.clone.status !== 0) return

  differLines(entry, 'cloned refs', seen.file.refs, seen.pear.refs)
  // The exit code is a bit per place a fault was found in (1 loose object, 4 pack), and the two
  // clones need not store an object the same way. The faults themselves are compared below.
  differ(entry, 'fsck --strict passes', entry.file.clone.fsck === 0, entry.pear.clone.fsck === 0)
  differLines(entry, 'fsck --strict output', seen.file.fsck, seen.pear.fsck)

  const lists = [path.join(ctx.dir, 'file-objects'), path.join(ctx.dir, 'pear-objects')]
  if ((await sh('cmp -s "$1" "$2"', lists)).status === 0) return

  const diff = await sh('diff "$1" "$2" | grep "^[<>]" | head -8', lists)
  const lines = diff.stdout.trim().replace(/\n/g, ' | ')
  entry.diffs.push(
    `rev-list --objects --all (< file only, > pear only): file=${entry.file.clone.objects} pear=${entry.pear.clone.objects} objects | ${lines}`
  )
}

async function diskKB(dir) {
  return Number((await sh('du -sk "$1" | cut -f1', [dir])).stdout)
}

async function looseAndPacked(bare) {
  const out = await git(['count-objects', '-v'], { cwd: bare })
  const field = (name) => Number(out.match(new RegExp(`^${name}: (\\d+)`, 'm'))[1])
  return field('count') + field('in-pack')
}

// Single-process store: only safe once every helper has exited.
async function storeCounts(store) {
  const db = new GipLocalDB({ dir: store })
  await db.ready()
  try {
    await db.openRemotes()
    let objects = 0
    for await (const row of db.getRemote('t')._db.find('@gip/objects')) {
      if (row) objects++
    }
    const { core } = await db.getCore('t', { server: false, client: false })
    return { objects, coreLength: core.length }
  } finally {
    await db.close()
  }
}

module.exports = {
  REPORT,
  report,
  git,
  sh,
  setup,
  begin,
  finish,
  adoptHead,
  pushAll,
  pushEach,
  verify
}
