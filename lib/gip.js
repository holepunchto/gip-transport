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
const STREAMED_BLOB = 1024 * 1024
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

    this._write = args.write || stdout.write

    this._progressReporter = new ProgressReporter({ write: args.writeErr || null })

    this._ownsLocal = !args.db
    this._local = args.db || new GipLocalDB({ dir: args.dir, bootstrap: args.bootstrap })

    this._gitDir = args.gitDir ?? process.env.GIT_DIR ?? null
    this._cwd = args.cwd || process.cwd()
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
    if (this._ownsLocal) await this._local.close()
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

  _git(opts = {}) {
    return {
      ...opts,
      cwd: this._cwd,
      env: this._gitDir ? { ...process.env, GIT_DIR: this._gitDir } : process.env
    }
  }

  _output(message, newline = true) {
    this._write(message + (newline ? '\n' : ''))
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
  // They go from the store to disk as the walk finds them, so nothing is held but their oids.
  async fetch() {
    this._debug(`Fetch: ${this._pendingFetches.size}`)

    if (this._refused) throw new Error(`option ${this._refused} is not supported`)

    if (this._showProgress) this._progressReporter.startCounting('Receiving objects')

    const gip = this
    // One seen set across refs: shared history is walked once, not once per ref.
    const seen = new Set()
    let count = 0
    let bytes = 0

    const walk = async function* (oid) {
      for await (const object of gip._remoteDb.refObjects(oid, { seen })) {
        bytes += object.size
        if (++count % 256 === 0 && gip._showProgress) gip._progressReporter.updateCount(count)
        yield object
      }
    }

    const objects = async function* () {
      for (const [oid, name] of gip._pendingFetches) {
        gip._debug(`Fetch: ${oid} ${name}`)
        yield* walk(oid)
        if (!seen.has(oid)) throw new Error(`Remote has no object ${oid} (${name})`)
      }

      if (!gip._followTags) return
      for (const ref of await gip._remoteDb.getAllRefs()) {
        if (ref.peeled && seen.has(ref.peeled)) yield* walk(ref.oid)
      }
    }

    this._debug(`Rebuilding repo`)
    await toDisk({ gitDir: this._gitDir, objectFormat: 'sha1', objects: objects() })
    this._debug(`Done rebuilding`)

    this._pendingFetches.clear()

    if (this._showProgress) {
      this._progressReporter.finishCounting(count)
      this._progressReporter.reportInfo(
        `Receiving objects: 100% (${count}/${count}), ${this._progressReporter._formatBytes(bytes)}, done.`
      )
    }

    this._output('')
  }

  async push() {
    const batch = this._pendingPushes
    this._pendingPushes = []

    // A versioned remote is a fixed position in the log. Refuse every ref up front rather than
    // enumerating objects for a push that cannot land. Deletes ride in the same batch now, as
    // updates with no src, so one loop covers both.
    if (this._remoteDb.pinned) {
      const { fork, length } = this._remoteDb.version
      const reason = `remote is pinned to ${fork}.${length} — push to an unversioned link`

      for (const update of batch) this._output(`error ${update.dst} ${reason}`)
      this._output('')
      return
    }

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

    const tips = pushes.map((update) => update.oid)
    // Anything the remote points at that we also have is a "have" — never re-sent.
    const haves = pushes.length > 0 ? await this._localOids([...new Set(current.values())]) : []

    if (pushes.length > 0 && (await this._crossesShallow(tips, haves))) {
      for (const update of pushes) update.error = 'shallow update not allowed'
      if (this._atomic) return
    }

    let stored = false
    let written = 0
    let bytes = 0

    const objects = async function* (gip) {
      if (gip._showProgress) gip._progressReporter.startWriting()

      for await (const object of gip._catObjects(tips, haves)) {
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

    if (this._showProgress && written > 0) {
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
      const result = await sh.exec('git', ['symbolic-ref', '-q', 'HEAD'], this._git())
      const headRef = result.stdout.toString().trim()
      if (result.status !== 0 || !headRef.startsWith('refs/heads/')) return

      // Authoritative only for a branch this push actually moved. Accepting one that merely
      // exists on the remote repointed HEAD at a branch the push never touched, so a clone
      // got that branch's older commit instead of the one just pushed.
      const update = updates.find((update) => update.dst === headRef && !update.error)
      if (!update || !update.oid) return

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
    const result = await sh.exec(
      'git',
      ['cat-file', '--batch-check'],
      this._git({ input: oids.join('\n') + '\n' })
    )
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

    const result = await sh.exec(
      'git',
      ['cat-file', '--batch-check=%(objectname)'],
      this._git({ input: names.join('\n') + '\n' })
    )
    const lines = result.stdout.toString('utf8').split('\n')
    names.forEach((name, i) => oids.set(name, lines[i]))
    return oids
  }

  async _isAncestor(ancestor, oid) {
    const result = await sh.exec('git', ['merge-base', '--is-ancestor', ancestor, oid], this._git())
    return result.status === 0
  }

  // A commit git only has the grafted end of cannot be sent whole.
  async _crossesShallow(tips, haves) {
    const result = await sh.exec(
      'git',
      ['rev-parse', '--is-shallow-repository', '--git-path', 'shallow'],
      this._git()
    )
    const [shallow, file] = result.stdout.toString().trim().split('\n')
    if (shallow !== 'true') return false

    const grafted = new Set(fs.readFileSync(file, 'utf8').split('\n'))
    const commits = await sh.exec(
      'git',
      ['rev-list', '--stdin'],
      this._git({ input: revisions(tips, haves) })
    )
    return commits.stdout
      .toString()
      .split('\n')
      .some((oid) => grafted.has(oid))
  }

  // Every object the remote lacks, one at a time. rev-list feeds cat-file through a pipe and
  // the consumer sets the pace of both, so a push holds the object in flight and nothing else.
  async *_catObjects(tips, haves) {
    const list = spawn('git', ['rev-list', '--objects', '--stdin'], this._git())
    const child = spawn(
      'git',
      ['cat-file', '--batch=%(objectname) %(objecttype) %(objectsize) %(rest)'],
      this._git()
    )
    const exits = [list, child].map((git) => new Promise((resolve) => git.on('exit', resolve)))

    list.stderr.on('data', () => {})
    child.stderr.on('data', () => {})
    // A git that dies early shows up as its exit code below.
    child.stdin.on('error', () => {})

    list.stdout.pipe(child.stdin)
    list.stdin.end(revisions(tips, haves))

    const next = reader(child.stdout)
    let buffer = b4a.alloc(0)
    let count = 0

    const more = async () => {
      const chunk = await next()
      if (chunk === null) return false
      buffer = buffer.byteLength > 0 ? b4a.concat([buffer, chunk]) : chunk
      return true
    }

    // The next `size` bytes of cat-file's output, as they arrive.
    const payload = async function* (size) {
      while (size > 0) {
        if (buffer.byteLength === 0 && !(await more())) throw new Error('git cat-file ended early')
        const part = buffer.subarray(0, size)
        buffer = buffer.subarray(part.byteLength)
        size -= part.byteLength
        yield part
      }
    }

    try {
      for (;;) {
        let newline = buffer.indexOf(10)
        while (newline === -1 && (await more())) newline = buffer.indexOf(10)
        if (newline === -1) break

        const header = this._parseHeader(b4a.toString(buffer.subarray(0, newline)))
        buffer = buffer.subarray(newline + 1)

        const object = { oid: header.sha1, type: header.type, size: header.size }
        const parts = payload(header.size)

        // A large blob is handed on as it is read, and the store writes it chunk by chunk.
        if (header.type === 'blob' && header.size > STREAMED_BLOB) {
          // No return(): a consumer that stops early must not end the read of the payload.
          object.chunks = { [Symbol.asyncIterator]: () => ({ next: () => parts.next() }) }
        } else {
          const read = []
          for await (const part of parts) read.push(part)
          object.data = read.length === 1 ? read[0] : b4a.concat(read)
        }

        count++
        yield object

        // What the consumer left unread, then the newline that ends every object.
        while (!(await parts.next()).done);
        if (buffer.byteLength === 0) await more()
        buffer = buffer.subarray(1)
      }

      const [listed, read] = await Promise.all(exits)
      if (listed !== 0) throw new Error(`git rev-list failed (${listed})`)
      if (read !== 0) throw new Error(`git cat-file failed (${read})`)
      this._debug(`Parsed ${count} objects`)
    } finally {
      list.kill()
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

// Pulls chunks off a child's stdout, pausing it while the consumer is behind. Not the stream's
// own async iterator: bare-subprocess resumes stdio when the child exits, and what a stream
// with no 'data' listener reads then is dropped, so a slow consumer lost the end of the output.
function reader(stream) {
  const queue = []
  let ended = false
  let failed = null
  let wake = null

  const wakeup = () => {
    if (wake) wake()
    wake = null
  }

  stream.on('data', (chunk) => {
    if (queue.push(chunk) === 16) stream.pause()
    wakeup()
  })
  stream.on('error', (err) => {
    failed = err
    wakeup()
  })
  stream.on('close', () => {
    ended = true
    wakeup()
  })

  return async function next() {
    while (queue.length === 0) {
      if (failed) throw failed
      if (ended) return null
      await new Promise((resolve) => (wake = resolve))
    }

    if (queue.length === 16) stream.resume()
    return queue.shift()
  }
}

function revisions(tips, haves) {
  return tips.concat(haves.map((oid) => '^' + oid)).join('\n') + '\n'
}

module.exports = {
  Gip
}
