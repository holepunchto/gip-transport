const process = require('process')
const { spawn } = require('child_process')
const fs = require('fs')
const b4a = require('b4a')
const sh = require('./bare-sh')
const ReadyResource = require('ready-resource')
const { toDisk } = require('gip-remote/git')
const { GipLocalDB } = require('./db')
const { ProgressReporter } = require('./progress')
const stdout = require('./stdout')

const ZERO = '0'.repeat(40)
const NAMESPACES = ['refs/heads/', 'refs/tags/']
const SHALLOW = ['depth', 'deepen-since', 'deepen-not', 'deepen-relative', 'filter']

function formatRef(r) {
  if (r.symref) return `@${r.symref} ${r.ref}`
  return `${r.oid} ${r.ref}`
}

class Gip extends ReadyResource {
  _verbosity = 1
  _progress = true
  _followTags = false
  _dryRun = false
  _atomic = false
  _cas = new Map()
  _refused = null
  _connected = false
  _listed = null
  _pendingPushes = []
  _pendingFetches = new Map()
  _local = null
  _link = null
  _remoteName = null
  _remoteDb = null
  _progressReporter = null

  constructor(args = {}) {
    super()

    this._remoteName = args.remote
    this._link = args.link

    this._progressReporter = new ProgressReporter()

    this._local = new GipLocalDB({ dir: args.dir, bootstrap: args.bootstrap })
  }

  get remote() {
    return this._remoteDb
  }

  async _open() {
    await this._local.ready()

    // The helper lives for one git command: too short to seed, so it only announces when a
    // blind peer has to find it.
    const remote = await this._local.openRemote(this._link, { announce: !!this._local.blind })

    if (!remote) {
      throw new Error('Failed to join remote')
    }

    this._remoteDb = remote
  }

  async _close() {
    this._progressReporter.stop()
    await this._local.close()
  }

  // ready() with the connection reported, for the first command that needs the remote.
  async connect() {
    if (this._connected) return
    this._connected = true
    if (this._verbosity >= 1) this._progressReporter.connecting()
    await this.ready()
    this._progressReporter.connected(this._remoteDb)
  }

  // gitremote-helpers(7): ok, unsupported or error <msg>. Git gives up on a push option we
  // decline, but only warns for a fetch one, so fetch() refuses those itself.
  setOption(name, value) {
    this._debug(`Option ${name}: ${value}`)

    switch (name) {
      case 'verbosity':
        this._verbosity = Number(value)
        return 'ok'
      case 'progress':
        this._progress = value === 'true'
        return 'ok'
      case 'followtags':
        this._followTags = value === 'true'
        return 'ok'
      case 'dry-run':
        this._dryRun = value === 'true'
        return 'ok'
      case 'atomic':
        this._atomic = value === 'true'
        return 'ok'
      case 'cas': {
        const at = value.lastIndexOf(':')
        const oid = value.slice(at + 1)
        this._cas.set(value.slice(0, at), oid === ZERO ? null : oid)
        return 'ok'
      }
      case 'pushcert':
        return value === 'if-asked' ? 'ok' : 'unsupported'
    }

    if (SHALLOW.includes(name)) this._refused = name
    return 'unsupported'
  }

  _writeLog(message) {
    process.stderr.write(message + '\n')
  }

  _info(message) {
    if (this._verbosity >= 1) this._writeLog('Gip [INFO]: ' + message)
  }

  _error(message) {
    this._writeLog('Gip [ERROR]: ' + message)
  }

  _debug(message) {
    if (this._verbosity >= 2) {
      this._writeLog('Gip [DEBUG]: ' + message)
    }
  }

  _verbose(message) {
    if (this._verbosity >= 3) {
      this._writeLog('Gip [VERBOSE]: ' + message)
    }
  }

  _echo(message) {
    if (this._verbosity >= 3) {
      this._writeLog('Gip [ECHO]: ' + message)
    }
  }

  _output(message, newline = true) {
    stdout.write(message + (newline ? '\n' : ''))
    this._echo(message)
  }

  get _showProgress() {
    return this._progress && this._verbosity >= 1
  }

  hasPendingFetch() {
    return this._pendingFetches.size > 0
  }

  hasPendingPush() {
    return this._pendingPushes.length > 0
  }

