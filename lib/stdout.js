const fs = require('fs')
const { Buffer } = require('buffer')

// git reads the remote-helper protocol from our stdout, and a reply still sitting in a
// stream buffer is a reply git never sees. Writing the push status through bare's async
// stdout left the terminating newline queued on Windows; process.exit then discarded it,
// so git hit EOF on an unterminated status list and called the push failed. A blocking
// write to fd 1 has happened by the time it returns, with no flush to get wrong.
function write(text) {
  const buffer = Buffer.from(text)
  let offset = 0

  while (offset < buffer.byteLength) {
    offset += fs.writeSync(1, buffer, offset, buffer.byteLength - offset)
  }
}

module.exports = { write }
