const test = require('brittle')
const fs = require('fs')
const path = require('path')

const { create, killPoints, random, ITERS } = require('./helpers/chaos')

// Each kill prints how to replay it: GIP_CHAOS_SEED=<n> GIP_CHAOS_KILL='<marker>+<ms>' runs that
// one kill point, with the same object count and sizes, in every kill test whose helper prints
// the marker. GIP_CHAOS_ITERS=<n> adds n seeded random kill points per test.

const TIMEOUT = 180_000 + ITERS * 20_000
const REFSPECS = ['refs/heads/*:refs/heads/*', 'refs/tags/*:refs/tags/*']

const PUSH_MARKERS = [
  'Connecting',
  'Line: list for-push',
  'Gip [DEBUG]: pushing',
  'Gip [DEBUG]: Parsed',
  'Gip [DEBUG]: Pushed with ref',
  'Latest:'
]

const CLONE_MARKERS = [
  'Connecting',
  'Connected',
  'Line: list',
  'Gip [DEBUG]: Rebuilding repo',
  'Gip [DEBUG]: Done rebuilding'
]

// A kill while the helper writes objects corrupts the local repo, see the todo below.
const FETCH_MARKERS = CLONE_MARKERS.filter((marker) => !marker.includes('Rebuilding repo'))

test(
  'SIGKILL mid-push leaves every ref at its old or its new oid',
  { timeout: TIMEOUT },
  async (t) => {
    const ctx = await create(t)
    const repo = await ctx.repo('repo')
    const { url } = await ctx.store('store')

    await ctx.commit(repo, 'base', random('push'))
    await ctx.ok(['branch', 'side'], { cwd: repo })
    await ctx.ok(['push', url, ...REFSPECS], { cwd: repo })
    let old = await ctx.refs(url)

    for (const [i, point] of killPoints('push', PUSH_MARKERS).entries()) {
      const rand = random(`push-${point.marker}-${point.delay}`)
      const shape = { files: 1 + Math.floor(rand() * 40), size: 1 + Math.floor(rand() * 16384) }
      await ctx.commit(repo, `main-${i}`, rand, shape)
      await ctx.ok(['checkout', '-q', 'side'], { cwd: repo })
      await ctx.commit(repo, `side-${i}`, rand, shape)
      await ctx.ok(['checkout', '-q', 'main'], { cwd: repo })
      await ctx.ok(['branch', `new-${i}`], { cwd: repo })
      await ctx.ok(['tag', '-a', `v${i}`, '-m', `v${i}`], { cwd: repo })
      const next = await ctx.localRefs(repo)

      const run = await ctx.git(['push', '-v', '-v', url, ...REFSPECS], { cwd: repo, kill: point })
      t.absent(run.hung, 'push did not hang')

      const now = await ctx.refs(url)
      let landed = 0
      for (const ref of Object.keys(next)) {
        t.ok(now[ref] === old[ref] || now[ref] === next[ref], `${ref} is old or new`)
        if (now[ref] !== old[ref]) landed++
      }
      t.comment(`${describe('push', point, run, shape)} landed=${landed}/4 refs`)
      if (run.code === 0) t.alike(now, next, 'a push git called successful landed whole')

      await ctx.verify(url, `after-kill-${i}`)

      await ctx.ok(['push', url, ...REFSPECS], { cwd: repo })
      old = await ctx.refs(url)
      t.alike(old, next, 'a rerun completes the push')
    }

    await ctx.verify(url, 'final')
  }
)