  // HEAD and peeled tags are not refs a push can move: listed for-push, --mirror would try
  // to delete them.
  async list(forPush = false) {
    this._debug(`Listing refs${forPush ? ' for push' : ''}`)

    const refs = await this._remoteDb.getAllRefs()
    const { core } = this._remoteDb

    if (!core.writable && core.length === 0 && !this._remoteDb.availablePeers) {
      throw new Error(`Repo not found, peers required`)
    }

    if (forPush) this._listed = new Map()

    for (const ref of refs) {
      if (forPush) {
        if (ref.symref) continue
        this._listed.set(ref.ref, ref.oid)
      }

      this._output(formatRef(ref))
      if (ref.peeled && !forPush) this._output(`${ref.peeled} ${ref.ref}^{}`)
    }

    this._output('')
  }

  addPush(refspec) {
    this._debug(`Add push: ${refspec}`)

    const force = refspec.startsWith('+')
    const [src, dst] = refspec.slice(force ? 1 : 0).split(':')

    // An empty src deletes dst.
    this._pendingPushes.push({ src, dst, force })
  }

  addFetch(oid, name) {
    this._debug(`Add fetch: ${oid} ${name}`)
    this._pendingFetches.set(oid, name)
  }

  // The helper writes objects only: git moves the refs itself once the batch is answered.
  async fetch() {
    this._debug(`Fetch: ${this._pendingFetches.size}`)

    if (this._refused) throw new Error(`option ${this._refused} is not supported`)

    if (this._showProgress) this._progressReporter.startCounting('Receiving objects')

    // One seen set across refs: shared history is walked once, not once per ref.
    const objects = []
    const seen = new Set()
    let bytes = 0

    const load = async (oid) => {
      const loaded = await this._remoteDb.getRefObjects(
        oid,
        (size) => {
          bytes += size
          if (this._showProgress) this._progressReporter.updateCount(seen.size)
        },
        { seen }
      )
      for (const object of loaded) objects.push(object)
    }

    for (const [oid, name] of this._pendingFetches) {
      this._debug(`Fetch: ${oid} ${name}`)
      await load(oid)
      if (!seen.has(oid)) throw new Error(`Remote has no object ${oid} (${name})`)
    }
    this._pendingFetches.clear()

    if (this._followTags) {
      for (const ref of await this._remoteDb.getAllRefs()) {
        if (ref.peeled && seen.has(ref.peeled)) await load(ref.oid)
      }
    }

    if (objects.length > 0) {
      this._debug(`Total unique objects: ${objects.length}`)
      this._debug(`Rebuilding repo`)

      await toDisk({ gitDir: process.env.GIT_DIR, objectFormat: 'sha1', objects })

      this._debug(`Done rebuilding`)
    }

    if (this._showProgress) {
      this._progressReporter.finishCounting(objects.length)
      this._progressReporter.reportInfo(
        `Receiving objects: 100% (${objects.length}/${objects.length}), ${this._progressReporter._formatBytes(bytes)}, done.`
      )
    }

    this._output('')
  }

  async push() {
    const batch = this._pendingPushes
    this._pendingPushes = []

    this._verbose(`Pushing refs: ${batch.length}`)

    const remoteRefs = (await this._remoteDb.getAllRefs()).filter((r) => !r.symref)
    const current = new Map(remoteRefs.map((r) => [r.ref, r.oid]))

    const updates = await this._plan(batch, current)
    const reject = (reason) => {
      for (const update of updates) update.error ??= reason
    }

    if (this._atomic && updates.some((update) => update.error)) reject('atomic push failed')

    if (!this._dryRun) {
      const live = updates.filter((update) => !update.error)
      await this._apply(live, current)
      if (this._atomic && live.some((update) => update.error)) reject('atomic push failed')
      await this._syncHead(current, updates)
    }

    for (const update of updates) {
      this._output(update.error ? `error ${update.dst} ${update.error}` : `ok ${update.dst}`)
    }
    this._output('')

    if (this._verbosity >= 1) this._progressReporter.reportInfo(`Latest: ${this._remoteDb.url}`)
  }

  // Everything that can be refused before a byte is written. Each update carries the oid the
  // remote ref has to be at for the write to go through:
  //   --force-with-lease  what the lease names
  //   after a list        what git was told, whether or not it forces
  //   no list, no force   what the ref is at now, so the fast-forward check holds
  async _plan(batch, current) {
    const oids = await this._resolve(batch.filter((push) => push.src).map((push) => push.src))
    const head = await this._remoteDb.getHead()
    const updates = []

    for (const { src, dst, force } of batch) {
      const update = { dst, oid: src ? oids.get(src) : null, expect: undefined, error: null }
      updates.push(update)

      if (!NAMESPACES.some((namespace) => dst.startsWith(namespace))) {
        update.error = 'unsupported ref namespace'
        continue
      }

      const leased = this._cas.has(dst)
      if (leased) update.expect = this._cas.get(dst)
      else if (this._listed) update.expect = this._listed.get(dst) ?? null
      else if (src && !force) update.expect = current.get(dst) ?? null

      if (!src) {
        if (dst === `refs/heads/${head}`) update.error = 'deletion of the current branch prohibited'
        continue
      }

      if (force || leased || !update.expect || update.expect === update.oid) continue

      if (dst.startsWith('refs/tags/')) update.error = 'already exists'
      else if ((await this._localOids([update.expect])).length === 0) update.error = 'fetch first'
      else if (!(await this._isAncestor(update.expect, update.oid))) {
        update.error = 'non-fast-forward'
      }
    }

    return updates
  }

