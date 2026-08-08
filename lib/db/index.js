const { homedir } = require('os')
const { join } = require('path')
const Corestore = require('corestore')
const BlindPeering = require('blind-peering')
const Hyperswarm = require('hyperswarm')
const Wakeup = require('protomux-wakeup')
const ReadyResource = require('ready-resource')
const HyperDB = require('hyperdb')
const Id = require('hypercore-id-encoding')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const def = require('./schema/hyperdb/index')
const { Remote, GitPearLink } = require('gip-remote')
const HyperDHT = require('hyperdht')

class GipLocalDB extends ReadyResource {
  _swarm = null
  _store = null
  _wakeup = null
  _identity = null
  _db = null
  _remotes = new Map()
  _joined = new Map() // hex(key) → { core, discovery }
  _seedReadOnly = true // cached from config at open, see getConfig

  constructor(opts = {}) {
    super()

    this._store =
      opts.store ||
      new Corestore(opts.dir || join(homedir(), '.gip'), { readOnly: !!opts.readonly })
    this._externalSwarm = opts.swarm || null
  }

  get remotes() {
    return this._remotes
  }

  getRemote(repo) {
    return this._remotes.get(repo)
  }

  // --- Config ---

  /**
   * Defaults live here because every caller that writes config spreads this
   * result. seedReadOnly is a flag bit in the schema, so a stored record only
   * ever decodes to a strict boolean — default on read alone and the first
   * unrelated write persists the wrong value as if it were deliberate.
   */
  async getConfig() {
    const record = await this._db.get('@gip/config', {})
    if (!record) return { blindPeers: [], seedReadOnly: true }
    return record
  }

  async setConfig(config) {
    await this._db.insert('@gip/config', config)
    await this._db.flush()
  }

  // --- Blind Peers ---

  async getBlindPeers() {
    const config = await this.getConfig()
    return (config.blindPeers || []).map((buf) => Id.normalize(buf))
  }

  async addBlindPeer(peerKey) {
    const buf = Id.decode(peerKey)
    const config = await this.getConfig()
    const peers = config.blindPeers || []

    if (peers.some((p) => b4a.equals(p, buf))) return

    peers.push(buf)
    await this.setConfig({ ...config, blindPeers: peers })
  }

  async removeBlindPeer(peerKey) {
    const buf = Id.decode(peerKey)
    const config = await this.getConfig()
    const peers = config.blindPeers || []
    const idx = peers.findIndex((p) => b4a.equals(p, buf))
    if (idx === -1) return false

    peers.splice(idx, 1)
    await this.setConfig({ ...config, blindPeers: peers })
    return true
  }

  // --- Store / swarm access ---

  namespace(name) {
    return this._store.namespace(name)
  }

  // --- Seed read-only ---

  /**
   * Whether we act as a server on the swarm for cores we don't own.
   * Default is true so other peers can find us and pull blocks we already
   * have — phones become reseeders for repos they've cloned.
   */
  async getSeedReadOnly() {
    const config = await this.getConfig()
    return config.seedReadOnly
  }

  /**
   * Toggle seed-on-clone behaviour. Re-applies to currently-joined cores
   * so the change takes effect immediately, no restart needed.
   */
  async setSeedReadOnly(enabled) {
    const value = !!enabled
    const config = await this.getConfig()
    await this.setConfig({ ...config, seedReadOnly: value })
    this._seedReadOnly = value

    // Update each currently-joined non-writable session in place. Going
    // through swarm.join again would *add* a new session alongside the old
    // one (sessions are additive in hyperswarm), so the old server=true
    // session would still keep us announced. session.refresh() mutates the
    // existing session's flags and is the right primitive here.
    if (this._swarm) {
      for (const opening of this._joined.values()) {
        const { core, discovery } = await opening
        if (core.writable || !discovery) continue
        discovery.refresh({ server: value, client: true }).catch(() => {})
        if (value) discovery.flushed().catch(() => {})
      }
    }
  }

  // --- Core/swarm plumbing (layer 1) ---

