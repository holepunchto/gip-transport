const { spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const pkg = require('../package.json')

const hosts = [
  ...new Set(
    Object.keys(pkg.scripts)
      .filter((name) => name.startsWith('make:') && name.split(':').length === 3)
      .map((name) => name.split(':')[2])
  )
]

const requested = process.argv.slice(2)
const selected = requested.length ? hosts.filter((host) => requested.includes(host)) : hosts

const flags = selected.flatMap((host) => {
  const ext = host.startsWith('win32-') ? '.exe' : ''

  return Object.keys(pkg.bin).flatMap((bin) => {
    const file = `out/${host}/${bin}${ext}`

    if (!existsSync(file)) {
      console.warn(`Warning: missing ${file}`)
      return []
    }

    return [`--${host}-app`, file]
  })
})

const args = [
  '--yes',
  'pear-build',
  ...flags,
  '--target',
  'out/release',
  '--package',
  require.resolve('../package.json')
]

const result = spawnSync('npx', args, { stdio: 'inherit' })

if (result.error) throw result.error
if (result.status !== 0) process.exitCode = result.status ?? 1
