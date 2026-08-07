const process = require('process')
const { spawn } = require('child_process')
const sh = require('./bare-sh')
const ReadyResource = require('ready-resource')
const { toDisk } = require('gip-remote/git')
const { GipLocalDB } = require('./db')
const { ProgressReporter } = require('./progress')

function parseRefValue(value) {
  const [oid, ref] = value.split(' ')
  return { ref, oid }
}

function formatRef(r) {
  if (r.symref) return `@${r.symref} ${r.ref}`
  return `${r.oid} ${r.ref}`
}

class Gip extends ReadyResource {
  _verbosity = 1
  _progress = false
  _followTags = false
  _cloning = false
  _pendingPushes = new Set()
  _pendingDeletes = new Set()
  _pushRemoteRefs = new Map()
  _pendingFetches = new Map()
  _loadedRefs = new Set()
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

    this._local = new GipLocalDB({ dir: args.dir })
  }

  get remote() {
    return this._remoteDb
  }

  async _open() {
    this._progressReporter.connecting()

    await this._local.ready()

    const remote = await this._local.openRemote(this._link)

    if (!remote) {
      throw new Error('Failed to join remote')
    }

    this._remoteDb = remote
    this._progressReporter.connected(remote)
  }

  async _close() {
    await this._local.close()
  }

  setProgress(progress) {
    this._debug('Setting progress to ' + progress)
    this._progress = progress || false
  }

  setVerbosity(verbosity) {
    this._debug('Setting verbosity to ' + verbosity)
    this._verbosity = verbosity
  }

  setCloning(cloning) {
    this._debug('Setting cloning to ' + cloning)
    this._cloning = cloning || false
  }

  setFollowTags(followTags) {
    this._debug('Setting followTags to ' + followTags)
    this._followTags = followTags || false
  }

  _writeLog(message) {
    process.stderr.write(message + '\n')
  }

  _info(message) {
    this._writeLog('Gip [INFO]: ' + message)
  }

  _error(message) {
    this._writeLog('Gip [ERROR]: ' + message)
  }

  _debug(message) {
    // we receive as a string, parsing is just room for error
    // eslint-disable-next-line eqeqeq
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
    process.stdout.write(message + (newline ? '\n' : ''))
    this._echo(message)
  }

  hasPendingFetch() {
    return this._pendingFetches.size > 0
  }

  async listForPush() {
    this._verbose('Listing for push to ' + this._remoteName)

    // List remote refs so git can compare against local refs
    const remoteRefs = await this._remoteDb.getAllRefs()

    for (const ref of remoteRefs) {
      this._debug(`Remote ref: ${formatRef(ref)}`)
      this._output(formatRef(ref))
    }

    this._output('')
  }

  async addPushRefs(refs) {
    this._debug(`Add push refs: ${refs}`)

    const [local, remote] = refs.split(':')

    // Empty local ref means delete (git push --delete)
    if (!local) {
      this._debug(`Add to pending deletes: ${remote}`)
      this._pendingDeletes.add(remote)
      return
    }

    this._pushRemoteRefs.set(local, remote)

    // Resolve the local ref to its OID
    const result = await sh.exec('git', ['rev-parse', local])
    const oid = result.stdout.toString().trim()

    if (oid) {
      const r = { ref: local, oid }
      this._debug(`Add to pending: ${formatRef(r)}`)
      this._pendingPushes.add(r)
    }
  }

  prepareFetch(ref) {
    this._debug(`Prepare fetch: ${ref}`)

    const r = parseRefValue(ref)
    const key = formatRef(r)

    if (this._loadedRefs.has(key) && !this._pendingFetches.has(key)) {
      this._debug(`Add to pending: ${key}`)
      this._pendingFetches.set(key, r)
    }
  }

  /**
   * Used by fetch, pull and clone
   *
   * @returns {Promise<void>}
   */
  async fetch() {
    this._debug(`Fetch: ${this._pendingFetches.size}`)

    if (this._progress && this._pendingFetches.size > 0) {
      this._progressReporter.startCounting('Receiving objects')
    }

    // Collect all unique objects across all pending fetches. Branches and
    // tags share most history — one `seen` set across the refs makes the
    // remote walk each object once instead of once per ref.
    const allObjects = new Map()
    const allRefs = {}
    const seen = new Set()
    let objectCount = 0

    for (const [key, ref] of this._pendingFetches) {
      if (ref.ref === 'HEAD') {
        this._pendingFetches.delete(key)
        continue
      }

      this._debug(`Fetch: ${formatRef(ref)}`)

      const objects = await this._remoteDb.getRefObjects(
        ref.oid,
        () => {
          objectCount++
          if (this._progress) this._progressReporter.updateCount(objectCount)
        },
        { seen }
      )

      this._debug(`Objects for ref: ${objects.length}`)

      for (const obj of objects) {
        if (!allObjects.has(obj.id)) allObjects.set(obj.id, obj)
      }

      allRefs[ref.ref] = ref.oid
      this._pendingFetches.delete(key)
    }

    const totalObjectCount = allObjects.size
    const receivedBytes = [...allObjects.values()].reduce((acc, obj) => acc + obj.size, 0)

    if (totalObjectCount > 0) {
      this._debug(`Total unique objects: ${totalObjectCount}`)
      this._debug(`Rebuilding repo`)

      await toDisk({
        gitDir: process.env.GIT_DIR,
        objectFormat: 'sha1',
        objects: [...allObjects.values()],
        refs: this._cloning ? undefined : allRefs
      })

      this._debug(`Done rebuilding`)
    }

    if (this._progress && totalObjectCount > 0) {
      this._progressReporter.finishCounting(totalObjectCount)
      this._progressReporter.reportInfo(
        `Receiving objects: 100% (${totalObjectCount}/${totalObjectCount}), ${this._progressReporter._formatBytes(receivedBytes)}, done.`
      )
    }

    this._output('')
  }

  _sendPacket(data) {
    // Calculate packet length: data length + 4 bytes for the length prefix
    const length = data.length + 4
    // Convert length to 4-byte hexadecimal (e.g., '0010' for length 16)
    const lengthHex = length.toString(16).padStart(4, '0')

    // Write length prefix and data to stdout
    process.stdout.write(Buffer.from(lengthHex, 'ascii'))
    process.stdout.write(data)
  }

  _sendFlush() {
    // Write flush packet
    process.stdout.write(Buffer.from('0000', 'ascii'))
  }

  /**
   * List and store refs for later use by fetch
   */
  async listAndStoreRefs() {
    const refs = await this.list()

    this._debug(`[listAndStoreRefs] Refs: ${refs}`)

    for (const ref of refs) {
      this._loadedRefs.add(formatRef(ref))
    }
  }

  async list() {
    this._debug('Listing refs')

    const refs = await this._remoteDb.getAllRefs()

    if (!this.remote.availablePeers && !refs.length) {
      throw new Error(`Repo not found, peers required`)
    }

    this._debug(`[list] Refs: ${refs}`)

    refs.forEach((ref) => this._output(formatRef(ref)))
    this._output('')

    return refs
  }

  async push() {
    this._verbose(
      `Pushing refs: ${this._pendingPushes.size}, deleting refs: ${this._pendingDeletes.size}`
    )

    // Handle deletes first
    for (const ref of this._pendingDeletes) {
      const isTag = ref.startsWith('refs/tags/')
      const name = isTag ? ref.replace('refs/tags/', '') : ref.replace('refs/heads/', '')

      this._debug(`Deleting ${isTag ? 'tag' : 'branch'}: ${name}`)

      try {
        const deleted = isTag
          ? await this._remoteDb.deleteTag(name)
          : await this._remoteDb.deleteBranch(name)

        if (deleted) {
          this._info(`Deleted ${isTag ? 'tag' : 'branch'} ${name}`)
          this._output(`ok ${ref}`)
        } else {
          this._output(`error ${ref} ${isTag ? 'tag' : 'branch'} not found`)
        }
      } catch (e) {
        this._debug(`Delete error: ${e.message}`)
        this._output(`error ${ref} ${e.message}`)
      }

      this._pendingDeletes.delete(ref)
    }

    if (this._pendingPushes.size === 0) {
      this._output('')
      return
    }

    // Negotiate the delta: everything the remote's refs point at that we
    // also have locally is a "have" — objects reachable from those never
    // need to be sent again.
    const remoteRefs = (await this._remoteDb.getAllRefs()).filter((r) => !r.symref)
    const remoteByRef = new Map(remoteRefs.map((r) => [r.ref, r.oid]))
    const haves = await this._localOids([...new Set(remoteRefs.map((r) => r.oid))])

    // Refs already at the right oid are done — report ok without any walk.
    const toPush = []
    for (const ref of this._pendingPushes) {
      const remoteRef = this._pushRemoteRefs.get(ref.ref) ?? ref.ref
      if (remoteByRef.get(remoteRef) === ref.oid) {
        this._debug(`Up to date: ${formatRef(ref)}`)
        this._output(`ok ${ref.ref}`)
        this._pendingPushes.delete(ref)
      } else {
        toPush.push(ref)
      }
    }

    if (toPush.length === 0) {
      await this._syncHead(remoteByRef, [])
      this._output('')
      return
    }

    if (this._progress) {
      this._progressReporter.startCounting('Enumerating objects')
    }

    // One delta walk + one cat-file for the union of refs: only objects the
    // remote doesn't have get inflated, once, no matter how many refs share
    // history. Tips are always included — a ref can point at an object the
    // remote already reaches (new branch at an old commit) and the indexer
    // needs it to parse.
    const newOids = await this._revListOids(
      toPush.map((r) => r.oid),
      haves
    )
    for (const ref of toPush) newOids.add(ref.oid)

    if (this._progress) {
      this._progressReporter.finishCounting(newOids.size)
      this._progressReporter.startWriting()
    }

    const objects = await this._catObjects([...newOids])

    let writtenObjects = 0
    let writtenBytes = 0

    for (const ref of toPush) {
      const localRef = ref.ref
      const remoteRef = this._pushRemoteRefs.get(localRef)
      const pushedRef = remoteRef ? { ref: remoteRef, oid: ref.oid } : ref
      const isTag = pushedRef.ref.startsWith('refs/tags/')
      const branchName = isTag
        ? 'tags/' + pushedRef.ref.replace('refs/tags/', '')
        : pushedRef.ref.replace('refs/heads/', '')

      try {
        if (this._progress) {
          this._progressReporter.updateWriting(writtenObjects, writtenBytes)
        }

        // Push objects + index branch + files in one operation. The object
        // set is thin (shared across refs, delta only) — the remote resolves
        // anything else from its store.
        await this._remoteDb.push(branchName, pushedRef.oid, objects)

        writtenObjects += objects.size
        for (const [, value] of objects) {
          writtenBytes += value.size
        }

        if (this._progress) {
          this._progressReporter.updateWriting(writtenObjects, writtenBytes)
        }

        this._debug(`Pushed with ref: ${formatRef(pushedRef)}`)

        this._output(`ok ${pushedRef.ref}`)
        this._pendingPushes.delete(ref)
      } catch (e) {
        this._debug(`Push error: ${e.message}`)
        if (this._progress) {
          this._progressReporter.reportError(`Failed to push ${formatRef(pushedRef)}: ${e.message}`)
        }
        this._output(`error ${formatRef(pushedRef)} ${e.message}`)
      }
    }

    await this._syncHead(remoteByRef, toPush)

    if (this._progress) {
      this._progressReporter.finishWriting()
    }

    this._output('')
  }

  /**
   * The remote defaults its head to the first branch pushed, but `git push
   * --all` sends branches alphabetically — an old feature branch beats main.
   * The local repo's HEAD is authoritative: whenever the remote has that
   * branch (pushed just now or already there), mirror it onto the remote.
   */
  async _syncHead(remoteByRef, pushed) {
    try {
      const result = await sh.exec('git', ['symbolic-ref', 'HEAD'])
      const headRef = result.stdout.toString().trim()
      if (result.status !== 0 || !headRef.startsWith('refs/heads/')) return

      const pushedOk = pushed.some(
        (ref) =>
          !this._pendingPushes.has(ref) &&
          (this._pushRemoteRefs.get(ref.ref) ?? ref.ref) === headRef
      )
      if (!pushedOk && !remoteByRef.has(headRef)) return

      const branch = headRef.slice('refs/heads/'.length)
      if ((await this._remoteDb.getHead()) !== branch) {
        this._debug(`Setting head to ${branch}`)
        await this._remoteDb.setHead(branch)
      }
    } catch (e) {
      this._debug(`Head sync error: ${e.message}`)
    }
  }

  /**
   * Filter oids down to the ones the local repo actually has — remote refs
   * we've never fetched can't be used as haves.
   */
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

  /**
   * Reachable object oids for the given tips, minus everything reachable
   * from `haves` — a pure graph walk, no content.
   *
   * @returns {Promise<Set<string>>}
   */
  async _revListOids(tips, haves = []) {
    const args = ['rev-list', '--objects'].concat(tips)
    if (haves.length) args.push('--not', ...haves)

    const result = await sh.exec('git', args)
    if (result.status !== 0) {
      throw new Error(`git rev-list failed: ${result.stderr || result.stdout}`)
    }

    const oids = new Set()
    for (const line of result.stdout.toString('utf8').split('\n')) {
      if (line.length >= 40) oids.add(line.slice(0, 40))
    }
    // Tips are emitted for commits but not for annotated tag objects — git
    // dereferences tags; make sure the tag objects themselves are included.
    for (const tip of [].concat(tips)) oids.add(tip)
    return oids
  }

  /**
   * Inflate the given objects via `git cat-file --batch`, parsing the stream
   * incrementally — no full-output buffer, no quadratic concat.
   *
   * @returns {Promise<Map<string, {sha1: string, type: string, size: number, data: Buffer}>>}
   */
  _catObjects(oids) {
    const objects = new Map()
    if (oids.length === 0) return Promise.resolve(objects)

    return new Promise((resolve, reject) => {
      const child = spawn('git', ['cat-file', '--batch'])

      // Incremental parser state: buffered unparsed chunks, and — while
      // inside an object's payload — the header plus collected pieces.
      let pending = Buffer.alloc(0)
      let header = null
      let parts = []
      let partBytes = 0

      const parse = (chunk) => {
        pending = pending.byteLength ? Buffer.concat([pending, chunk]) : chunk

        for (;;) {
          if (header) {
            const want = header.size - partBytes
            if (pending.byteLength < want + 1) {
              // Mid-payload — move everything into parts so `pending` stays
              // empty and the next chunks take the no-copy fast path.
              if (pending.byteLength > 0) {
                parts.push(pending)
                partBytes += pending.byteLength
                pending = Buffer.alloc(0)
              }
              break
            }

            parts.push(pending.subarray(0, want))
            objects.set(header.sha1, {
              sha1: header.sha1,
              type: header.type,
              size: header.size,
              data: parts.length === 1 ? parts[0] : Buffer.concat(parts)
            })
            pending = pending.subarray(want + 1)
            header = null
            parts = []
            partBytes = 0
            continue
          }

          const newline = pending.indexOf(10)
          if (newline === -1) break

          header = this._parseHeader(pending.subarray(0, newline).toString('utf8'))
          pending = pending.subarray(newline + 1)
        }
      }

      child.stdout.on('data', (chunk) => {
        if (header && pending.byteLength === 0 && partBytes + chunk.byteLength <= header.size) {
          // Fast path: chunk is entirely payload — no buffer joins.
          parts.push(chunk)
          partBytes += chunk.byteLength
          return
        }
        parse(chunk)
      })

      child.stderr.on('data', () => {})
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code !== 0) return reject(new Error(`git cat-file failed (${code})`))
        this._debug(`Parsed ${objects.size} objects`)
        resolve(objects)
      })

      child.stdin.write(oids.join('\n') + '\n')
      child.stdin.end()
    })
  }

  _parseHeader(line) {
    const match = line.match(/^([0-9a-f]{40}) (\w+) (\d+)$/)
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

module.exports = {
  Gip
}
