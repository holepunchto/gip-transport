#!/usr/bin/env node
const fs = require('fs')
const { spawnSync } = require('child_process')
const { productName, upgrade } = require('./package.json')
const target =
  process.platform === 'win32'
    ? '%LOCALAPPDATA%\\Programs\\' + productName + '\\' + productName + '.exe'
    : '~/.local/bin/' + productName

let install = process.argv.includes('-y') ?? false

if (install === false) {
  fs.writeSync(1, 'Install ' + productName + ' to ' + target + ' [y|N]? ')
  const buf = Buffer.alloc(8)
  fs.readSync(0, buf, 0, buf.length)
  install = buf[0] === 'y'.charCodeAt(0) || buf[0] === 'Y'.charCodeAt(0)
}

if (install) {
  const sp = spawnSync('npx', ['-y', 'pear-install', upgrade], {
    stdio: 'inherit'
  })
  const code = sp.status ?? 1
  if (code === 0) fs.renameSync(__filename, __filename + '.done')
  process.exit(code)
}

process.exit(0)
