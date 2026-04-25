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
  _seedReadOnly = true // cached from config at open; defaults ON

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

  async getConfig() {
    const record = await this._db.get('@gip/config', {})
    if (!record) return { blindPeers: [] }
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

  // --- Seed read-only ---

  /**
   * Whether we act as a server on the swarm for cores we don't own.
   * Default is true so other peers can find us and pull blocks we already
   * have — phones become reseeders for repos they've cloned.
   */
  async getSeedReadOnly() {
    const config = await this.getConfig()
    // Treat "unset" (undefined) as the default ON. Only an explicit `false`
    // turns it off.
    return config.seedReadOnly !== false
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
      for (const { core, discovery } of this._joined.values()) {
        if (core.writable) continue
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
   * HyperDB is opened. Seeders need only this. Cached by key, so repeated
   * calls for the same core are no-ops.
   *
   * Returns { core, discovery }.
   */
  async _joinCore(key, opts = {}) {
    const hex = b4a.toString(key, 'hex')
    const existing = this._joined.get(hex)
    if (existing) return existing

    const core = this._store.get({ key })
    await core.ready()

    // Default server flag:
    //   - writable cores: always announce — we're the source of truth.
    //   - read-only cores: announce only if seedReadOnly is on (default ON).
    //     This is what makes devices-with-the-app-open into reseeders for
    //     repos they've cloned, without requiring a dedicated server.
    const server = opts.server ?? (core.writable || this._seedReadOnly)
    const client = opts.client ?? !core.writable

    const discovery = this._swarm.join(core.discoveryKey, { server, client })

    if (this._blind) {
      this._blind.resume()
      this._blind.addCoreBackground(core, { announce: true, mirrors: 2 })
    }

    const entry = { core, discovery }
    this._joined.set(hex, entry)
    return entry
  }

  /**
   * Wait until a connection reports our specific discovery topic.
   *
   * peerInfo.topics is populated for client-side connections via _handlePeer
   * BEFORE the 'connection' event fires — we catch that with the sync check().
   * For server-side connections, topics arrive later via 'topic' events — we
   * subscribe to catch those too.
   *
   * IMPORTANT: the 'connection' listener must be registered BEFORE swarm.join
   * so no connection event can be missed.
   */
  _waitForTopicPeer(discoveryKey) {
    return new Promise((resolve) => {
      const onConn = (conn, peerInfo) => {
        const check = () => {
          if (peerInfo.topics.some((t) => b4a.equals(t, discoveryKey))) {
            this._swarm.removeListener('connection', onConn)
            resolve(peerInfo)
          }
        }
        check()
        peerInfo.on('topic', check)
      }
      this._swarm.on('connection', onConn)
    })
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
  async _createRemote(link) {
    const remote = new Remote(this._store, link, { blind: this._blind })
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

  async createRemote(name) {
    const remote = await this._createRemote(name)

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
  async addRemote(link) {
    const { name } = this._parseLink(link)
    const existing = await this._db.get('@gip/repos', { name })
    const remote = await this.openRemote(link)
    return { name, key: remote.key, remote, isNew: !existing }
  }

  /**
   * Open a Remote for reading — used by git clone/fetch/push.
   *
   * Robust data flow for leechers (non-writable cores):
   *   1. Open core + join swarm (Layer 1: _joinCore)
   *   2. Register topic listener, then wait for a peer that announces OUR
   *      specific discovery topic. swarm.flush() alone is not enough — it can
   *      resolve via unrelated peers and leave us without a matching one.
   *   3. core.update({ wait: true }) — learn the peer's length + verify head
   *   4. core.download({ start: 0, end: core.length }).done() — pull ALL blocks
   *   5. Only NOW open Remote / Hyperbee — every read is served from local
   *      storage, so no lazy round-trip fetches during git iteration.
   *
   * Writable cores skip the sync — we're the source of truth.
   */
  async openRemote(link) {
    const { key, name } = this._parseLink(link)

    // Open the core up-front so we can derive discoveryKey, and register the
    // topic listener BEFORE the swarm.join inside _joinCore. Otherwise a
    // seeder that's already running could fire a connection event between
    // swarm.join and our subscription.
    const core = this._store.get({ key })
    await core.ready()

    let connected = null
    if (!core.writable) {
      connected = this._waitForTopicPeer(core.discoveryKey)
    }

    await this._joinCore(key)

    if (!core.writable) {
      await this._swarm.flush()
      await connected

      await core.update({ wait: true })

      if (core.length > 0) {
        await core.download({ start: 0, end: core.length }).done()
      }
    }

    // Core is fully populated locally — Hyperbee reads all blocks from disk.
    const remote = new Remote(this._store, { name, key }, { blind: this._blind })
    await remote.ready()

    const existing = await this._db.get('@gip/repos', { name })
    if (!existing) {
      await this._db.insert('@gip/repos', { name, key })
      await this._db.flush()
    }

    this._remotes.set(name, remote)
    return remote
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
   * Returns { name, key, core } or null.
   */
  async getCore(name, opts = { server: true, client: false }) {
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

  async deleteRemote(name) {
    const repo = await this._db.get('@gip/repos', { name })
    if (!repo) return false

    const remote = this._remotes.get(name)
    if (remote) {
      await remote.close()
      this._remotes.delete(name)
    }

    await this._db.delete('@gip/repos', { name })
    await this._db.flush()
    return true
  }

  get swarm() {
    return this._swarm
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
    // synchronously. Default to ON when the field is unset.
    const config = await this.getConfig()
    this._seedReadOnly = config.seedReadOnly !== false

    if (!this._externalSwarm) {
      const blindPeers = [
        ...(config.blindPeers || []),
        Id.decode('9mht63egrgxsumbsnftx89cntxopco9sopy98inubcweqz71fpby'), // holepunch
        Id.decode('tbtdorenxdtwh8ppnhhswa7ua5kc3g45341mzdcaic6jg647xr3y') // holepunch
      ]

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
