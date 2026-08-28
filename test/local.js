const test = require('brittle')
const createTestnet = require('hyperdht/testnet')
const Hyperswarm = require('hyperswarm')
const tmp = require('test-tmp')
const Corestore = require('corestore')

const { GipLocalDB } = require('../lib/db')
const { parseCommit } = require('gip-remote')

async function createStore(t) {
  const dir = await tmp(t)
  const store = new Corestore(dir)
  t.teardown(() => store.close())
  return store
}

const OID_BLOB1 = 'aa'.repeat(20) // blob: hello world
const OID_BLOB2 = 'bb'.repeat(20) // blob: console.log("hi")
const OID_TREE_SRC = 'cc'.repeat(20) // tree: src/
const OID_TREE_ROOT = 'dd'.repeat(20) // tree: root
const OID_COMMIT = 'ee'.repeat(20) // commit

function makeTestObjects() {
  const blobData = Buffer.from('hello world')
  const objects = new Map()
  objects.set(OID_BLOB1, { type: 'blob', size: blobData.length, data: blobData })

  const blob2Data = Buffer.from('console.log("hi")')
  objects.set(OID_BLOB2, { type: 'blob', size: blob2Data.length, data: blob2Data })

  const srcTreeData = makeTreeData([{ mode: '100644', name: 'index.js', oid: OID_BLOB2 }])
  objects.set(OID_TREE_SRC, { type: 'tree', size: srcTreeData.length, data: srcTreeData })

  const rootTreeData = makeTreeData([
    { mode: '100644', name: 'README.md', oid: OID_BLOB1 },
    { mode: '40000', name: 'src', oid: OID_TREE_SRC }
  ])
  objects.set(OID_TREE_ROOT, { type: 'tree', size: rootTreeData.length, data: rootTreeData })

  const commitText = [
    `tree ${OID_TREE_ROOT}`,
    `author Test User <test@test.com> 1700000000 +0000`,
    `committer Test User <test@test.com> 1700000000 +0000`,
    '',
    'initial commit'
  ].join('\n')
  const commitData = Buffer.from(commitText)
  objects.set(OID_COMMIT, { type: 'commit', size: commitData.length, data: commitData })

  return objects
}

function makeTreeData(entries) {
  // Git tree format: <mode> <name>\0<20-byte-binary-oid> repeated
  const bufs = []
  for (const { mode, name, oid } of entries) {
    bufs.push(Buffer.from(`${mode} ${name}\0`))
    bufs.push(Buffer.from(oid, 'hex')) // 40-char hex → 20-byte binary
  }
  return Buffer.concat(bufs)
}

test('parseCommit extracts metadata', (t) => {
  const data = Buffer.from(
    [
      'tree abc123',
      'parent def456',
      'author Alice <alice@example.com> 1700000000 +0000',
      'committer Bob <bob@example.com> 1700000001 +0000',
      '',
      'Fix the thing',
      '',
      'More details here.'
    ].join('\n')
  )

  const commit = parseCommit(data)

  t.is(commit.tree, 'abc123')
  t.alike(commit.parents, ['def456'])
  t.is(commit.author, 'Alice')
  t.is(commit.timestamp, 1700000000)
  t.is(commit.message, 'Fix the thing\n\nMore details here.')
})

test('parseCommit handles no parent', (t) => {
  const data = Buffer.from(
    [
      'tree abc123',
      'author Alice <alice@example.com> 1700000000 +0000',
      'committer Alice <alice@example.com> 1700000000 +0000',
      '',
      'initial'
    ].join('\n')
  )

  const commit = parseCommit(data)

  t.is(commit.tree, 'abc123')
  t.alike(commit.parents, [])
  t.is(commit.message, 'initial')
})

test('createRemote and getRepo', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const db = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })

  t.teardown(() => db.close())
  await db.ready()

  const remote = await db.createRemote('test-repo')
  t.ok(remote.key, 'remote has a key')
  t.is(remote.name, 'test-repo')

  const found = await db.getRepo('test-repo')
  t.ok(found, 'found the repo')
  t.alike(found.key, remote.key, 'keys match')
})