  /**
   * Open a core by key and join the swarm on its discovery topic.
   *
   * This is the minimum needed for block-level replication — no Hyperbee or
   * HyperDB is opened. Seeders need only this. The core is cached by key —
   * the map holds the in-flight open, so concurrent callers share one core
   * session instead of each opening their own.
   *
   * Discovery is separate from the core: { server: false, client: false }
   * means "local metadata only" and joins nothing, so a listing route can ask
   * for a core without putting us on the DHT. A later call that does want
   * discovery joins for real — the earlier local-only call must not be able
   * to pin the topic off for the process lifetime.
   *
   * Returns { core, discovery }, discovery null while nothing has asked for it.
   */
  async _joinCore(key, opts = {}) {
    const hex = b4a.toString(key, 'hex')
    let opening = this._joined.get(hex)

    if (!opening) {
      opening = this._openCore(key)
      this._joined.set(hex, opening)
    }

    const entry = await opening
    const { core } = entry

    // Default server flag:
    //   - writable cores: always announce — we're the source of truth.
    //   - read-only cores: announce only if seedReadOnly is on (default ON).
    //     This is what makes devices-with-the-app-open into reseeders for
    //     repos they've cloned, without requiring a dedicated server.
    const server = opts.server ?? (core.writable || this._seedReadOnly)
    const client = opts.client ?? !core.writable

    if (!server && !client) return entry

    if (!entry.discovery) {
      entry.discovery = this._swarm.join(core.discoveryKey, { server, client })

      if (this._blind) {
        this._blind.resume()
        this._blind.addCoreBackground(core, { announce: true, mirrors: 2 })
      }
    } else if (server !== entry.discovery.isServer || client !== entry.discovery.isClient) {
      // Only when the flags actually widen. An unconditional refresh forces a
      // DHT round-trip + reconnects on every call, and hot routes call this
      // for every repo on every request.
      entry.discovery.refresh({ server, client }).catch(() => {})
    }

    return entry
  }

  async _openCore(key) {
    const core = this._store.get({ key })
    await core.ready()
    return { core, discovery: null }
  }

  /**
   * Normalize a link/URL into { key, name }.
   */
  _parseLink(link) {
    const parsed =
      typeof link === 'string' && link.startsWith('git+pear:') ? GitPearLink.parse(link) : link

    if (parsed && parsed.drive) {
      return {
        key: parsed.drive.key,
        name: parsed.pathname?.split('/').slice(1)[0]
      }
    }
    return { key: parsed.key, name: parsed.name }
  }

  // --- Remotes ---

  /**
   * Internal: open a full Remote (Hyperbee/HyperDB) without syncing data.
   * Safe for writable cores (we have all data locally). For non-writable
   * cores, use openRemote which explicitly downloads blocks first.
   */
  async _createRemote(link, store = this._store.session()) {
    const remote = new Remote(store, link, { blind: this._blind })
    await remote.ready()
    const { discovery } = await this._joinCore(remote.core.key)
    if (remote.core.writable) await discovery.flushed()
    return remote
  }

  async *getRemotes(query, options = {}) {
    const knownRepos = await this._db.find('@gip/repos', query, options)

    for await (const repo of knownRepos) {
      const remote = await this._createRemote({ name: repo.name, key: repo.key })
      yield remote
    }
  }

  async openRemotes() {
    const knownRepos = await this._db.find('@gip/repos')

    const remotes = []
    for await (const repo of knownRepos) {
      remotes.push(
        this._createRemote({ name: repo.name, key: repo.key }).then((r) => {
          this._remotes.set(repo.name, r)
        })
      )
    }

    await Promise.all(remotes)
    return this._remotes
  }

  /**
   * Create a new writable repo.
   *
   * Each create gets its own corestore namespace, which is the whole point:
   * corestore derives a named core's keyPair from (primaryKey, namespace,
   * name), so creating in the default namespace makes `foo` the same core
   * forever — delete it and the next `createRemote('foo')` re-opens the deleted
   * repo's key and serves its old refs. Deletion can't undo that without
   * rewriting a key other peers already mirror, so identity is settled here
   * instead: a repo's key retires with the repo, and a same-named successor is
   * a genuinely different core with its own URL.
   *
   * The namespace is not worth persisting. Reopening goes by key (getRepo,
   * openRemotes) and the secretKey rides along in the core header, so the core
   * stays writable across restarts without re-deriving anything from the name.
   */
  async createRemote(name) {
    const remote = await this._createRemote(name, this._store.namespace(crypto.randomBytes(32)))

    await this._db.insert('@gip/repos', {
      name,
      key: remote.key
    })

    await this._db.flush()

    this._remotes.set(name, remote)

    return remote
  }

