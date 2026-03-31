const process = require('process')

function createStdinLineReader () {
  let buffer = ''
  let waiting = null
  let ended = false

  function drain () {
    // Pull all available data from the stream
    let chunk
    while ((chunk = process.stdin.read()) !== null) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString()
    }
  }

  function notify () {
    if (waiting) {
      const resolve = waiting
      waiting = null
      resolve()
    }
  }

  process.stdin.on('readable', () => {
    drain()
    notify()
  })

  process.stdin.on('end', () => {
    ended = true
    notify()
  })

  return function readLine () {
    return new Promise((resolve) => {
      const tryLine = () => {
        drain()
        const idx = buffer.indexOf('\n')
        if (idx !== -1) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          return resolve(line.replace(/\r$/, ''))
        }
        if (ended) {
          return resolve(buffer.length > 0 ? buffer : null)
        }
        return false
      }

      if (tryLine() !== false) return

      waiting = () => {
        if (tryLine() === false && ended) {
          resolve(buffer.length > 0 ? buffer : null)
        }
      }
    })
  }
}

module.exports = { createStdinLineReader }