test('push stores objects, branch, and files', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const db = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })

  t.teardown(() => db.close())
  await db.ready()

  const remote = await db.createRemote('push-test')
  const objects = makeTestObjects()

  await remote.push('main', OID_COMMIT, objects)

  const refs = await remote.getAllRefs()
  const main = refs.find((r) => r.ref === 'refs/heads/main')
  t.ok(main, 'main branch exists')
  t.is(main.oid, OID_COMMIT)

  const head = refs.find((r) => r.ref === 'HEAD')
  t.ok(head, 'HEAD exists')
  t.is(head.oid, OID_COMMIT)

  const blob = await remote.getObject(OID_BLOB1)
  t.ok(blob, 'blob stored')
  t.is(blob.type, 'blob')
  t.is(blob.data.toString(), 'hello world')
})

test('toDrive lists files and reads content', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const db = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })

  t.teardown(() => db.close())
  await db.ready()

  const remote = await db.createRemote('drive-test')
  const objects = makeTestObjects()
  await remote.push('main', OID_COMMIT, objects)

  const drive = await remote.toDrive('main')
  t.ok(drive, 'drive created')

  const paths = []
  for await (const { key } of drive.list('/')) {
    paths.push(key)
  }

  t.ok(paths.includes('/README.md'), 'has README.md')
  t.ok(paths.includes('/src/index.js'), 'has src/index.js')
  t.is(paths.length, 2)

  const content = await drive.get('/README.md')
  t.is(content.toString(), 'hello world')
})

test('drive entry returns correct metadata', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const db = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })

  t.teardown(() => db.close())
  await db.ready()

  const remote = await db.createRemote('entry-test')
  const objects = makeTestObjects()
  await remote.push('main', OID_COMMIT, objects)

  const drive = await remote.toDrive('main')

  const entry = await drive.entry('/README.md')
  t.ok(entry, 'entry found')
  t.is(entry.key, '/README.md')
  t.is(entry.value.blob.byteLength, 11) // 'hello world'.length
  t.is(entry.value.executable, false)

  const missing = await drive.entry('/nope.txt')
  t.is(missing, null, 'missing entry returns null')
})

test('drive readdir returns immediate children', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const db = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })

  t.teardown(() => db.close())
  await db.ready()

  const remote = await db.createRemote('readdir-test')
  const objects = makeTestObjects()
  await remote.push('main', OID_COMMIT, objects)

  const drive = await remote.toDrive('main')

  const rootEntries = []
  for await (const name of drive.readdir('/')) {
    rootEntries.push(name)
  }

  t.ok(rootEntries.includes('README.md'), 'has README.md')
  t.ok(rootEntries.includes('src'), 'has src dir')
  t.is(rootEntries.length, 2)
})

test('getBranchRef returns null for missing branch', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const db = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })

  t.teardown(() => db.close())
  await db.ready()

  const remote = await db.createRemote('missing-branch')

  const ref = await remote.getBranchRef('nonexistent')
  t.is(ref, null)
})

test('re-creating a deleted name gets a fresh core, not the old one', async (t) => {
  // A repo's key retires with the repo — the old key stays published and unforked.
  const { bootstrap } = await createTestnet(3, t.teardown)

  const db = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })

  t.teardown(() => db.close())
  await db.ready()

  const original = await db.createRemote('round-trip')
  const originalKey = Buffer.from(original.key)
  await original.push('main', OID_COMMIT, makeTestObjects())

  const lengthBeforeDelete = original.core.length
  t.ok(lengthBeforeDelete > 0, 'first push produced blocks')

  const deleted = await db.deleteRemote('round-trip')
  t.is(deleted, true, 'delete reports success')
  t.is(await db.getRepo('round-trip'), null, 'repo registry row gone')

  const recreated = await db.createRemote('round-trip')
  t.unlike(Buffer.from(recreated.key), originalKey, 'the successor is a different core')
  t.is(recreated.core.fork, 0, 'and an unforked one — delete never rewrites a published key')
  t.is(recreated.core.length, 0, 'recreated core starts empty')
  t.is(await recreated.getHead(), null, 'no leftover HEAD record')
  t.is(await recreated.getObject(OID_COMMIT), null, 'no leftover objects')

  const refs = await recreated.getAllRefs()
  t.is(refs.length, 0, 'no leftover refs')
})

