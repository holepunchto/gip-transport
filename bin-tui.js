#!/usr/bin/env bare

const { header, summary, command, validate, arg } = require('paparam')
const { GipLocalDB } = require('./lib/db')
const Id = require('hypercore-id-encoding')
const goodbye = require('graceful-goodbye')
const process = require('process')

const green = (text) => `\x1b[32m${text}\x1b[0m`
const dim = (text) => `\x1b[2m${text}\x1b[0m`

const regexRepoName = /^[a-zA-Z0-9_-]+$/

async function setup(readonly = false) {
  try {
    const db = new GipLocalDB({ readonly })
    await db.ready()
    return db
  } catch (e) {
    if (e.message.endsWith('No such file or directory') && readonly) {
      return setup()
    }
    throw e
  }
}

const newRepo = command(
  'new',
  header('Create a new repository'),
  summary('Create a new Git repository'),
  arg('name', 'Name of the repository'),
  validate(
    ({ args }) => args.name && regexRepoName.test(args.name),
    'Invalid repository name. Support alphanumeric characters, underscores, and hyphens.'
  ),
  async () => {
    const db = await setup()

    const name = newRepo.args.name
    const remote = await db.createRemote(name)

    console.log(`Repository ${green(name)} created ${remote.url.replace('0.0.', '')}`)

    await db.close()
  }
)

const listRepos = command(
  'list',
  header('List repositories'),
  summary('List all your available Git repositories'),
  async () => {
    const db = await setup(true)

    if (db._db.core.length === 0) {
      await db.close()
      return
    }

    const remotes = await db.openRemotes()
    for (const [name, remote] of remotes) {
      console.log(`* ${green(name)}`)
      console.log(`  Url: ${remote.url}`)
      console.log(`  Peers: ${remote.core.peers.length}`)
      console.log(`  Length: ${remote.core.length}`)
    }

    await db.close()
  }
)

const addRepo = command(
  'add',
  header('Add a repository'),
  summary('Add a remote repository to your local store by URL'),
  arg('url', 'Repository URL (git+pear://)'),
  validate(
    ({ args }) => args.url && args.url.startsWith('git+pear://'),
    'Must be a valid git+pear:// URL'
  ),
  async () => {
    const db = await setup()
    const url = addRepo.args.url

    // Register peer listener before joining network — no connection should be missed
    let resolvePeer
    const firstPeer = new Promise((resolve) => {
      resolvePeer = resolve
    })
    db.on('connection', (conn) => resolvePeer(conn))

    const { remote, isNew } = await db.addRemote(url)

    if (isNew) {
      console.log(`Repository ${green(remote.name)} added`)
    } else {
      console.log(`Repository ${green(remote.name)} already in store`)
    }

    const spinFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    let spinIdx = 0
    const spinner = setInterval(() => {
      process.stdout.write(`\r${spinFrames[spinIdx++ % spinFrames.length]} Connecting to peers...`)
    }, 80)

    const conn = await firstPeer

    clearInterval(spinner)
    const peerKey = dim(Id.encode(conn.remotePublicKey).slice(0, 8))
    process.stdout.write(`\r${green('✔')} Peer connected ${peerKey}\n`)

    await db.close()
  }
)

const deleteRepo = command(
  'delete',
  header('Delete a repository'),
  summary('Delete a Git repository from your local store'),
  arg('name', 'Name of the repository to delete'),
  validate(
    ({ args }) => args.name && regexRepoName.test(args.name),
    'Invalid repository name. Support alphanumeric characters, underscores, and hyphens.'
  ),
  async () => {
    const db = await setup()

    const name = deleteRepo.args.name
    const repo = await db.getRepo(name)

    if (!repo) {
      console.log(`Repository ${name} not found`)
      await db.close()
      return
    }

    process.stdout.write(`Delete repository ${green(name)}? [y/N] `)

    const answer = await new Promise((resolve) => {
      process.stdin.setEncoding('utf8')
      process.stdin.once('data', (data) => resolve(data.trim().toLowerCase()))
    })

    if (answer !== 'y' && answer !== 'yes') {
      console.log('Aborted')
      await db.close()
      return
    }

    const deleted = await db.deleteRemote(name)
    if (deleted) {
      console.log(`Repository ${green(name)} deleted`)
    } else {
      console.log(`Repository ${name} not found`)
    }

    await db.close()
    process.exit(0)
  }
)