  // Each ref is its own transaction: a ref that loses a race after another one landed is
  // reported on its own, which is the one way --atomic can still land partially.
  async _apply(updates, current) {
    const pushes = updates.filter((update) => update.oid && current.get(update.dst) !== update.oid)

    let listing = []
    let total = 0

    if (pushes.length > 0) {
      if (this._showProgress) this._progressReporter.startCounting('Enumerating objects')

      // Anything the remote points at that we also have is a "have" — never re-sent.
      const haves = await this._localOids([...new Set(current.values())])
      listing = await this._revList(
        pushes.map((update) => update.oid),
        haves
      )
      total = countLines(listing)

      if (await this._crossesShallow(listing)) {
        this._progressReporter.stop()
        for (const update of pushes) update.error = 'shallow update not allowed'
        if (this._atomic) return
        listing = []
      }

      if (this._showProgress && listing.length > 0) {
        this._progressReporter.finishCounting(total)
        this._progressReporter.startWriting()
      }
    }

    let stored = false
    let written = 0
    let bytes = 0

    const objects = async function* (gip) {
      for await (const object of gip._catObjects(listing)) {
        written++
        bytes += object.size
        if (gip._showProgress && written % 256 === 0) {
          gip._progressReporter.updateWriting(written, bytes)
        }
        yield object
      }
    }

    for (const update of updates) {
      const { dst, oid, expect } = update
      if (update.error) continue

      try {
        if (!oid) {
          const deleted = await this._remoteDb.deleteRef(dst, { expect })
          if (deleted) this._info(`Deleted ${dst}`)
          else update.error = 'not found'
          continue
        }

        if (current.get(dst) === oid) {
          this._debug(`Up to date: ${oid} ${dst}`)
          continue
        }

        // The first ref that lands stores the objects of the whole batch.
        await this._remoteDb.pushRef(dst, oid, stored ? [] : objects(this), { expect })
        stored = true

        this._debug(`Pushed with ref: ${oid} ${dst}`)
      } catch (e) {
        this._debug(`Push error: ${e.message}`)
        update.error = this._reason(e, update)
      }
    }

    if (this._showProgress && listing.length > 0) {
      this._progressReporter.updateWriting(written, bytes)
      this._progressReporter.finishWriting()
    }
  }

  // The words git knows a rejection by: "fetch first", "stale info".
  _reason(err, update) {
    if (err.code === 'STALE_REF') return this._cas.has(update.dst) ? 'stale info' : 'fetch first'
    if (err.code === 'UNSUPPORTED_REF') return 'unsupported ref namespace'
    if (err.code === 'DELETE_HEAD') return 'deletion of the current branch prohibited'
    return err.message.replace(/\s+/g, ' ')
  }

  // The remote defaults its head to the first branch pushed, but `git push --all` sends them
  // alphabetically — the local HEAD is authoritative.
  async _syncHead(current, updates) {
    try {
      const result = await sh.exec('git', ['symbolic-ref', '-q', 'HEAD'])
      const headRef = result.stdout.toString().trim()
      if (result.status !== 0 || !headRef.startsWith('refs/heads/')) return

      const update = updates.find((update) => update.dst === headRef && !update.error)
      const exists = update ? !!update.oid : current.has(headRef)
      if (!exists) return

      const branch = headRef.slice('refs/heads/'.length)
      if ((await this._remoteDb.getHead()) !== branch) {
        this._debug(`Setting head to ${branch}`)
        await this._remoteDb.setHead(branch)
      }
    } catch (e) {
      this._debug(`Head sync error: ${e.message}`)
    }
  }

  // Remote refs we have never fetched cannot be used as haves.
  async _localOids(oids) {
    if (oids.length === 0) return []
    const result = await sh.exec('git', ['cat-file', '--batch-check'], {
      input: oids.join('\n') + '\n'
    })
    const known = []
    for (const line of result.stdout.toString('utf8').split('\n')) {
      const header = this._parseHeader(line)
      if (header) known.push(header.sha1)
    }
    return known
  }