test('deleteRemote works on a cloned repo we have no write capability for', async (t) => {
  // Regression: delete used to truncate, which is an append, so it threw on every repo added by URL.
  const { bootstrap } = await createTestnet(3, t.teardown)

  const dbA = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })
  t.teardown(() => dbA.close())
  await dbA.ready()

  const remoteA = await dbA.createRemote('cloned')
  await remoteA.push('main', OID_COMMIT, makeTestObjects())

  const dbB = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })
  t.teardown(() => dbB.close())
  await dbB.ready()

  const cloned = await dbB.openRemote({ name: 'cloned', key: remoteA.core.key })
  t.absent(cloned.core.writable, 'cloned core carries no write capability')
  t.ok(cloned.core.contiguousLength > 0, 'and openRemote downloaded its blocks')

  t.is(await dbB.deleteRemote('cloned'), true, 'delete reports success')
  t.is(await dbB.getRepo('cloned'), null, 'registry row gone')
  t.alike(await dbB.getRepoNames(), [], 'and the repo is no longer listed')

  // Blocks are all a delete can reclaim for a clone, and openRemote pulls them in full.
  const core = dbB._store.get({ key: remoteA.core.key })
  await core.ready()
  t.teardown(() => core.close())
  t.is(core.contiguousLength, 0, 'local blocks dropped')
})

test('a failure reclaiming disk still deletes the repo', async (t) => {
  // Blocks are cache once nothing points at them, so clearing them must never strand the row.
  const { bootstrap } = await createTestnet(3, t.teardown)

  const db = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })
  t.teardown(() => db.close())
  await db.ready()

  const remote = await db.createRemote('doomed')
  await remote.push('main', OID_COMMIT, makeTestObjects())

  db._clearCore = () => Promise.reject(new Error('storage went away'))

  t.is(await db.deleteRemote('doomed'), true, 'delete still reports success')
  t.is(await db.getRepo('doomed'), null, 'registry row gone')
})

test('deleteRemote returns false for unknown name', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const db = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })

  t.teardown(() => db.close())
  await db.ready()

  const result = await db.deleteRemote('never-existed')
  t.is(result, false)
})