const seedRemotes = command(
  'seed',
  header('Seed repositories'),
  summary('Seed all your available Git repositories'),
  async () => {
    const db = await setup(true)

    goodbye(async () => {
      await db.close()
    })

    const publicKey = await db.getPublicKey()
    const remotes = await db.openRemotes()

    if (remotes.size === 0) {
      console.log(dim('No repositories to seed'))
      await db.close()
      return
    }

    console.log(`${green('Seeding')} — Public key: ${Id.encode(publicKey)}`)
    console.log()

    for (const [name, remote] of remotes) {
      console.log(`  ${green(name)} — ${remote.core.length} blocks`)
    }

    console.log()

    db.swarm.on('connection', (conn) => {
      const key = Id.encode(conn.remotePublicKey).slice(0, 8)
      console.log(`${green('+')} Peer connected ${dim(key)}`)
    })

    for (const [name, remote] of remotes) {
      remote.core.on('upload', (index, bytes, from) => {
        const key = Id.encode(from.remotePublicKey).slice(0, 8)
        console.log(`  ${green('↑')} ${name} block ${index} → ${dim(key)}`)
      })

      remote.core.on('download', (index, bytes, from) => {
        const key = Id.encode(from.remotePublicKey).slice(0, 8)
        console.log(`  ${green('↓')} ${name} block ${index} ← ${dim(key)}`)
      })
    }
  }
)

// --- ID ---

const idCmd = command(
  'id',
  header('Show your public key'),
  summary('Print your public key for sharing with blind peers'),
  async () => {
    const db = await setup(true)

    const publicKey = await db.getPublicKey()
    console.log(Id.encode(publicKey))

    await db.close()
  }
)

// --- Config ---

const configGet = command(
  'get',
  header('Get a config value'),
  summary('Get the value of a config key'),
  arg('key', 'Config key (e.g. blind-peers)'),
  validate(({ args }) => !!args.key, 'Key is required'),
  async () => {
    const db = await setup(true)

    const key = configGet.args.key

    if (key === 'blind-peers') {
      const peers = await db.getBlindPeers()
      if (peers.length === 0) {
        console.log(dim('(not set)'))
      } else {
        for (const peer of peers) console.log(peer)
      }
    } else {
      console.error(`Unknown config key: ${key}`)
    }

    await db.close()
  }
)

const configAdd = command(
  'add',
  header('Add to a config list'),
  summary('Add a value to a list config key (e.g. blind-peers)'),
  arg('key', 'Config key'),
  arg('value', 'Value to add'),
  validate(({ args }) => args.key && args.value, 'Key and value are required'),
  async () => {
    const db = await setup()

    const key = configAdd.args.key
    const value = configAdd.args.value

    if (key === 'blind-peers') {
      await db.addBlindPeer(value)
      console.log(`Added to ${green(key)}`)
    } else {
      console.error(`Unknown config key: ${key}`)
    }

    await db.close()
  }
)

const configRemove = command(
  'remove',
  header('Remove from a config list'),
  summary('Remove a value from a list config key'),
  arg('key', 'Config key'),
  arg('value', 'Value to remove'),
  validate(({ args }) => args.key && args.value, 'Key and value are required'),
  async () => {
    const db = await setup()

    const key = configRemove.args.key
    const value = configRemove.args.value

    if (key === 'blind-peers') {
      const removed = await db.removeBlindPeer(value)
      if (removed) {
        console.log(`Removed from ${green(key)}`)
      } else {
        console.log(dim('Value not found'))
      }
    } else {
      console.error(`Unknown config key: ${key}`)
    }

    await db.close()
  }
)

const configCmd = command(
  'config',
  header('Manage configuration'),
  summary('Get and set config values'),
  configGet,
  configAdd,
  configRemove,
  async () => {
    const db = await setup(true)

    const peers = await db.getBlindPeers()

    if (peers.length === 0) {
      console.log(dim('No config set'))
      await db.close()
      return
    }

    console.log(`${green('blind-peers')}:`)
    for (const peer of peers) console.log(`  ${peer}`)

    await db.close()
  }
)

// --- Root ---

const cmd = command(
  'gip',
  header('Git Remote the P2P way'),
  summary('Gip allows you to manage your Git repositories. No servers, just Peers.'),
  newRepo,
  addRepo,
  listRepos,
  deleteRepo,
  seedRemotes,
  idCmd,
  configCmd,
  () => console.log(cmd.help())
)

cmd.parse(process.argv.slice(2))
