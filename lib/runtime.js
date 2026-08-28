const os = require('os')
const path = require('path')

// Development runs the bins through `bare bin.js`, deployments run the
// standalone binaries produced by bare-build. Bare.argv is
// [bare, script, ...args] in the first case and [binary, ...args] in the
// second, so anything reading argv has to shift by one.
const dev = path.basename(Bare.argv[0]) === 'bare'

module.exports = {
  dev,
  // Where user arguments start in Bare.argv / process.argv.
  argvOffset: dev ? 2 : 1,
  // Path of the running binary, null during development where there is no
  // standalone binary to update.
  binary: dev ? null : os.execPath()
}