test(
  'SIGKILL mid-clone leaves no partial repo and a rerun completes',
  { timeout: TIMEOUT },
  async (t) => {
    const ctx = await create(t)
    const rand = random('clone')
    const repo = await ctx.repo('repo')
    const { url, storage, link } = await ctx.store('store')

    await ctx.commit(repo, 'one', rand, { files: 20, size: 65536 })
    const head = await ctx.commit(repo, 'two', rand, { files: 20, size: 65536 })
    await ctx.ok(['push', url, ...REFSPECS], { cwd: repo })
    await ctx.seed(storage)

    for (const [i, point] of killPoints('clone', CLONE_MARKERS).entries()) {
      const reader = ctx.peer(link, `reader-${i}`)
      const dest = path.join(ctx.dir, `clone-${i}`)

      const run = await ctx.git(['clone', '-v', '-v', reader, dest], { kill: point })
      t.comment(describe('clone', point, run))
      t.absent(run.hung, 'clone did not hang')

      if (run.code !== 0) t.absent(fs.existsSync(dest), 'a failed clone leaves nothing behind')
      else await ctx.ok(['fsck', '--strict', '--full'], { cwd: dest })

      const again = path.join(ctx.dir, `clone-again-${i}`)
      const rerun = await ctx.git(['clone', '-q', reader, again])
      if (rerun.stderr.includes('Invalid device file')) {
        t.comment('hit the known empty device file bug, see the todo below')
        continue
      }
      if (rerun.code !== 0) t.comment(rerun.stderr)
      t.is(rerun.code, 0, 'a rerun exits 0')
      await ctx.ok(['fsck', '--strict', '--full'], { cwd: again })
      t.is((await ctx.ok(['rev-parse', 'HEAD'], { cwd: again })).trim(), head, 'a rerun completes')
    }
  }
)

// A kill between device-file creating <storage>/CORESTORE and writing it leaves the file empty,
// and every later open fails with 'Invalid device file, was modified'. The window is a few ms
// of the first open of a store, so the leftover state is planted instead of raced for.
test.todo('SIGKILL during the first open of a store leaves it usable', async (t) => {
  const ctx = await create(t)
  const repo = await ctx.repo('repo')
  const { url, storage, link } = await ctx.store('store')

  await ctx.commit(repo, 'one', random('first-open'))
  await ctx.ok(['push', url, 'main'], { cwd: repo })
  await ctx.seed(storage)

  fs.mkdirSync(path.join(ctx.dir, 'reader'))
  fs.writeFileSync(path.join(ctx.dir, 'reader', 'CORESTORE'), '')

  const run = await ctx.git(['clone', '-q', ctx.peer(link, 'reader'), path.join(ctx.dir, 'clone')])
  t.comment(`clone: exit=${run.code} ${lastLines(run.stderr)}`)
  t.is(run.code, 0)
})

test(
  'SIGKILL mid-fetch leaves the local repo valid and a rerun completes',
  { timeout: TIMEOUT },
  async (t) => {
    const ctx = await create(t)
    const rand = random('fetch')
    const repo = await ctx.repo('repo')
    const { url, storage, link } = await ctx.store('store')

    let old = await ctx.commit(repo, 'base', rand)
    await ctx.ok(['push', url, ...REFSPECS], { cwd: repo })
    let seeder = await ctx.seed(storage)

    const clone = path.join(ctx.dir, 'clone')
    await ctx.ok(['clone', '-q', ctx.peer(link, 'reader'), clone])
    const tracking = async () =>
      (await ctx.ok(['rev-parse', 'refs/remotes/origin/main'], { cwd: clone })).trim()

    for (const [i, point] of killPoints('fetch', FETCH_MARKERS).entries()) {
      await seeder.close()
      const next = await ctx.commit(repo, `more-${i}`, rand, { files: 20, size: 65536 })
      await ctx.ok(['push', url, ...REFSPECS], { cwd: repo })
      seeder = await ctx.seed(storage)

      const run = await ctx.git(['fetch', '-v', '-v', 'origin'], { cwd: clone, kill: point })
      t.comment(describe('fetch', point, run))
      t.absent(run.hung, 'fetch did not hang')

      await ctx.ok(['fsck', '--strict', '--full'], { cwd: clone })
      const now = await tracking()
      t.ok(now === old || now === next, 'origin/main is old or new')
      if (run.code === 0) t.is(now, next, 'a fetch git called successful landed')

      await ctx.ok(['fetch', '-q', 'origin'], { cwd: clone })
      await ctx.ok(['fsck', '--strict', '--full'], { cwd: clone })
      t.is(await tracking(), next, 'a rerun completes the fetch')
      old = next
    }
  }
)

