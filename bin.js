#!/usr/bin/env bare

const goodbye = require('graceful-goodbye')
const process = require('process')
const readline = require('readline')
const { Gip } = require('./lib/gip.js')

const ignorePipeError = (err) => {
  if (err.code !== 'ESPIPE' && err.code !== 'EPIPE') throw err
}
if (process.stdin.on) process.stdin.on('error', ignorePipeError)
if (process.stdout.on) process.stdout.on('error', ignorePipeError)

const argv = process.argv.slice(0)
// args[0] == node
// args[1] == git-remote-gip location
// args[2] == remote name
// args[3] == url
let remote = argv[2]
let url = argv[3]

if (!url) {
  console.error('Remote url required')
  process.exit(1)
}

let config = {}
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
  process.stdout.write('option\nfetch\npush\nlist\n\n')
}

const main = async () => {
  const gip = new Gip({
    remote,
    ...config
  })

  goodbye(async () => {
    await gip.close()
  })

  gip.setProgress(true)
  gip.ready()

  const rl = readline.createInterface({ input: process.stdin })

  try {
    for await (const line of rl) {
      if (!gip.opened) await gip.ready()

      const command = line.split(' ')[0]
      gip._verbose('Line: ' + line)

      switch (command) {
        case 'capabilities':
          capabilities()
          break
        case 'option':
          {
            const option = line.split(' ')[1]
            switch (option) {
              case 'verbosity':
                gip.setVerbosity(line.split(' ')[2])
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
            await gip.listAndStoreRefs()
          } else {
            await gip.listForPush()
          }
          break
        }
        case 'push': {
          const ref = line.split(' ')[1]
          await gip.addPushRefs(ref)
          break
        }
        case 'fetch': {
          gip.prepareFetch(line.replace('fetch ', ''))
          break
        }
        case '': {
          if (gip.hasPendingFetch()) {
            await gip.fetch()
          } else {
            gip._debug('pushing')
            await gip.push()
            gip._progressReporter.reportInfo(`Latest: ${gip.remote.url}`)
          }
          return
        }
        default:
          console.error('Unexpected message:', line)
      }
    }
  } catch (e) {
    console.error(e.message)
  } finally {
    gip._debug('Closing gip')
    await gip.close()
    process.exit(0)
  }
}

main()
