const fs = require('fs')

function createStdinLineReader() {
  let buffer = ''
  const chunk = Buffer.alloc(4096)

  return function readLine() {
    return new Promise((resolve, reject) => {
      const drain = () => {
        const idx = buffer.indexOf('\n')
        if (idx !== -1) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          resolve(line.replace(/\r$/, ''))
          return true
        }
        return false
      }

      if (drain()) return

      const read = () => {
        fs.read(0, chunk, 0, chunk.length, null, (err, bytesRead) => {
          if (err) return reject(err)
          if (bytesRead === 0) return resolve(null)

          buffer += chunk.subarray(0, bytesRead).toString()
          if (!drain()) read()
        })
      }

      read()
    })
  }
}

module.exports = { createStdinLineReader }
