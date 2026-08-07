const test = require('brittle')
const tmp = require('test-tmp')
const fs = require('fs')
const path = require('path')
const process = require('process')
const { spawnSync } = require('child_process')

const { GipLocalDB } = require('../lib/db')

const BIN = path.join(__dirname, '..', 'bin.js')

// End-to-end coverage of the push path: real git driving the remote helper
// against a store in a temp dir. Verifies negotiation (delta-only pushes),
// the streaming cat-file parser, thin-set indexing and clone integrity.

async function setup(t) {
  const dir = await tmp(t)

  // git resolves the transport by scheme from PATH — shim git-remote-git+pear
  // to this checkout's bin.js, run by the same runtime running the tests.
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  const shim = path.join(bin, 'git-remote-git+pear')
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`)
  fs.chmodSync(shim, 0o755)
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }

  const repo = path.join(dir, 'repo')
  fs.mkdirSync(repo)

  const git = (args, opts = {}) => {
    const result = spawnSync(
      'git',
      ['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args],
      { cwd: opts.cwd ?? repo, env, stdio: 'pipe' }
    )
    const stdout = result.output?.[1]?.toString() ?? ''
    const stderr = result.output?.[2]?.toString() ?? ''
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${stderr || stdout}`)
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

  // The store is single-process — open on demand, callers must be done
  // pushing before they look inside.
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

test('push and clone round-trip', async (t) => {
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

  // Object rows: (blob, tree, commit) per commit — 6 total. Any more means
  // re-sent duplicates got past dedup; any fewer means the thin set missed
  // something.
  const db = await ctx.openStore()
  await db.openRemotes()
  const remote = db.getRemote('t')
  const rows = []
  for await (const row of remote._db.find('@gip/objects')) rows.push(row)
  t.is(rows.length, 6)

  // The branch record must list the full reachable set even though the
  // second push only carried the delta.
  const objs = await remote.getRefObjects((await remote.getBranchRef('main')).oid)
  t.is(objs.length, 6)
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

  // Same tip, new name — the delta is empty, but the tip must still be
  // resolvable for indexing and the branch record must be complete.
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

  // An alphabetically-earlier branch would win the remote's first-push
  // head default — the local HEAD (main) must be mirrored instead.
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

  // Simulate a store written before head syncing existed. A fully
  // up-to-date push never reaches the helper (git short-circuits), so the
  // repair rides the next real push.
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

  // Deterministic, non-uniform bytes — big enough to span many stdout chunks
  // in the cat-file stream.
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
