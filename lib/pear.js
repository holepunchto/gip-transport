const os = require('os')
const path = require('path')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const PearRuntime = require('pear-runtime')
const ReadyResource = require('ready-resource')
const { isWindows } = require('which-runtime')
const { dev, binary } = require('./runtime')
const pkg = require('../package.json')

const appName = pkg.productName || pkg.name

const name = dev ? (isWindows ? appName + '.exe' : appName) : path.basename(binary)

class Pear extends ReadyResource {
  constructor(opts = {}) {
    super()

    this.dir = opts.dir || path.join(os.homedir(), '.gip')
    this.updates = opts.updates !== false

    this.store = null
    this.swarm = null
    this.pear = null
  }

  _open() {
    const store = new Corestore(path.join(this.dir, 'pear-runtime', 'corestore'))
    const swarm = new Hyperswarm()

    this.store = store
    this.swarm = swarm

    const pear = new PearRuntime({
      dir: this.dir,
      app: binary,
      updates: this.updates,
      version: pkg.version,
      upgrade: pkg.upgrade,
      name,
      store,
      swarm
    })

    this.pear = pear

    pear.on('error', (err) => this.emit('error', err))
    pear.updater.on('error', (err) => this.emit('error', err))

    if (this.updates === false) return

    pear.updater.on('updating', () => this.emit('updating'))
    pear.updater.on('updating-delta', (delta) => this.emit('updating-delta', delta))
    pear.updater.on('updated', () => this._applyUpdate())

    swarm.on('connection', (connection) => store.replicate(connection))
    swarm.join(pear.updater.drive.core.discoveryKey, {
      client: true,
      server: false
    })
  }

  async _close() {
    const store = this.store
    const swarm = this.swarm
    const pear = this.pear

    this.store = null
    this.swarm = null
    this.pear = null

    await swarm?.destroy()
    await pear?.close()
    await store?.close()
  }

  async _applyUpdate() {
    this.emit('updated')
    const pear = this.pear
    if (pear === null) return

    try {
      await pear.updater.applyUpdate()
      this.emit('update-applied')
    } catch (err) {
      this.emit('error', err)
    }
  }
}

module.exports = Pear
