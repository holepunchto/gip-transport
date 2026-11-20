const test = require('brittle')
const createTestnet = require('hyperdht/testnet')
const Hyperswarm = require('hyperswarm')
const tmp = require('test-tmp')
const fs = require('fs')
const path = require('path')
const process = require('process')
const { spawn } = require('child_process')

const { GipLocalDB } = require('../lib/db')

const BIN = path.join(__dirname, '..', 'bin.js')

test('helper with GIP_BOOTSTRAP clones from a peer on a testnet', async (t) => {
  const testnet = await createTestnet(3, t.teardown)
  const { bootstrap } = testnet
  const dir = await tmp(t)

  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  const shim = path.join(bin, 'git-remote-git+pear')
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`)
  fs.chmodSync(shim, 0o755)

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GIP_NO_UPDATES: '1',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'gc.auto',
    GIT_CONFIG_VALUE_0: '0',
    GIT_CONFIG_KEY_1: 'maintenance.auto',
    GIT_CONFIG_VALUE_1: 'false',
    GIP_BOOTSTRAP: bootstrap.map((node) => `${node.host}:${node.port}`).join(',')
  }

  // Async spawn: the testnet lives in this process, spawnSync would freeze it.
  const git = (args, cwd = dir) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        'git',
        ['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args],
        { cwd, env }
      )
      let stderr = ''
      child.stdout.on('data', () => {})
      child.stderr.on('data', (data) => (stderr += data))
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`git ${args[0]} failed: ${stderr}`))
      })
    })

  const store = path.join(dir, 'store')
  const writer = new GipLocalDB({ dir: store, bootstrap })
  await writer.ready()
  const { url } = await writer.createRemote('t')
  await writer.close()

  const repo = path.join(dir, 'repo')
  fs.mkdirSync(repo)
  await git(['init', '-q'], repo)
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n')
  await git(['add', '-A'], repo)
  await git(['commit', '-qm', 'one'], repo)
  await git(['push', `${url}?storage=${store}`, '--all'], repo)

  const seeder = new GipLocalDB({
    dir: store,
    swarm: new Hyperswarm({ dht: testnet.createNode({ ephemeral: false, firewalled: false }) })
  })
  await seeder.ready()
  t.teardown(() => seeder.close())
  await seeder.openRemotes()

  const clone = path.join(dir, 'clone')
  await git(['clone', '-q', `${url}?storage=${path.join(dir, 'peer')}`, clone])

  t.is(fs.readFileSync(path.join(clone, 'a.txt'), 'utf8'), 'hello\n')
})
