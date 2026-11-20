const test = require('brittle')
const createTestnet = require('hyperdht/testnet')
const Hyperswarm = require('hyperswarm')
const tmp = require('test-tmp')
const Corestore = require('corestore')
const Id = require('hypercore-id-encoding')
const { GipLocalDB } = require('../lib/db')

const OID_BLOB1 = 'aa'.repeat(20)
const OID_TREE_ROOT = 'dd'.repeat(20)
const OID_COMMIT = 'ee'.repeat(20)
const OID_COMMIT_2 = '11'.repeat(20)

async function createStore(t) {
  const dir = await tmp(t)
  const store = new Corestore(dir)
  t.teardown(() => store.close(), { order: 1 })
  return store
}

function makeTreeData(entries) {
  const bufs = []
  for (const { mode, name, oid } of entries) {
    bufs.push(Buffer.from(`${mode} ${name}\0`))
    bufs.push(Buffer.from(oid, 'hex'))
  }
  return Buffer.concat(bufs)
}

function makeCommit(oid, message, parent) {
  const lines = [`tree ${OID_TREE_ROOT}`]
  if (parent) lines.push(`parent ${parent}`)
  lines.push(
    'author Test User <test@test.com> 1700000000 +0000',
    'committer Test User <test@test.com> 1700000000 +0000',
    '',
    message
  )
  const data = Buffer.from(lines.join('\n'))
  return [oid, { type: 'commit', size: data.length, data }]
}

function makeTestObjects() {
  const objects = new Map()

  const blob = Buffer.from('hello world')
  objects.set(OID_BLOB1, { type: 'blob', size: blob.length, data: blob })

  const tree = makeTreeData([{ mode: '100644', name: 'README.md', oid: OID_BLOB1 }])
  objects.set(OID_TREE_ROOT, { type: 'tree', size: tree.length, data: tree })

  const [oid, commit] = makeCommit(OID_COMMIT, 'initial commit')
  objects.set(oid, commit)

  return objects
}

function secondCommit(objects) {
  const next = new Map(objects)
  const [oid, commit] = makeCommit(OID_COMMIT_2, 'second commit', OID_COMMIT)
  next.set(oid, commit)
  return next
}

async function createDB(t, bootstrap) {
  const db = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })
  t.teardown(() => db.close())
  await db.ready()
  return db
}

async function twoPushWriter(t, bootstrap, name) {
  const db = await createDB(t, bootstrap)

  const remote = await db.createRemote(name)
  const objects = makeTestObjects()

  await remote.push('main', OID_COMMIT, objects)
  const length = remote.core.length
  const key = Id.encode(remote.core.key)
  const pinned = `git+pear://0.${length}.${key}/${name}`

  await remote.push('dev', OID_COMMIT_2, secondCommit(objects))

  return { db, remote, key, length, pinned }
}

test('a versioned link resolves the pinned version, not latest', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const writer = await twoPushWriter(t, bootstrap, 'pin-resolve')

  t.ok(writer.remote.core.length > writer.length, 'the log moved past the pin')

  const db = await createDB(t, bootstrap)

  const remote = await db.openRemote(writer.pinned)

  t.is(remote.pinned, true, 'remote reports itself pinned')
  t.alike(remote.version, { fork: 0, length: writer.length })

  const refs = await remote.getAllRefs()
  const names = refs.map((r) => r.ref)

  t.ok(names.includes('refs/heads/main'), 'the branch inside the pin is there')
  t.absent(names.includes('refs/heads/dev'), 'the branch pushed after it is not')
})

test('a pinned link downloads nothing past the pin', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const writer = await twoPushWriter(t, bootstrap, 'pin-no-download')

  const db = await createDB(t, bootstrap)

  const remote = await db.openRemote(writer.pinned)
  await remote.getAllRefs()

  const core = remote.core

  t.ok(core.length >= writer.length, 'the log is known to reach the pin')
  t.absent(await core.has(writer.length), 'the first block past the pin was never fetched')
  t.ok(
    core.contiguousLength <= writer.length,
    `downloaded no further than the pin (${core.contiguousLength} <= ${writer.length})`
  )
})

test('an unversioned link follows latest', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const writer = await twoPushWriter(t, bootstrap, 'pin-latest')

  const db = await createDB(t, bootstrap)

  const remote = await db.openRemote(`git+pear://${writer.key}/pin-latest`)

  t.is(remote.pinned, false, 'remote is not pinned')
  t.is(remote.version, null)

  const names = (await remote.getAllRefs()).map((r) => r.ref)
  t.ok(names.includes('refs/heads/dev'), 'the latest branch is there')
})

test('a length beyond the log is refused', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const writer = await twoPushWriter(t, bootstrap, 'pin-too-long')

  const beyond = writer.remote.core.length + 10

  const db = await createDB(t, bootstrap)

  await t.exception(
    db.openRemote(`git+pear://0.${beyond}.${writer.key}/pin-too-long`),
    /Version not available/
  )

  t.alike(await db.getRepoNames(), [], 'a refused link registers no repo')
})

test('a fork mismatch is refused', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const writer = await twoPushWriter(t, bootstrap, 'pin-wrong-fork')

  const db = await createDB(t, bootstrap)

  await t.exception(
    db.openRemote(`git+pear://1.${writer.length}.${writer.key}/pin-wrong-fork`),
    /Fork mismatch/
  )
})

test('a pinned remote refuses writes', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const writer = await twoPushWriter(t, bootstrap, 'pin-read-only')

  const db = await createDB(t, bootstrap)

  const remote = await db.openRemote(writer.pinned)

  await t.exception(remote.push('main', OID_COMMIT, makeTestObjects()), /pinned to 0\.\d+/)
  await t.exception(remote.setHead('main'), /pinned to 0\.\d+/)
  await t.exception(remote.deleteBranch('main'), /pinned to 0\.\d+/)
  await t.exception(remote.deleteTag('v1'), /pinned to 0\.\d+/)
})

test('update() does not advance a pin', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const writer = await twoPushWriter(t, bootstrap, 'pin-stays')

  const db = await createDB(t, bootstrap)

  const remote = await db.openRemote(writer.pinned)
  const before = await remote.getAllRefs()

  await writer.remote.push('later', OID_COMMIT_2, secondCommit(makeTestObjects()))
  await remote.update()

  t.alike(await remote.getAllRefs(), before, 'the view did not move')
})
