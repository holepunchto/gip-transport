#!/usr/bin/env node
const process = require('process')
const goodbye = require('graceful-goodbye')
const readline = require('readline')
const { isBare } = require('which-runtime')
const { Gip } = require('./lib/gip.js')
const stdout = require('./lib/stdout')

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

const capabilities = () => {
  stdout.write('option\nfetch\npush\nlist\n\n')
}

function makePear(dir) {
  if (!isBare) return null
  const Pear = require('./lib/pear')
  return new Pear({ dir })
}

const main = async () => {
  const params = new URL(config.link).searchParams
  const dir = params.get('storage')

  const gip = new Gip({
    remote,
    dir,
    bootstrap: process.env.GIP_BOOTSTRAP?.split(','),
    ...config
  })

  goodbye(async () => {
    await gip.close()
  })

  const pear = process.env.GIP_NO_UPDATES ? null : makePear(dir)
  if (pear !== null) {
    pear.on('error', () => {})
    pear.ready().catch(() => {})
  }

  // Opening starts while git is still sending options; the first command to need it awaits it.
  gip.ready().catch(() => {})

  // bare-readline does not end with its input, and git hanging up is all a helper is told.
  const rl = readline.createInterface({ input: process.stdin })
  process.stdin.on('end', () => rl.close())
  let code = 0

  try {
    // Git ends a session by closing stdin, or with a blank line when no batch is open.
    session: for await (const line of rl) {
      const [command, ...args] = line.split(' ')
      gip._verbose('Line: ' + line)

      switch (command) {
        case 'capabilities':
          capabilities()
          break
        case 'option':
          stdout.write(gip.setOption(args[0], args.slice(1).join(' ')) + '\n')
          break
        case 'list':
          await gip.connect()
          await gip.list(args[0] === 'for-push')
          break
        case 'push':
          gip.addPush(args[0])
          break
        case 'fetch':
          gip.addFetch(args[0], args[1])
          break
        case '':
          if (gip.hasPendingFetch()) {
            await gip.connect()
            await gip.fetch()
          } else if (gip.hasPendingPush()) {
            await gip.connect()
            gip._debug('pushing')
            await gip.push()
          } else {
            break session
          }
          break
        default:
          console.error('Unexpected message:', line)
      }
    }
  } catch (e) {
    console.error(e.message)
    code = 1
  } finally {
    gip._debug('Closing gip')
    // close() would wait for an open still in flight, and that can be a download git no
    // longer wants. Exiting is what releases the store then.
    if (gip.opened) await gip.close()
    if (pear !== null) await pear.close()
    process.exit(code)
  }
}

main()
