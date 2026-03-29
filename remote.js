const goodbye = require('graceful-goodbye')
const process = require('process')
const { Gip } = require('./lib/gip.js')

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

async function * readLines () {
  let buffer = ''
  for await (const chunk of process.stdin) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString()
    let idx
    while ((idx = buffer.indexOf('\n')) !== -1) {
      yield buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
    }
  }
  if (buffer) yield buffer
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

  gip._progressReporter.connecting()
  await gip.ready()
  gip._progressReporter.connected(gip.remote)

  try {
    for await (const line of readLines()) {
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
          }
          return
        }
        default:
          console.error('Unexpected message:', line)
      }
    }
  } finally {
    gip._debug('Closing gip')
    await gip.close()
    process.exit(0)
  }
}

main()
