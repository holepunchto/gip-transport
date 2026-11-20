#!/usr/bin/env node
const process = require('process')
const path = require('path')
const os = require('os')
const goodbye = require('graceful-goodbye')
const serve = require('./lib/protocol')
const { attach, isLockError } = require('./lib/socket')
const { GipLocalDB } = require('./lib/db')
const { isBare } = require('which-runtime')
const { Gip } = require('./lib/gip.js')
const stdout = require('./lib/stdout')
const parseArgs = require('./lib/args')

const ignorePipeError = (err) => {
  if (err.code !== 'ESPIPE' && err.code !== 'EPIPE') throw err
}
if (process.stdin.on) process.stdin.on('error', ignorePipeError)
if (process.stdout.on) process.stdout.on('error', ignorePipeError)

const args = parseArgs(process.argv)

if (!args) {
  console.error('Remote url required')
  process.exit(1)
}

const { remote } = args
const config = { link: args.url }

function makePear(dir) {
  if (!isBare) return null
  const Pear = require('./lib/pear')
  return new Pear({ dir })
}

const LOCK_TIMEOUT = 120000
const LOCK_RETRY = 50

// Take the store, or hand the session to whoever has it. The open is what decides: two helpers
// starting together both see a free lock, so asking first and opening second loses the race.
// A held lock is also not yet a socket to connect to, so attaching is retried while it stays
// held rather than giving up after one try.
const claim = async (dir) => {
  const bootstrap = process.env.GIP_BOOTSTRAP?.split(',')
  const deadline = Date.now() + LOCK_TIMEOUT

  while (true) {
    const db = new GipLocalDB({ dir, bootstrap })

    try {
      await db.ready()
      return db
    } catch (err) {
      await db.close().catch(() => {})
      if (!isLockError(err)) throw err

      try {
        process.exit(
          await attach(dir, {
            remote,
            link: config.link,
            gitDir: process.env.GIT_DIR ? path.resolve(process.cwd(), process.env.GIT_DIR) : '',
            cwd: process.cwd(),
            input: process.stdin,
            write: stdout.write,
            writeErr: (text) => process.stderr.write(text)
          })
        )
      } catch {
        if (Date.now() >= deadline) throw err
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY))
      }
    }
  }
}

const main = async () => {
  const params = new URL(config.link).searchParams
  const dir = params.get('storage') || path.join(os.homedir(), '.gip')

  const db = await claim(dir)

  const gip = new Gip({
    remote,
    db,
    ...config
  })

  goodbye(async () => {
    await gip.close()
    await db.close().catch(() => {})
  })

  const pear = process.env.GIP_NO_UPDATES ? null : makePear(dir)
  if (pear !== null) {
    pear.on('error', () => {})
    pear.ready().catch(() => {})
  }

  // Opening starts while git is still sending options; the first command to need it awaits it.
  gip.ready().catch(() => {})

  let code = 0

  try {
    code = await serve(gip, {
      input: process.stdin,
      write: stdout.write,
      writeErr: (text) => process.stderr.write(text)
    })
  } catch (e) {
    console.error(e.message)
    code = 1
  } finally {
    gip._debug('Closing gip')
    // close() would wait for an open still in flight, and that can be a download git no
    // longer wants. Exiting is what releases the store then.
    if (gip.opened) await gip.close()
    // The store is ours, and another helper may be running its session through us. Closing it
    // waits for those to finish; exiting first would strand them.
    await db.close().catch(() => {})
    if (pear !== null) await pear.close()
    process.exit(code)
  }
}

main()
