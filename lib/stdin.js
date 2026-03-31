const process = require('process')

function createStdinLineReader () {
  let buffer = ''
  let waiting = null

  process.stdin.on('data', (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString()
    if (waiting) {
      const resolve = waiting
      waiting = null
      resolve()
    }
  })

  process.stdin.on('end', () => {
    if (waiting) {
      const resolve = waiting
      waiting = null
      resolve()
    }
  })

  return function readLine () {
    return new Promise((resolve) => {
      const drain = () => {
        const idx = buffer.indexOf('\n')
        if (idx !== -1) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          return resolve(line.replace(/\r$/, ''))
        }
        return false
      }

      if (drain() !== false) return

      // Check if stdin already ended
      if (process.stdin.destroyed || process.stdin.readableEnded) {
        return resolve(null)
      }

      waiting = () => {
        if (drain() === false) {
          if (process.stdin.destroyed || process.stdin.readableEnded) {
            return resolve(null)
          }
          // Still no full line, keep waiting
          waiting = () => {
            if (drain() === false) resolve(null)
          }
        }
      }
    })
  }
}

module.exports = { createStdinLineReader }
