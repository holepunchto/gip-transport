const path = require('path')
const fs = require('fs')
const net = require('net')
const process = require('process')
const b4a = require('b4a')
const fsx = require('fs-native-extensions')
const Protomux = require('protomux')
const SecretStream = require('@hyperswarm/secret-stream')
const c = require('compact-encoding')
const { Readable } = require('streamx')
const pipeId = require('./pipe-id')

const isWindows = process.platform === 'win32'

const LOCK_FILE = 'CORESTORE'

const IPC_ID = path.basename(LOCK_FILE, path.extname(LOCK_FILE))

const PROTOCOL = 'gip/helper/1'

const DRAIN_TIMEOUT = 120000

function noop() {}

function socketPath(dir) {
  return isWindows
    ? `\\\\.\\pipe\\${IPC_ID}-${pipeId(path.resolve(dir))}`
    : path.join(dir, `${IPC_ID}.sock`)
}

function isLockError(err) {
  return /could not be locked/i.test(err.message)
}

function isLocked(dir) {
  let fd = -1

  try {
    fd = fs.openSync(path.join(dir, LOCK_FILE), 'r+')
  } catch {
    return false
  }

  try {
    if (!fsx.tryLock(fd)) return true
    fsx.unlock(fd)
    return false
  } catch {
    return false
  } finally {
    fs.closeSync(fd)
  }
}

const handshakeEncoding = {
  preencode(state, m) {
    c.string.preencode(state, m.remote)
    c.string.preencode(state, m.link)
    c.string.preencode(state, m.gitDir)
    c.string.preencode(state, m.cwd)
  },
  encode(state, m) {
    c.string.encode(state, m.remote)
    c.string.encode(state, m.link)
    c.string.encode(state, m.gitDir)
    c.string.encode(state, m.cwd)
  },
  decode(state) {
    return {
      remote: c.string.decode(state),
      link: c.string.decode(state),
      gitDir: c.string.decode(state),
      cwd: c.string.decode(state)
    }
  }
}

function wire(mux, handlers = {}) {
  const channel = mux.createChannel({
    protocol: PROTOCOL,
    onclose: handlers.onclose || noop
  })

  if (channel === null) return null

  const messages = {
    handshake: channel.addMessage({
      encoding: handshakeEncoding,
      onmessage: handlers.onhandshake || noop
    }),
    in: channel.addMessage({ encoding: c.buffer, onmessage: handlers.onin || noop }),
    inEnd: channel.addMessage({ encoding: c.none, onmessage: handlers.oninend || noop }),
    out: channel.addMessage({ encoding: c.buffer, onmessage: handlers.onout || noop }),
    err: channel.addMessage({ encoding: c.buffer, onmessage: handlers.onerr || noop }),
    exit: channel.addMessage({ encoding: c.uint, onmessage: handlers.onexit || noop })
  }

  channel.open()

  return { channel, messages }
}

class HelperServer {
  constructor(db, dir) {
    this.db = db
    this.dir = dir
    this.path = socketPath(dir)
    this.server = null
    this.connections = new Set()
  }

  async listen() {
    if (!isWindows) await fs.promises.unlink(this.path).catch(noop)

    const server = net.createServer((socket) => this._onconnection(socket))

    await new Promise((resolve, reject) => {
      const onerror = (err) => reject(err)
      server.once('error', onerror)
      server.listen(this.path, () => {
        server.removeListener('error', onerror)
        resolve()
      })
    })

    server.on('error', noop)
    this.server = server

    if (!isWindows) await fs.promises.chmod(this.path, 0o600).catch(noop)
  }

  async close() {
    if (this.server) {
      const server = this.server
      this.server = null

      let timer = null
      const drained = new Promise((resolve) => server.close(resolve))
      const gaveUp = new Promise((resolve) => {
        timer = setTimeout(resolve, DRAIN_TIMEOUT)
      })

      await Promise.race([drained, gaveUp])
      clearTimeout(timer)

      for (const stream of this.connections) stream.destroy()
      this.connections.clear()

      if (!isWindows) await fs.promises.unlink(this.path).catch(noop)
    }
  }

  _onconnection(socket) {
    const stream = new SecretStream(false, socket)
    stream.on('error', noop)

    this.connections.add(stream)
    stream.once('close', () => this.connections.delete(stream))

    const mux = Protomux.from(stream)
    const input = new Readable()

    let started = false
    let wired = null

    wired = wire(mux, {
      onhandshake: (handshake) => {
        if (started) return
        started = true
        this._session({ ...handshake, input, messages: wired.messages, stream })
      },
      onin: (chunk) => {
        if (chunk) input.push(chunk)
      },
      oninend: () => input.push(null),
      onclose: () => input.push(null)
    })
  }

  async _session({ remote, link, gitDir, cwd, input, messages, stream }) {
    const { Gip } = require('./gip')
    const serve = require('./protocol')

    const write = (text) => messages.out.send(b4a.from(text))
    const writeErr = (text) => messages.err.send(b4a.from(text))

    const gip = new Gip({
      remote,
      link,
      db: this.db,
      write,
      writeErr,
      gitDir: gitDir || null,
      cwd: cwd || undefined
    })

    let code = 0

    try {
      gip.ready().catch(noop)
      code = await serve(gip, { input, write, writeErr })
    } catch (err) {
      writeErr(`${err.message}\n`)
      code = 1
    } finally {
      if (gip.opened) await gip.close().catch(noop)
      messages.exit.send(code)
      stream.end()
    }
  }
}

async function attach(dir, { remote, link, gitDir, cwd, input, write, writeErr }) {
  const socket = net.connect(socketPath(dir))

  await new Promise((resolve, reject) => {
    const onerror = (err) => {
      socket.removeListener('connect', onconnect)
      reject(err)
    }
    const onconnect = () => {
      socket.removeListener('error', onerror)
      resolve()
    }
    socket.once('error', onerror)
    socket.once('connect', onconnect)
  })

  const stream = new SecretStream(true, socket)
  stream.on('error', noop)

  const mux = Protomux.from(stream)

  let code = null
  let settle = null
  const finished = new Promise((resolve) => {
    settle = resolve
  })

  let wrote = false

  const wired = wire(mux, {
    onout: (chunk) => {
      wrote = true
      write(b4a.toString(chunk))
    },
    onerr: (chunk) => writeErr(b4a.toString(chunk)),
    onexit: (value) => {
      code = value
      settle()
    },
    onclose: () => settle()
  })

  stream.once('close', () => settle())

  wired.messages.handshake.send({
    remote,
    link,
    gitDir: gitDir || '',
    cwd: cwd || ''
  })

  input.on('data', (chunk) => wired.messages.in.send(chunk))
  input.on('end', () => wired.messages.inEnd.send(null))

  await finished

  stream.destroy()

  if (code === null) {
    if (!wrote) {
      const err = new Error('sockstore host went away')
      err.retryable = true
      throw err
    }

    writeErr('gip: the process holding the store went away\n')
    return 1
  }

  return code
}

module.exports = {
  socketPath,
  isLocked,
  isLockError,
  attach,
  HelperServer,
  LOCK_FILE
}
