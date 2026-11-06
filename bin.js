#!/usr/bin/env node
const process = require('process')
const fs = require('fs')
const goodbye = require('graceful-goodbye')
const readline = require('readline')
const { isBare } = require('which-runtime')
const { Gip } = require('./lib/gip.js')

// GIP_TRACE=<file> appends a timestamped trace of this process. Written synchronously and
// to a file rather than stderr so that it survives a hang, a kill, and a full stdio pipe.
const TRACE = process.env.GIP_TRACE || null
const started = Date.now()
const trace = TRACE
  ? (message) => {
      try {
        fs.appendFileSync(TRACE, `+${Date.now() - started}ms [${process.pid}] ${message}\n`)
      } catch {}
    }
  : () => {}

let step = 'boot'
const at = (name) => {
  step = name
  trace(name)
}

if (TRACE) {
  // Says "the process is alive and stuck here", which is what distinguishes a hang from a
  // crash. Unref'd so it never delays exit on its own.
  const beat = setInterval(() => trace(`alive, last step: ${step}`), 2000)
  beat.unref?.()
}

const ignorePipeError = (err) => {
  if (err.code !== 'ESPIPE' && err.code !== 'EPIPE') throw err
}
if (process.stdin.on) process.stdin.on('error', ignorePipeError)
if (process.stdout.on) process.stdout.on('error', ignorePipeError)

const argv = process.argv.slice(0)
const remote = argv[2]
let url = argv[3]

if (!url) {
  console.error('Remote url required')
  process.exit(1)
}

const config = {}
try {
  if (!url.includes('git+pear://')) {
    const urlIdx = argv.findIndex((arg) => arg.startsWith('git+pear://'))
    url = argv[urlIdx]

    if (!url) {
      console.error('Remote url could not be found in args')
      process.exit(1)
    }
  }

  config.link = url
} catch (error) {
  throw new Error(`Invalid remote url: ${url}: ${error.message}`)
}

// git sends `option verbosity` itself, so this has to win over it to be any use.
const forcedVerbosity = process.env.GIP_VERBOSITY ? Number(process.env.GIP_VERBOSITY) : null

const capabilities = () => {
  process.stdout.write('option\nfetch\npush\nlist\n\n')
}

function makePear(dir) {
  if (!isBare) return null
  const Pear = require('./lib/pear')
  return new Pear({ dir })
}

const main = async () => {
  at(`main, argv=${JSON.stringify(argv.slice(2))}`)
  const params = new URL(config.link).searchParams
  const dir = params.get('storage')
  at(`parsed url, storage=${JSON.stringify(dir)}`)

  const gip = new Gip({
    remote,
    dir,
    ...config
  })
  at('gip constructed')

  goodbye(async () => {
    await gip.close()
  })

  const pear = process.env.GIP_NO_UPDATES ? null : makePear(dir)
  at(`pear ${pear === null ? 'disabled' : 'created'}`)
  if (pear !== null) {
    pear.on('error', (err) => trace(`pear error: ${err.message}`))
    pear.ready().then(
      () => trace('pear ready'),
      (err) => trace(`pear ready failed: ${err.message}`)
    )
  }

  gip.setProgress(true)
  if (forcedVerbosity !== null) gip.setVerbosity(forcedVerbosity)
  gip.ready().then(
    () => trace('gip ready resolved'),
    (err) => trace(`gip ready rejected: ${err.message}`)
  )

  const rl = readline.createInterface({ input: process.stdin })
  at('readline attached, waiting for first line')

  try {
    for await (const line of rl) {
      at(`line in: ${JSON.stringify(line)}`)
      if (!gip.opened) {
        at('awaiting gip.ready')
        await gip.ready()
        at('gip.ready done')
      }

      const command = line.split(' ')[0]
      gip._verbose('Line: ' + line)
      at(`cmd begin: ${command}`)

      switch (command) {
        case 'capabilities':
          capabilities()
          break
        case 'option':
          {
            const option = line.split(' ')[1]
            switch (option) {
              case 'verbosity':
                gip.setVerbosity(forcedVerbosity ?? line.split(' ')[2])
                break
              case 'progress':
                gip.setProgress(line.split(' ')[2] === 'true')
                break
              case 'cloning':
                gip.setCloning(line.split(' ')[2] === 'true')
                break
              case 'followtags':
                gip.setFollowTags(line.split(' ')[2] === 'true')
                break
            }
            process.stdout.write('ok\n')
          }
          break
        case 'list': {
          if (line === 'list') {
            at('listAndStoreRefs begin')
            await gip.listAndStoreRefs()
            at('listAndStoreRefs end')
          } else {
            at('listForPush begin')
            await gip.listForPush()
            at('listForPush end')
          }
          break
        }
        case 'push': {
          const ref = line.split(' ')[1]
          at(`addPushRefs begin: ${ref}`)
          await gip.addPushRefs(ref)
          at('addPushRefs end')
          break
        }
        case 'fetch': {
          gip.prepareFetch(line.replace('fetch ', ''))
          break
        }
        case '': {
          if (gip.hasPendingFetch()) {
            at('fetch begin')
            await gip.fetch()
            at('fetch end')
          } else {
            gip._debug('pushing')
            at('push begin')
            await gip.push()
            at('push end')
            gip._progressReporter.reportInfo(`Latest: ${gip.remote.url}`)
          }
          at('terminator, leaving loop')
          return
        }
        default:
          console.error('Unexpected message:', line)
      }
      at(`cmd end: ${command}`)
    }
    at('stdin ended, loop finished')
  } catch (e) {
    at(`threw: ${e.message}`)
    console.error(e.message)
  } finally {
    gip._debug('Closing gip')
    at('gip.close begin')
    await gip.close()
    at('gip.close end')
    if (pear !== null) await pear.close()
    at('pear closed, exiting 0')
    process.exit(0)
  }
}

main()
