const test = require('brittle')
const createTestnet = require('hyperdht/testnet')
const Hyperswarm = require('hyperswarm')
const tmp = require('test-tmp')
const Corestore = require('corestore')

const { GipLocalDB } = require('../lib/db')
const { parseCommit, walkTree } = require('gip-remote')
const { GitPearLink } = require('gip-remote')

// --- Helpers ---

async function createStore(t) {
  const dir = await tmp(t)
  const store = new Corestore(dir)
  t.teardown(() => store.close())
  return store
}

// 40-char hex OIDs (proper SHA1 length)
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

  // Tree with one file: index.js
  const srcTreeData = makeTreeData([{ mode: '100644', name: 'index.js', oid: OID_BLOB2 }])
  objects.set(OID_TREE_SRC, { type: 'tree', size: srcTreeData.length, data: srcTreeData })

  // Root tree: README.md (blob) + src (subtree)
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

// --- Tests ---

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

  // Check branch was stored
  const refs = await remote.getAllRefs()
  const main = refs.find((r) => r.ref === 'refs/heads/main')
  t.ok(main, 'main branch exists')
  t.is(main.oid, OID_COMMIT)

  // Check HEAD was synthesized
  const head = refs.find((r) => r.ref === 'HEAD')
  t.ok(head, 'HEAD exists')
  t.is(head.oid, OID_COMMIT)

  // Check objects were stored
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

  // List all files
  const paths = []
  for await (const { key } of drive.list('/')) {
    paths.push(key)
  }

  t.ok(paths.includes('/README.md'), 'has README.md')
  t.ok(paths.includes('/src/index.js'), 'has src/index.js')
  t.is(paths.length, 2)

  // Read file content
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
  // Regression for the "delete then re-add returns the same key with the old
  // length" bug. A repo's key must retire with the repo: createRemote gives
  // each repo its own corestore namespace, so a same-named successor is a
  // different core. Deleting used to leave the name mapped to the same
  // deterministic key and truncate the log to hide the old blocks — which
  // forks a key that peers and blind peers already mirror.
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
  // Regression for the SESSION_NOT_WRITABLE crash. Delete used to truncate the
  // core to hide the old blocks, which is an append — so it threw on every
  // repo added by URL, i.e. most of them. Worse, it threw after closing the
  // Remote and destroying the discovery session but before deleting the
  // registry row, leaving an entry that was torn down yet undeletable.
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

  // The blocks are the only thing a delete can reclaim for a cloned repo —
  // openRemote pulls them in full, so they're the bulk of the store.
  const core = dbB._store.get({ key: remoteA.core.key })
  await core.ready()
  t.teardown(() => core.close())
  t.is(core.contiguousLength, 0, 'local blocks dropped')
})

test('a failure reclaiming disk still deletes the repo', async (t) => {
  // The registry row is the only durable part of a delete; the blocks are
  // cache once nothing points at them. So clearing them must never be able to
  // strand a row the user has already asked to be rid of.
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
  // Regression for the "syncing only works once" bug.
  //
  // First openRemote on B works because the swarm fires a 'connection' event
  // and _waitForTopicPeer resolves through the listener it just attached.
  // Second openRemote (same key) reuses the cached _joined entry, so
  // swarm.join is a no-op and no new 'connection' event ever fires — B was
  // already connected to A from the first sync. The fix is for
  // _waitForTopicPeer to also walk currently-connected peers and resolve via
  // their existing topic announcement.
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

  // Bound the call: if the bug is back, this never resolves and the test
  // dies on Brittle's per-test timeout instead of giving us a clean signal.
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

// --- seedReadOnly config ---
//
// These tests pin the contract for the default-on "seed when read-only"
// behaviour. The setting drives whether we announce non-writable cores on the
// DHT (server:true) so other peers can pull blocks from us. Default ON makes
// every running app a potential reseeder for repos it has cloned.

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
  // Open and close two GipLocalDB instances backed by separate Corestores
  // pointing at the same directory — simulates the app being closed and
  // reopened on the same machine.
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
  // Even with seedReadOnly off, our own writable cores must still be
  // discoverable — we are the source of truth for them. The setting only
  // gates non-writable cores.
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
  // discovery._server is the internal flag set by swarm.join. Check it
  // pragmatically — if hyperswarm renames it later this assertion needs
  // to follow, but for now it's the cleanest way to verify announcement.
  t.is(entry.discovery.isServer, true, 'writable core announced')
})

test('non-writable core honours seedReadOnly setting on join', async (t) => {
  // Two peers share one swarm bootstrap. Peer A creates a repo, peer B
  // joins it as a non-writable clone. We toggle seedReadOnly on B and
  // verify the join's server flag follows.
  const { bootstrap } = await createTestnet(3, t.teardown)

  const dbA = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })
  t.teardown(() => dbA.close())
  await dbA.ready()

  const remoteA = await dbA.createRemote('shared')

  // Default ON case — joining a non-writable core should announce.
  const dbB = new GipLocalDB({
    swarm: new Hyperswarm({ bootstrap }),
    store: await createStore(t)
  })
  t.teardown(() => dbB.close())
  await dbB.ready()

  // _joinCore directly (no need to download; this is purely a swarm/topic
  // assertion).
  await dbB._joinCore(remoteA.core.key)
  const hex = remoteA.core.key.toString('hex')
  const entry = await dbB._joined.get(hex)
  t.ok(entry, "B joined A's core")
  t.is(entry.core.writable, false, 'B sees core as read-only')
  t.is(entry.discovery.isServer, true, 'announced because seedReadOnly is ON by default')

  // Toggle off — re-applies to currently joined non-writable cores.
  await dbB.setSeedReadOnly(false)
  t.is(entry.discovery.isServer, false, 'announcement turned off after setSeedReadOnly(false)')

  // And back on.
  await dbB.setSeedReadOnly(true)
  t.is(entry.discovery.isServer, true, 'announcement turned back on after setSeedReadOnly(true)')
})

test('seedReadOnly off means non-writable cores join as client-only', async (t) => {
  // Fresh DB with the setting turned off BEFORE any non-writable core is
  // joined — verifies the cached _seedReadOnly is read from config at open.
  const { bootstrap } = await createTestnet(3, t.teardown)
  const dir = await tmp(t)

  // Persist seedReadOnly:false in a throwaway DB at `dir`, then close it
  // (and its corestore) so we can reopen the same dir fresh.
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

  // Opening the repo afterwards must still be able to find peers.
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
  // The schema stores seedReadOnly as a flag bit, so any written record
  // decodes to a strict boolean. Writing config for another reason must not
  // silently persist seedReadOnly:false and turn reseeding off.
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