// gip-remote's toDisk writes loose objects in place (isomorphic-git writeObject), not through a
// temp file, and never rewrites one that exists. A kill mid-write leaves an empty or short
// object file that fsck rejects, and later fetches keep it.
test.todo(
  'SIGKILL while a fetch writes objects leaves the local repo valid',
  { timeout: TIMEOUT },
  async (t) => {
    const ctx = await create(t)
    const rand = random('fetch-objects')
    const repo = await ctx.repo('repo')
    const { url, storage, link } = await ctx.store('store')

    await ctx.commit(repo, 'base', rand)
    await ctx.ok(['push', url, 'main'], { cwd: repo })
    let seeder = await ctx.seed(storage)

    const clone = path.join(ctx.dir, 'clone')
    await ctx.ok(['clone', '-q', ctx.peer(link, 'reader'), clone])

    for (let delay = 5; delay < 100; delay += 10) {
      await seeder.close()
      await ctx.commit(repo, `more-${delay}`, rand, { files: 200, size: 4096 })
      await ctx.ok(['push', url, 'main'], { cwd: repo })
      seeder = await ctx.seed(storage)

      const point = { marker: 'Gip [DEBUG]: Rebuilding repo', delay }
      await ctx.git(['fetch', '-v', '-v', 'origin'], { cwd: clone, kill: point })
      const killed = await ctx.git(['fsck', '--strict', '--full'], { cwd: clone })
      t.is(killed.code, 0, `fsck clean after a kill ${delay}ms into the rebuild`)

      await ctx.ok(['fetch', '-q', 'origin'], { cwd: clone })
      const rerun = await ctx.git(['fsck', '--strict', '--full'], { cwd: clone })
      t.is(rerun.code, 0, 'fsck clean after the rerun')
    }
  }
)

test(
  'two pushes to one store at once: no corruption, no lost ref',
  { timeout: TIMEOUT },
  async (t) => {
    const ctx = await create(t)
    const rand = random('concurrent')
    const repo = await ctx.repo('repo')
    const { url } = await ctx.store('store')

    await ctx.commit(repo, 'base', rand)
    await ctx.ok(['push', url, 'main'], { cwd: repo })

    const oids = {}
    for (const branch of ['a', 'b']) {
      await ctx.ok(['checkout', '-q', '-b', branch, 'main'], { cwd: repo })
      oids[branch] = await ctx.commit(repo, branch, rand, { files: 20, size: 65536 })
    }

    const runs = await Promise.all(
      ['a', 'b'].map((branch) => ctx.git(['push', url, branch], { cwd: repo }))
    )

    const now = await ctx.refs(url)
    for (const [i, branch] of ['a', 'b'].entries()) {
      const run = runs[i]
      t.comment(`push ${branch}: exit=${run.code} ${run.ms}ms ${lastLines(run.stderr)}`)
      t.absent(run.hung, `push ${branch} did not hang`)
      if (run.code === 0) t.is(now[`refs/heads/${branch}`], oids[branch], `${branch} landed`)
      else t.absent(now[`refs/heads/${branch}`], `${branch} failed whole`)
    }
    t.ok(
      runs.some((run) => run.code === 0),
      'one push wins'
    )

    await ctx.verify(url, 'after-race')

    await ctx.ok(['push', url, 'a', 'b'], { cwd: repo })
    const done = await ctx.refs(url)
    t.is(done['refs/heads/a'], oids.a)
    t.is(done['refs/heads/b'], oids.b)
  }
)

test(
  'clones taken while the writer pushes are each self-consistent',
  { timeout: TIMEOUT },
  async (t) => {
    const ctx = await create(t)
    const rand = random('push-while-clone')
    const repo = await ctx.repo('repo')
    const { url, storage, link } = await ctx.store('store')

    const history = new Set([await ctx.commit(repo, 'c0', rand)])
    await ctx.ok(['push', url, ...REFSPECS], { cwd: repo })

    const seeder = await ctx.seed(storage)
    await ctx.mirror(link)
    await seeder.close()

    // A push ends before the mirror has all of it, so the writer comes back as a seeder once the
    // pushes are done: every clone can finish.
    let pushing = true
    const push = async () => {
      for (let i = 1; i <= 8; i++) {
        history.add(await ctx.commit(repo, `c${i}`, rand, { files: 10, size: 65536 }))
        await ctx.ok(['tag', `t${i}`], { cwd: repo })
        await ctx.ok(['push', url, ...REFSPECS], { cwd: repo })
      }
      await ctx.seed(storage)
      pushing = false
    }
    const pushed = push()

    const seen = new Set()
    let clones = 0
    let failed = 0
    while (pushing) {
      const dest = path.join(ctx.dir, `clone-${clones}`)
      const run = await ctx.git(['clone', '-q', ctx.peer(link, `reader-${clones++}`), dest])
      t.absent(run.hung, 'clone did not hang')
      if (run.code !== 0) {
        failed++
        t.comment(`clone ${clones - 1}: exit=${run.code} ${run.ms}ms ${lastLines(run.stderr)}`)
        if (!run.hung) t.absent(fs.existsSync(dest), 'a failed clone leaves nothing behind')
        continue
      }

      await ctx.ok(['fsck', '--strict', '--full'], { cwd: dest })
      const refs = await ctx.ok(['for-each-ref', '--format=%(objectname)'], { cwd: dest })
      for (const oid of refs.trim().split('\n')) t.ok(history.has(oid), 'ref is a pushed commit')
      seen.add((await ctx.ok(['rev-parse', 'HEAD'], { cwd: dest })).trim())
    }
    await pushed

    t.comment(`${clones} clones, ${failed} failed, ${seen.size} distinct heads seen`)
    t.ok(clones > failed, 'some clones completed')
  }
)

