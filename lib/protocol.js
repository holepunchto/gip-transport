const readline = require('readline')

module.exports = async function serve(gip, { input, write, writeErr }) {
  const rl = readline.createInterface({ input })
  input.on('end', () => rl.close())

  let code = 0

  try {
    session: for await (const line of rl) {
      const [command, ...args] = line.split(' ')
      gip._verbose('Line: ' + line)

      switch (command) {
        case 'capabilities':
          write('option\nfetch\npush\nlist\n\n')
          break
        case 'option':
          write(gip.setOption(args[0], args.slice(1).join(' ')) + '\n')
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
          writeErr(`Unexpected message: ${line}\n`)
      }
    }
  } catch (e) {
    writeErr(`${e.message}\n`)
    code = 1
  }

  return code
}