test('openRemote can be called twice without hanging on the 2nd call', async (t) => {
  // The second call reuses the cached _joined entry, so no new 'connection' event fires.
  const { bootstrap } = await createTestnet(3, t.teardown)

  const dbA = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })
  t.teardown(() => dbA.close())
  await dbA.ready()
  const remoteA = await dbA.createRemote('twice-synced')

  const dbB = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })
  t.teardown(() => dbB.close())
  await dbB.ready()

  const link = { name: 'twice-synced', key: remoteA.core.key }

  // Bounded so a regression fails with a clear message, not Brittle's per-test timeout.
  const guard = (label, p) =>
    Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} hung > 10s`)), 10000))
    ])

  await guard('1st openRemote', dbB.openRemote(link))
  t.pass('first openRemote resolved')

  await guard('2nd openRemote', dbB.openRemote(link))
  t.pass('second openRemote resolved (no hang)')
})

test('toDrive returns null for missing branch', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const db = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })

  t.teardown(() => db.close())
  await db.ready()

  const remote = await db.createRemote('no-drive')

  const drive = await remote.toDrive('main')
  t.is(drive, null)
})

test('seedReadOnly defaults to ON', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const db = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })

  t.teardown(() => db.close())
  await db.ready()

  t.is(await db.getSeedReadOnly(), true, 'default is ON')
  t.is(db._seedReadOnly, true, 'cached field is ON')
})

test('seedReadOnly can be turned off and on', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const db = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })

  t.teardown(() => db.close())
  await db.ready()

  await db.setSeedReadOnly(false)
  t.is(await db.getSeedReadOnly(), false, 'persisted as off')
  t.is(db._seedReadOnly, false, 'cache updated to off')

  await db.setSeedReadOnly(true)
  t.is(await db.getSeedReadOnly(), true, 'persisted back to on')
  t.is(db._seedReadOnly, true, 'cache updated to on')
})

test('seedReadOnly persists across db restarts', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const dir = await tmp(t)

  const store1 = new Corestore(dir)
  const db1 = new GipLocalDB({ swarm: new Hyperswarm({ bootstrap }), store: store1 })
  await db1.ready()
  await db1.setSeedReadOnly(false)
  await db1.close()
  await store1.close()

  const store2 = new Corestore(dir)
  t.teardown(() => store2.close())
  const db2 = new GipLocalDB({ swarm: new Hyperswarm({ bootstrap }), store: store2 })
  t.teardown(() => db2.close())
  await db2.ready()

  t.is(await db2.getSeedReadOnly(), false, 'persisted off across restart')
  t.is(db2._seedReadOnly, false, 'cache reflects persisted value')
})

test('writable cores are always announced (server:true) regardless of seedReadOnly', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const db = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })

  t.teardown(() => db.close())
  await db.ready()

  await db.setSeedReadOnly(false)

  const remote = await db.createRemote('mine')
  const hex = remote.core.key.toString('hex')
  const entry = await db._joined.get(hex)
  t.ok(entry, 'core joined the swarm')
  t.ok(remote.core.writable, 'core is writable (we own it)')
  t.is(entry.discovery.isServer, true, 'writable core announced')
})

test('non-writable core honours seedReadOnly setting on join', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const dbA = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })
  t.teardown(() => dbA.close())
  await dbA.ready()

  const remoteA = await dbA.createRemote('shared')

  const dbB = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })
  t.teardown(() => dbB.close())
  await dbB.ready()

  await dbB._joinCore(remoteA.core.key)
  const hex = remoteA.core.key.toString('hex')
  const entry = await dbB._joined.get(hex)
  t.ok(entry, "B joined A's core")
  t.is(entry.core.writable, false, 'B sees core as read-only')
  t.is(entry.discovery.isServer, true, 'announced because seedReadOnly is ON by default')

  await dbB.setSeedReadOnly(false)
  t.is(entry.discovery.isServer, false, 'announcement turned off after setSeedReadOnly(false)')

  await dbB.setSeedReadOnly(true)
  t.is(entry.discovery.isServer, true, 'announcement turned back on after setSeedReadOnly(true)')
})

test('seedReadOnly off means non-writable cores join as client-only', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const dir = await tmp(t)

  // Persist the setting in a throwaway DB so dbB reopens the same dir fresh.
  const setupStore = new Corestore(dir)
  const setup = new GipLocalDB({ swarm: new Hyperswarm({ bootstrap }), store: setupStore })
  await setup.ready()
  await setup.setSeedReadOnly(false)
  await setup.close()
  await setupStore.close()

  const dbA = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })
  t.teardown(() => dbA.close())
  await dbA.ready()
  const remoteA = await dbA.createRemote('shared-off')

  const storeB = new Corestore(dir)
  t.teardown(() => storeB.close())
  const dbB = new GipLocalDB({ swarm: new Hyperswarm({ bootstrap }), store: storeB })
  t.teardown(() => dbB.close())
  await dbB.ready()

  t.is(dbB._seedReadOnly, false, 'cache loaded from persisted config')

  await dbB._joinCore(remoteA.core.key)
  const hex = remoteA.core.key.toString('hex')
  const entry = await dbB._joined.get(hex)
  t.is(entry.discovery.isServer, false, 'not announced when setting is off')
})

test('a local-only join leaves discovery open to a later join', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const dbA = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })
  t.teardown(() => dbA.close())
  await dbA.ready()
  const remoteA = await dbA.createRemote('listed')

  const dbB = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })
  t.teardown(() => dbB.close())
  await dbB.ready()

  // What a listing route does: local metadata, no swarm state.
  const listed = await dbB._joinCore(remoteA.core.key, { server: false, client: false })
  t.is(listed.discovery, null, 'local-only join creates no swarm session')

  const opened = await dbB._joinCore(remoteA.core.key)
  t.is(opened.discovery.isClient, true, 'a later join looks up the topic')
  t.is(opened.discovery.isServer, true, 'a later join announces the topic')
})

test('concurrent joins share one core session', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const dbA = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })
  t.teardown(() => dbA.close())
  await dbA.ready()
  const remoteA = await dbA.createRemote('raced')

  const dbB = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })
  t.teardown(() => dbB.close())
  await dbB.ready()

  const [x, y] = await Promise.all([
    dbB._joinCore(remoteA.core.key),
    dbB._joinCore(remoteA.core.key)
  ])

  t.is(x.core, y.core, 'both callers got the same core')
  t.is(dbB._joined.size, 1, 'one cache entry')
})

test('seedReadOnly survives an unrelated config write', async (t) => {
  // seedReadOnly is a flag bit, so an unrelated write must not silently persist it as false.
  const db = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap: (await createTestnet(3, t.teardown)).bootstrap }),
    store: await createStore(t)
  })
  t.teardown(() => db.close())
  await db.ready()

  t.is(await db.getSeedReadOnly(), true, 'default is ON')

  await db.addBlindPeer('qiysd9x3cwk47wb1khrbiw1ie8gj9uttnt3mwcgr9obthb96kxxo')

  t.is(await db.getSeedReadOnly(), true, 'still ON after writing a blind peer')
  t.is(db._seedReadOnly, true, 'cached field still ON')
})
