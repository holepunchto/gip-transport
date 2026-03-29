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
const { Remote } = require('gip-remote')
const HyperDHT = require('hyperdht')

class GipLocalDB extends ReadyResource {
  _swarm = null
  _store = null
  _wakeup = null
  _identity = null
  _db = null
  _remotes = new Map()

  constructor(args = {}) {
    super()

    this._store = args.store || new Corestore(join(homedir(), '.gip'))
    this._externalSwarm = args.swarm || null
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

  // --- Remotes ---

  async _createRemote(link) {
    const remote = new Remote(this._store, link, { blind: this._blind })
    await remote.ready()
    this._swarm.join(remote.discoveryKey)
    if (this._blind) await this._blind.addCore(remote.core, remote.core.key, { announce: true })
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

    for await (const repo of knownRepos) {
      const remote = await this._createRemote({ name: repo.name, key: repo.key })
      this._remotes.set(repo.name, remote)
    }

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

  async openRemote(link) {
    const remote = await this._createRemote(link)
    const name = remote.name

    // Non-writable cores need peers to read/replicate
    if (!remote.core.writable && remote.availablePeers === 0) {
      await this._swarm.flush()
      await remote.waitForPeers()
      await remote.core.update()
    }

    const existing = await this._db.get('@gip/repos', { name })
    if (existing) return remote

    // New remote — persist
    await this._db.insert('@gip/repos', {
      name,
      key: remote.key
    })

    await this._db.flush()

    this._remotes.set(name, remote)

    return remote
  }

  async getRepo(name) {
    const repo = await this._db.get('@gip/repos', { name })
    if (!repo) return null

    const remote = await this._createRemote({ name: repo.name, key: repo.key })
    return remote
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

    if (!this._externalSwarm) {
      const config = await this.getConfig()
      const blindPeers = config.blindPeers || []

      if (blindPeers.length > 0) {
        this._wakeup = new Wakeup()
        this._blind = new BlindPeering(this._swarm, this._store, {
          wakeup: this._wakeup,
          mirrors: blindPeers
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
