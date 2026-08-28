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
  _seedReadOnly = true // cached from config at open
  _blind = null
  _externalSwarm = null
  _keyPair = null

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

  // Defaults live here because every writer spreads this result.
  async getConfig() {
    const record = await this._db.get('@gip/config', {})
    if (!record) return { blindPeers: [], seedReadOnly: true }
    return record
  }

  async setConfig(config) {
    await this._db.insert('@gip/config', config)
    await this._db.flush()
  }

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

  namespace(name) {
    return this._store.namespace(name)
  }

  async getSeedReadOnly() {
    const config = await this.getConfig()
    return config.seedReadOnly
  }

  async setSeedReadOnly(enabled) {
    const value = !!enabled
    const config = await this.getConfig()
    await this.setConfig({ ...config, seedReadOnly: value })
    this._seedReadOnly = value

    // refresh() mutates the session in place; swarm.join would add a second, still-announcing one.
    if (this._swarm) {
      for (const opening of this._joined.values()) {
        const { core, discovery } = await opening
        if (core.writable || !discovery) continue
        discovery.refresh({ server: value, client: true }).catch(() => {})
        if (value) discovery.flushed().catch(() => {})
      }
    }
  }

  async _joinCore(key, opts = {}) {
    const hex = b4a.toString(key, 'hex')
    let opening = this._joined.get(hex)

    if (!opening) {
      opening = this._openCore(key)
      this._joined.set(hex, opening)
    }

    const entry = await opening
    const { core } = entry

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
      // Only when the flags widen — refresh is a DHT round-trip and hot routes call this per repo.
      entry.discovery.refresh({ server, client }).catch(() => {})
    }

    return entry
  }

  async _openCore(key) {
    const core = this._store.get({ key })
    await core.ready()
    return { core, discovery: null }
  }

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

  // Own namespace per repo: corestore derives keys from (primaryKey, namespace, name), so a
  // reused name never resurrects a deleted repo's key.
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

  async addRemote(link, opts = {}) {
    const { name } = this._parseLink(link)
    const existing = await this._db.get('@gip/repos', { name })
    const remote = await this.openRemote(link, opts)
    return { name, key: remote.key, remote, isNew: !existing }
  }

  async openRemote(link, { blind, blindPeerKeys } = {}) {
    if (!blind) {
      if (blindPeerKeys?.length) this._addBlindPeerKeys(blindPeerKeys)
      blind = this._blind
    }
    const { key, name } = this._parseLink(link)

    // Sync-only session — _joinCore and the Remote each keep their own.
    const core = this._store.get({ key })
    let remote = null
    try {
      await core.ready()

      if (core.writable) {
        await this._joinCore(key)
      } else {
        // A guard, not a barrier: update() returns as soon as any peer can upgrade us.
        const found = core.findingPeers()
        this._joinCore(key)
          .then(() => this._swarm.flush())
          .then(found, found)

        await core.update({ wait: true })

        if (core.length > 0) {
          await core.download({ start: 0, end: core.length }).done()
        }
      }

      // Session, not the store: a Remote closes whatever store it was given.
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

  // The record is the only durable state — drop it first, then tear down best-effort.
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

      // Otherwise we keep announcing, and blind-peering keeps feeding, a deleted repo.
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
      // The row is gone, so the delete succeeded as far as the caller is concerned.
    }

    return true
  }

  // clear(), never truncate: truncate is an append, forking a key that peers already mirror.
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

    // Cached so _joinCore can read it synchronously.
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
      // A handshake still in flight when close() lands would replicate into a closed store.
      if (this.closing) return conn.destroy()

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
