#!/usr/bin/env node
'use strict'

const os = require('os')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const pkg = require(path.join(root, 'package.json'))

const supported = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64'
])

const bins = Object.keys(pkg.bin)

const argv = process.argv.slice(2)
let host = `${os.platform()}-${os.arch()}`
const selected = []

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--host') {
    host = argv[++i]
  } else if (arg.startsWith('--host=')) {
    host = arg.slice('--host='.length)
  } else if (bins.includes(arg)) {
    selected.push(arg)
  } else {
    console.error(`Unknown argument: ${arg}`)
    console.error(`Usage: node scripts/make.js [--host <host>] [${bins.join('] [')}]`)
    process.exit(1)
  }
}

if (!supported.has(host)) {
  console.error(`Unsupported platform/arch: ${host}`)
  console.error(`Supported targets: ${[...supported].join(', ')}`)
  process.exit(1)
}

const isWindows = os.platform() === 'win32'
const opts = { cwd: root, stdio: 'inherit' }
const deployment = path.join(root, 'out')

for (const bin of selected.length > 0 ? selected : bins) {
  const script = `make:${bin}:${host}`
  const command = pkg.scripts[script]
  if (!command) {
    console.error(`Missing package.json script: ${script}`)
    process.exit(1)
  }

  const res = isWindows
    ? spawnSync(`npm.cmd run ${script}`, { ...opts, shell: true })
    : spawnSync('npm', ['run', script], opts)
  if (res.error) {
    console.error(res.error.message)
    process.exit(1)
  }
  if (res.status !== 0) process.exit(res.status || 1)

  restoreName(command)
}

writeManifest()

// The updater reads /package.json off the upgrade drive to work out whether a
// staged build is newer than the one running, so the deployment folder needs a
// manifest alongside by-arch/. This is also where pear.json and the upgrade
// link belong once a key has been allocated with `pear touch`.
function writeManifest() {
  const manifest = {
    name: pkg.name,
    productName: pkg.productName,
    version: pkg.version,
    description: pkg.description
  }

  fs.mkdirSync(deployment, { recursive: true })
  fs.writeFileSync(path.join(deployment, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
}

// bare-build slugifies --name when it writes the executable, which turns
// git-remote-git+pear into git-remote-git-pear. Git only ever looks for a
// helper named exactly after the URL scheme, so the built binary is renamed
// back. The name and output directory are read from the build command itself
// so the two never drift apart.
function restoreName(command) {
  const name = /--name\s+(\S+)/.exec(command)?.[1]
  const out = /--out\s+(\S+)/.exec(command)?.[1]
  if (!name || !out) return

  const ext = host.startsWith('win32') ? '.exe' : ''
  const built = path.resolve(root, out, slugify(name) + ext)
  const wanted = path.resolve(root, out, name + ext)
  if (built === wanted) return

  fs.renameSync(built, wanted)
  console.log(`renamed ${path.basename(built)} to ${path.basename(wanted)}`)
}

function slugify(input) {
  return input
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
}