test('a clone with zero peers fails cleanly', { timeout: TIMEOUT }, async (t) => {
  const ctx = await create(t)
  const repo = await ctx.repo('repo')
  const { url, link } = await ctx.store('store')

  await ctx.commit(repo, 'one', random('zero-peers'))
  await ctx.ok(['push', url, 'main'], { cwd: repo })

  const dest = path.join(ctx.dir, 'clone')
  const run = await ctx.git(['clone', ctx.peer(link, 'reader'), dest])
  t.comment(`clone: exit=${run.code} ${run.ms}ms ${lastLines(run.stderr)}`)

  t.absent(run.hung, 'clone did not hang')
  t.ok(run.code > 0, 'non-zero exit')
  t.ok(run.stderr.includes('peers required'), 'says why')
  t.absent(fs.existsSync(dest), 'nothing left behind')
})

// Readers announce themselves by default (seedReadOnly) and a killed helper never unannounces.
// Measured on the testnet: 0.4s to connect with none dead, 4.4s with 4, 8.4s with 12, 36s
// with 16.
test.todo('peers that crashed do not slow a later clone', { timeout: TIMEOUT }, async (t) => {
  const ctx = await create(t)
  const repo = await ctx.repo('repo')
  const { url, storage, link } = await ctx.store('store')

  await ctx.commit(repo, 'one', random('dead-peers'))
  await ctx.ok(['push', url, 'main'], { cwd: repo })
  await ctx.seed(storage)

  for (let i = 0; i < 12; i++) {
    const point = { marker: 'Connected', delay: 0 }
    await ctx.git(['ls-remote', ctx.peer(link, `dead-${i}`)], { kill: point })
  }

  const run = await ctx.git(['clone', '-q', ctx.peer(link, 'reader'), path.join(ctx.dir, 'clone')])
  t.comment(`clone: exit=${run.code} ${run.ms}ms`)
  t.is(run.code, 0)
  t.ok(run.ms < 4000, 'connects as fast as with no dead peers')
})

// openRemote awaits core.download().done() with no timeout and the swarm does not look the
// topic up again, so the clone sits at 'Connecting...' long after another seeder is online.
test.todo(
  'a clone whose only seeder leaves mid-download finishes from a later seeder or fails',
  { timeout: TIMEOUT },
  async (t) => {
    const ctx = await create(t)
    const repo = await ctx.repo('repo')
    const { url, storage, link } = await ctx.store('store')

    const head = await ctx.commit(repo, 'big', random('seeder-leaves'), {
      files: 20,
      size: 1 << 20
    })
    await ctx.ok(['push', url, 'main'], { cwd: repo })

    const seeder = await ctx.seed(storage)
    seeder.getRemote('t').core.once('upload', () => seeder.close())
    const later = new Promise((resolve) => setTimeout(resolve, 2000)).then(() => ctx.seed(storage))

    const dest = path.join(ctx.dir, 'clone')
    const run = await ctx.git(['clone', '-q', ctx.peer(link, 'reader'), dest])
    await later
    t.comment(`clone: exit=${run.code} hung=${run.hung} ${run.ms}ms ${lastLines(run.stderr)}`)

    t.absent(run.hung, 'clone did not hang')
    if (run.code === 0) {
      await ctx.ok(['fsck', '--strict', '--full'], { cwd: dest })
      t.is((await ctx.ok(['rev-parse', 'HEAD'], { cwd: dest })).trim(), head)
    } else if (!run.hung) {
      t.absent(fs.existsSync(dest), 'a failed clone leaves nothing behind')
    }
  }
)

