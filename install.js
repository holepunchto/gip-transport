#!/usr/bin/env node
const fs = require('fs')
const { spawn } = require('child_process')
const { productName, upgrade } = require('./package.json')
const target =
  process.platform === 'win32'
    ? '%LOCALAPPDATA%\\Programs\\' + productName + '\\' + productName + '.exe'
    : '~/.local/bin/' + productName
let install = process.env.npm_config_yes ?? false
if (install === false) {
  fs.writeSync(1, 'Install ' + productName + ' to ' + target + ' [y|N]? ')
  const buf = Buffer.alloc(8)
  fs.readSync(0, buf, 0, buf.length)
  install = buf[0] === 'y'.charCodeAt(0) || buf[0] === 'Y'.charCodeAt(0)
}

if (install) {
  const sp = spawn('npx', ['-y', 'pear-install', upgrade], {
    stdio: ['inherit', 'pipe', 'inherit']
  })

  let acc = ''
  let timer = null
  sp.stdout.on('data', (data) => {
    process.stdout.write(data) // forward child output through to the terminal
    if (timer) return
    acc += data.toString()
    if (acc.includes('Installed')) {
      timer = setTimeout(() => {
        console.log('Exiting, please wait...')
      }, 3250)
    } else if (acc.length > 512) {
      acc = acc.slice(-512)
    }
  })

  sp.once('exit', (code) => {
    if (timer) clearTimeout(timer)
    process.exit(code)
  })
}
