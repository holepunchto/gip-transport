#!/usr/bin/env bare

const { header, summary, command, validate, arg, flag } = require('paparam')
const { GipLocalDB } = require('./lib/db')
const Id = require('hypercore-id-encoding')
const goodbye = require('graceful-goodbye')
const process = require('process')

const green = (text) => `\x1b[32m${text}\x1b[0m`
const dim = (text) => `\x1b[2m${text}\x1b[0m`

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// Render N repo rows in-place. Prints all rows immediately, then re-renders
// them every tick so spinners animate and resolved rows show their details.
// loadFn(name) → result, formatRow(name, result | null) → string
async function parallelRows(names, loadFn, formatRow) {
  if (names.length === 0) return []

  const results = new Array(names.length).fill(null)
  const done = new Array(names.length).fill(false)

  // Initial print — all rows with spinners
  for (const name of names) process.stdout.write(formatRow(name, null) + '\n')

  let frame = 0
  const redraw = () => {
    process.stdout.write(`\x1b[${names.length}A`) // move cursor up to first row
    for (let i = 0; i < names.length; i++) {
      process.stdout.write(`\r\x1b[K`) // clear line
      if (done[i]) {
        process.stdout.write(formatRow(names[i], results[i]))
      } else {
        process.stdout.write(`${dim(SPIN[frame % SPIN.length])} ${names[i]}`)
      }
      process.stdout.write('\n')
    }
    frame++
  }

  const interval = setInterval(redraw, 80)

  await Promise.all(
    names.map(async (name, i) => {
      results[i] = await loadFn(name)
      done[i] = true
    })
  )

  clearInterval(interval)
  redraw() // final pass — all rows resolved

  return results
}

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
  flag('--json', 'Output in JSON format'),
  async () => {
    const outputJson = !!listRepos.flags.json
    const db = await setup(true)

    const names = await db.getRepoNames()

    if (names.length === 0) {
      console.log(outputJson ? JSON.stringify([]) : dim('No repositories'))
      await db.close()
      return
    }

    if (outputJson) {
      const results = await Promise.all(
        names.map(async (name) => {
          const entry = await db.getCore(name, { server: false, client: false })
          if (!entry) return null
          const { core, key } = entry
          const len = core.length
          const url = `git+pear://0.${len}.${Id.encode(key)}/${name}`
          return { name, url }
        })
      )
      console.log(JSON.stringify(results.filter((r) => r !== null)))
      await db.close()
      return
    }

    await parallelRows(
      names,
      // Just the core — no Hyperbee opened for listing.
      // server:false, client:false → no swarm announcement (list is local-only).
      (name) => db.getCore(name, { server: false, client: false }),
      (name, entry) => {
        if (!entry) return `${dim('⠋')} ${name}`
        const { core, key } = entry
        const peers = core.peers.length
        const len = core.length
        const url = `git+pear://0.${len}.${Id.encode(key)}/${name}`
        return `${green('*')} ${name}  ${dim(`${len} blocks · ${peers} peer${peers === 1 ? '' : 's'} · ${url}`)}`
      }
    )

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

    // Parse the repo name out of the URL up-front so the spinner row has a
    // stable label while addRemote syncs (joins swarm, waits for peer,
    // downloads all blocks, opens Remote). Post-sync, git clone reads from
    // disk.
    const name = url.split('/').pop() || url

    await parallelRows(
      [name],
      () => db.addRemote(url),
      (name, result) => {
        if (!result) return `${dim('⠋')} ${name}`
        const { isNew, remote } = result
        const verb = isNew ? 'added' : 'already in store'
        const len = remote.core.length
        return `${green('✔')} ${green(name)} ${verb} ${dim(`— ${len} block${len === 1 ? '' : 's'}`)}`
      }
    )

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
    const names = await db.getRepoNames()

    if (names.length === 0) {
      console.log(dim('No repositories to seed'))
      await db.close()
      return
    }

    console.log(`${green('Seeding')} — Public key: ${Id.encode(publicKey)}`)
    console.log()

    // Seeding is pure core+swarm — no Hyperbee/HyperDB needed. Each core is
    // registered in corestore and announced on the swarm as a server, so
    // store.replicate(conn) (wired in _open) handles block-level replication
    // automatically when peers connect.
    const entries = await parallelRows(
      names,
      (name) => db.getCore(name, { server: true, client: false }),
      (name, entry) => {
        if (!entry) return `${dim('⠋')} ${name}`
        return `  ${green(name)} — ${entry.core.length} blocks`
      }
    )

    console.log()

    // Wire up transfer events now that all cores are ready
    for (let i = 0; i < names.length; i++) {
      const name = names[i]
      const entry = entries[i]
      if (!entry) continue
      const core = entry.core

      core.on('upload', (index, bytes, from) => {
        const key = Id.encode(from.remotePublicKey).slice(0, 8)
        console.log(`  ${green('↑')} ${name} block ${index} → ${dim(key)}`)
      })

      core.on('download', (index, bytes, from) => {
        const key = Id.encode(from.remotePublicKey).slice(0, 8)
        console.log(`  ${green('↓')} ${name} block ${index} ← ${dim(key)}`)
      })
    }

    db.swarm.on('connection', (conn) => {
      const key = Id.encode(conn.remotePublicKey).slice(0, 8)
      console.log(`${green('+')} Peer connected ${dim(key)}`)
    })
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
    } else if (key === 'seed-read-only') {
      const enabled = await db.getSeedReadOnly()
      console.log(enabled ? 'on' : 'off')
    } else {
      console.error(`Unknown config key: ${key}`)
    }

    await db.close()
  }
)

// Parse a flexible boolean string. Used for the seed-read-only toggle so the
// user can write `on/off`, `true/false`, `yes/no`, `1/0` interchangeably.
function parseBool(value) {
  const v = String(value).toLowerCase()
  if (['on', 'true', 'yes', '1'].includes(v)) return true
  if (['off', 'false', 'no', '0'].includes(v)) return false
  return null
}

const configSet = command(
  'set',
  header('Set a scalar config value'),
  summary('Set a non-list config key (e.g. seed-read-only on|off)'),
  arg('key', 'Config key'),
  arg('value', 'Value'),
  validate(({ args }) => args.key && args.value, 'Key and value are required'),
  async () => {
    const db = await setup()

    const key = configSet.args.key
    const value = configSet.args.value

    if (key === 'seed-read-only') {
      const parsed = parseBool(value)
      if (parsed === null) {
        console.error(`Invalid boolean: ${value} (use on|off)`)
        await db.close()
        return
      }
      await db.setSeedReadOnly(parsed)
      console.log(`${green(key)} set to ${parsed ? 'on' : 'off'}`)
    } else {
      console.error(`Unknown scalar config key: ${key}`)
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
  configSet,
  configAdd,
  configRemove,
  async () => {
    const db = await setup(true)

    const peers = await db.getBlindPeers()
    const seedReadOnly = await db.getSeedReadOnly()

    console.log(`${green('seed-read-only')}: ${seedReadOnly ? 'on' : 'off'}`)

    if (peers.length === 0) {
      console.log(`${green('blind-peers')}: ${dim('(none)')}`)
    } else {
      console.log(`${green('blind-peers')}:`)
      for (const peer of peers) console.log(`  ${peer}`)
    }

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