  // One git process for every ref of the batch: `push --tags` can name thousands.
  async _resolve(names) {
    const oids = new Map()
    if (names.length === 0) return oids

    const result = await sh.exec('git', ['cat-file', '--batch-check=%(objectname)'], {
      input: names.join('\n') + '\n'
    })
    const lines = result.stdout.toString('utf8').split('\n')
    names.forEach((name, i) => oids.set(name, lines[i]))
    return oids
  }

  async _isAncestor(ancestor, oid) {
    const result = await sh.exec('git', ['merge-base', '--is-ancestor', ancestor, oid])
    return result.status === 0
  }

  // The raw `<oid> <path>` lines of every object to send, as git wrote them: at a few dozen
  // bytes an object they are cheap to hold, where a set of oid strings is not.
  _revList(tips, haves) {
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['rev-list', '--objects', '--stdin'])
      const chunks = []
      const errors = []

      child.stdout.on('data', (chunk) => chunks.push(chunk))
      child.stderr.on('data', (chunk) => errors.push(chunk))
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) return resolve(chunks)
        reject(new Error(`git rev-list failed: ${b4a.toString(b4a.concat(errors)).trim()}`))
      })

      child.stdin.end(tips.concat(haves.map((oid) => '^' + oid)).join('\n') + '\n')
    })
  }

  // A commit git only has the grafted end of cannot be sent whole.
  async _crossesShallow(listing) {
    const result = await sh.exec('git', [
      'rev-parse',
      '--is-shallow-repository',
      '--git-path',
      'shallow'
    ])
    const [shallow, file] = result.stdout.toString().trim().split('\n')
    if (shallow !== 'true') return false

    const grafted = new Set(fs.readFileSync(file, 'utf8').split('\n'))
    const lines = b4a.toString(b4a.concat(listing)).split('\n')
    return lines.some((line) => grafted.has(line.slice(0, 40)))
  }

  // Objects in the order of `listing`, one at a time: the consumer sets the pace, so a push
  // never holds more than the object in flight.
  async *_catObjects(listing) {
    if (listing.length === 0) return

    const child = spawn('git', [
      'cat-file',
      '--batch=%(objectname) %(objecttype) %(objectsize) %(rest)'
    ])
    const exited = new Promise((resolve) => child.on('exit', resolve))
    child.stderr.on('data', () => {})

    const feed = async () => {
      for (const chunk of listing) {
        if (child.stdin.write(chunk)) continue
        await new Promise((resolve) => child.stdin.once('drain', resolve))
      }
      child.stdin.end()
    }
    // A cat-file that dies early shows up as its exit code below.
    child.stdin.on('error', () => {})
    feed()

    let pending = b4a.alloc(0)
    let header = null
    let parts = []
    let partBytes = 0
    let count = 0

    try {
      for await (const chunk of child.stdout) {
        if (header && pending.byteLength === 0 && partBytes + chunk.byteLength <= header.size) {
          // Fast path: chunk is entirely payload — no buffer joins.
          parts.push(chunk)
          partBytes += chunk.byteLength
          continue
        }

        pending = pending.byteLength ? b4a.concat([pending, chunk]) : chunk

        for (;;) {
          if (header) {
            const want = header.size - partBytes
            if (pending.byteLength < want + 1) {
              // Move into parts so `pending` stays empty and the next chunk takes the fast path.
              if (pending.byteLength > 0) {
                parts.push(pending)
                partBytes += pending.byteLength
                pending = b4a.alloc(0)
              }
              break
            }

            parts.push(pending.subarray(0, want))
            const object = {
              oid: header.sha1,
              type: header.type,
              size: header.size,
              data: parts.length === 1 ? parts[0] : b4a.concat(parts)
            }
            pending = pending.subarray(want + 1)
            header = null
            parts = []
            partBytes = 0
            count++
            yield object
            continue
          }

          const newline = pending.indexOf(10)
          if (newline === -1) break

          header = this._parseHeader(b4a.toString(pending.subarray(0, newline)))
          pending = pending.subarray(newline + 1)
        }
      }

      const code = await exited
      if (code !== 0) throw new Error(`git cat-file failed (${code})`)
      this._debug(`Parsed ${count} objects`)
    } finally {
      child.kill()
    }
  }

  _parseHeader(line) {
    const match = line.match(/^([0-9a-f]{40}) (\w+) (\d+)/)
    if (match && match.length === 4) {
      return {
        sha1: match[1],
        type: match[2],
        size: parseInt(match[3], 10)
      }
    }
    return null
  }
}

function countLines(chunks) {
  let lines = 0
  for (const chunk of chunks) {
    for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) lines++
  }
  return lines
}

module.exports = {
  Gip
}