  /**
   * Add a remote by URL. Fully syncs the core locally so subsequent reads
   * (git clone/fetch) are served from disk with no round-trips.
   *
   * Delegates to openRemote, adding an `isNew` flag by checking whether the
   * repo record already existed locally before the sync.
   *
   * Returns { name, key, remote, isNew }.
   */
  async addRemote(link, opts = {}) {
    const { name } = this._parseLink(link)
    const existing = await this._db.get('@gip/repos', { name })
    const remote = await this.openRemote(link, opts)
    return { name, key: remote.key, remote, isNew: !existing }
  }

  /**
   * Open a Remote for reading — used by git clone/fetch/push.
   *
   * Data flow for leechers (non-writable cores):
   *   1. core.findingPeers() — tell the replicator discovery is still running
   *   2. Join the swarm and flush in the background, releasing the guard when
   *      discovery is exhausted
   *   3. core.update({ wait: true }) — learn the peer's length + verify head
   *   4. core.download({ start: 0, end: core.length }).done() — pull ALL blocks
   *   5. Only NOW open Remote / Hyperbee — every read is served from local
   *      storage, so no lazy round-trip fetches during git iteration.
   *
   * The guard is the whole trick, and it's why nothing here blocks on
   * discovery. update() returns the moment any peer can upgrade us — a swarm
   * seeder or a blind peer, which serves blocks without ever announcing the
   * topic — and returns false rather than hanging once findingPeers hits zero
   * with nobody found. Blocking on discovery instead is what made this slow:
   * swarm.flush() is a whole-swarm barrier that awaits every joined topic's
   * DHT query plus the pending connection queue, and waiting on a peer that
   * announces this specific topic ignores the blind peer that already has the
   * data. Measured on a cold add: flush released at 9.6s, the topic peer at
   * 1.6s (or never), the sync itself cost 80ms.
   *
   * Writable cores skip the sync — we're the source of truth.
   */
  async openRemote(link, { blind, blindPeerKeys } = {}) {
    if (!blind) {
      if (blindPeerKeys?.length) this._addBlindPeerKeys(blindPeerKeys)
      blind = this._blind
    }
    const { key, name } = this._parseLink(link)

    // This session exists only for the sync below — _joinCore keeps its own for
    // as long as we're replicating, and the Remote opens another. Leaving it
    // open would pin the core in corestore past the repo's own lifetime.
    const core = this._store.get({ key })
    let remote = null
    try {
      await core.ready()

      if (core.writable) {
        await this._joinCore(key)
      } else {
        const found = core.findingPeers()
        this._joinCore(key)
          .then(() => this._swarm.flush())
          .then(found, found)

        await core.update({ wait: true })

        if (core.length > 0) {
          await core.download({ start: 0, end: core.length }).done()
        }
      }

      // Core is fully populated locally — Hyperbee reads all blocks from disk.
      // Hand the Remote a store session, never the store itself: closing a
      // Remote closes the store it was given, so passing this._store here made
      // deleting a cloned repo close the whole corestore out from under us.
      remote = new Remote(this._store.session(), { name, key }, { blind })
      await remote.ready()
    } finally {
      await core.close()
    }

    const existing = await this._db.get('@gip/repos', { name })
    if (!existing) {
      await this._db.insert('@gip/repos', { name, key })
      await this._db.flush()
    }

    this._remotes.set(name, remote)
    return remote
  }

  /**
   * Fold extra blind peers into the process-wide BlindPeering.
   *
   * A caller that knows about peers we don't (a repo listing carries its own)
   * used to get a second BlindPeering built per call — never closed, no shared
   * wakeup, its own connections. One instance, one key set.
   */
  _addBlindPeerKeys(keys) {
    if (!this._blind) {
      this._wakeup = this._wakeup || new Wakeup()
      this._blind = new BlindPeering(this._swarm.dht, this._store, {
        wakeup: this._wakeup,
        keys
      })
      return
    }

    const current = this._blind.keys
    const extra = keys.filter((k) => !current.some((c) => b4a.equals(c, k)))
    if (extra.length) this._blind.setKeys([...current, ...extra])
  }

  async getRepoNames() {
    const names = []
    const repos = this._db.find('@gip/repos')
    for await (const repo of repos) names.push(repo.name)
    return names
  }

  /**
   * Lightweight handle for a known repo — just core + swarm, no Hyperbee.
   *
   * This is what seeders need: the core is registered in corestore and
   * announced on the swarm (server=true by default for this helper), so
   * `store.replicate(conn)` handles block-level replication when peers
   * connect. No database wrappers are opened.
   *
   * Pass { server: false, client: false } to get a handle without any
   * swarm announcement (e.g. for local-only listing).
   *
   * With no opts the core joins on _joinCore's defaults and returns without
   * waiting for the announce — opts.server is what asks to block on it.
   *
   * Returns { name, key, core } or null.
   */
  async getCore(name, opts = {}) {
    const repo = await this._db.get('@gip/repos', { name })
    if (!repo) return null
    const { core, discovery } = await this._joinCore(repo.key, opts)
    if (opts.server) await discovery.flushed()
    return { name, key: repo.key, core }
  }