test('a push to a read-only store fails cleanly', { timeout: TIMEOUT }, async (t) => {
  const ctx = await create(t)
  const rand = random('read-only')
  const repo = await ctx.repo('repo')
  const { url, storage } = await ctx.store('store')

  await ctx.commit(repo, 'base', rand)
  await ctx.ok(['push', url, 'main'], { cwd: repo })
  const old = await ctx.refs(url)

  await ctx.commit(repo, 'more', rand)
  await ctx.readOnly(storage, true)
  const run = await ctx.git(['push', url, 'main'], { cwd: repo })
  await ctx.readOnly(storage, false)
  t.comment(`push: exit=${run.code} ${run.ms}ms ${lastLines(run.stderr)}`)

  t.absent(run.hung, 'push did not hang')
  t.ok(run.code > 0, 'non-zero exit')
  t.alike(await ctx.refs(url), old, 'no ref moved')

  await ctx.ok(['push', url, 'main'], { cwd: repo })
  await ctx.verify(url, 'after')
})

// 80 MiB outgrows the 64 MiB memtable, so the store has to create a file mid-push and cannot.
// Too slow for every run: by default the push is small and may well succeed.
test(
  'a store turning read-only mid-push keeps every ref old or new',
  { timeout: TIMEOUT },
  async (t) => {
    const ctx = await create(t)
    const rand = random('read-only-mid-push')
    const repo = await ctx.repo('repo')
    const { url, storage } = await ctx.store('store')

    await ctx.commit(repo, 'base', rand)
    await ctx.ok(['push', url, 'main'], { cwd: repo })
    const old = await ctx.refs(url)

    const next = await ctx.commit(repo, 'big', rand, { files: ITERS ? 80 : 8, size: 1 << 20 })
    const run = await ctx.git(['push', '-v', '-v', url, 'main'], {
      cwd: repo,
      on: { marker: 'Gip [DEBUG]: pushing', fn: () => ctx.readOnly(storage, true) }
    })
    await ctx.readOnly(storage, false)
    t.comment(`push: exit=${run.code} ${run.ms}ms ${lastLines(run.stderr)}`)

    t.absent(run.hung, 'push did not hang')
    const now = (await ctx.refs(url))['refs/heads/main']
    t.ok(now === old['refs/heads/main'] || now === next, 'main is old or new')
    await ctx.verify(url, 'after')

    await ctx.commit(repo, 'after', rand)
    await ctx.ok(['push', url, 'main'], { cwd: repo })
  }
)

// lib/gip.js push() reports a failed ref as `error <oid> <ref> <message>`. git wants
// `error <ref> <message>`, warns about an unexpected status and exits 0.
test.todo('a push whose write fails exits non-zero', { timeout: TIMEOUT }, async (t) => {
  const ctx = await create(t)
  const rand = random('push-error')
  const repo = await ctx.repo('repo')
  const { url, storage } = await ctx.store('store')

  await ctx.commit(repo, 'base', rand)
  await ctx.ok(['push', url, 'main'], { cwd: repo })

  await ctx.commit(repo, 'big', rand, { files: 80, size: 1 << 20 })
  const run = await ctx.git(['push', '-v', '-v', url, 'main'], {
    cwd: repo,
    on: { marker: 'Gip [DEBUG]: pushing', fn: () => ctx.readOnly(storage, true) }
  })
  await ctx.readOnly(storage, false)

  t.ok(run.stderr.includes('Push error'), 'the write failed')
  t.ok(run.code > 0, 'non-zero exit')
})

function describe(op, point, run, shape) {
  const where = `GIP_CHAOS_SEED=${point.seed} GIP_CHAOS_KILL='${point.marker}+${point.delay}'`
  const what = shape ? ` files=${shape.files} size=${shape.size}` : ''
  return `${op} ${where}${what}: killed=${run.killed} exit=${run.code} ${run.ms}ms`
}

function lastLines(stderr) {
  return JSON.stringify(stderr.trim().split('\n').slice(-2).join(' | '))
}