  async getRepo(name) {
    const repo = await this._db.get('@gip/repos', { name })
    if (!repo) return null

    const remote = await this._createRemote({ name: repo.name, key: repo.key })
    this._remotes.set(name, remote)
    return remote
  }

  /**
   * Forget a repo: drop the record, stop replicating it, reclaim the disk.
   *
   * Only the record is durable state — everything else is a core whose blocks
   * are cache once nothing points at them, and a swarm session. So the record
   * goes first and the rest is best-effort. Doing it the other way round is
   * what made the old bug so sticky: teardown threw, the row survived, and the
   * repo stayed on the list, torn down and undeletable on every retry.
   */
  async deleteRemote(name) {
    const repo = await this._db.get('@gip/repos', { name })
    if (!repo) return false

    await this._db.delete('@gip/repos', { name })
    await this._db.flush()

    try {
      const remote = this._remotes.get(name)
      if (remote) {
        this._remotes.delete(name)
        await remote.close()
      }

      // Tear down the swarm session for this core. _joined.get returns the
      // entry created by _joinCore — without destroying its discovery we'd
      // still be announcing the topic after delete, and we'd hand back a dead
      // entry on the next `_joinCore(sameKey)` call. Closing the core session
      // matters too: blind-peering drops its local reference on core 'close',
      // so leaving it open keeps us feeding a repo the user just deleted.
      const hex = b4a.toString(repo.key, 'hex')
      const opening = this._joined.get(hex)
      if (opening) {
        this._joined.delete(hex)
        const { core, discovery } = await opening
        if (discovery) await discovery.destroy()
        await core.close()
      }

      await this._clearCore(repo.key)
    } catch {
      // The repo is gone as far as callers are concerned. Reporting a failure
      // here would only tell the user their delete didn't work when it did.
    }

    return true
  }

  /**
   * Drop the blocks of a core nothing tracks any more.
   *
   * This is the only step that frees disk for repos we cloned — openRemote
   * downloads those in full, so they're the bulk of the store. clear() is a
   * local block drop: it needs no write capability and doesn't touch the log,
   * so it behaves the same on cores we own and cores we don't.
   *
   * We deliberately do NOT truncate. Truncate is an append — it bumps the fork
   * on a key our blind peers and every clone already mirror, so a deleted repo
   * would read to them as a forked core rather than a gone one. A repo's key
   * retires with the repo; `createRemote` mints a fresh one.
   */
  async _clearCore(key) {
    const core = this._store.get({ key })
    try {
      await core.ready()
      if (core.length > 0) await core.clear(0, core.length)
    } finally {
      await core.close()
    }
  }

  get swarm() {
    return this._swarm
  }

  get blind() {
    return this._blind
  }

  async getPublicKey() {
    return this._keyPair.publicKey
  }

  async _open() {
    this._keyPair = await this._store.createKeyPair('gip')
    this._swarm =
      this._externalSwarm ||
      new Hyperswarm({
        dht: new HyperDHT({
          keyPair: this._keyPair
        })
      })

    this._db = HyperDB.bee(this._store.get({ name: 'db' }), def)
    await this._db.ready()

    // Cache the seed-read-only setting up front so _joinCore can read it
    // synchronously.
    const config = await this.getConfig()
    this._seedReadOnly = config.seedReadOnly

    if (!this._externalSwarm) {
      const blindPeers = config.blindPeers || []

      if (blindPeers.length > 0) {
        this._wakeup = new Wakeup()
        this._blind = new BlindPeering(this._swarm.dht, this._store, {
          wakeup: this._wakeup,
          keys: blindPeers
        })
      }
    }

    this._swarm.on('connection', (conn) => {
      this._store.replicate(conn)
      if (this._wakeup) this._wakeup.addStream(conn)

      this.emit('connection', conn)
    })
  }

  async _close() {
    if (this._blind) await this._blind.close()
    if (this._swarm) await this._swarm.destroy()
    if (this._db) await this._db.close()
    for (const remote of this._remotes.values()) {
      await remote.close()
    }
    await this._store.close()
  }
}

module.exports = {
  GipLocalDB
}
