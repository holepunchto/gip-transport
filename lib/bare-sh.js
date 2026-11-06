const fs = require('fs')
const os = require('os')
const path = require('path')
const process = require('process')
const { spawn, spawnSync } = require('child_process')
const { isWindows } = require('which-runtime')

const TRACE = process.env.GIP_TRACE || null
const trace = TRACE
  ? (message) => {
      try {
        fs.appendFileSync(TRACE, `+? [${process.pid}] ${message}\n`)
      } catch {}
    }
  : () => {}

let serial = 0

// Windows cannot use the async path below: a child's 'exit' never arrives, so awaiting it
// hangs the remote helper mid-push. spawnSync is what works there — the test harness
// drives git through it on Windows already. Its own output buffers are fixed-size
// preallocations that truncate silently past maxBuffer, which would quietly shorten
// `rev-list --objects`, so stdio goes to files: no size limit, and no pipe handed to a
// child that has no use for one.
function execFile(cmd, args, opts = {}) {
  const base = path.join(os.tmpdir(), `gip-sh-${process.pid}-${serial++}`)
  const files = [base + '.in', base + '.out', base + '.err']
  const [inFile, outFile, errFile] = files
  const open = []

  try {
    if (opts.input) fs.writeFileSync(inFile, opts.input)

    const stdin = opts.input ? fs.openSync(inFile, 'r') : 'ignore'
    if (typeof stdin === 'number') open.push(stdin)
    const stdout = fs.openSync(outFile, 'w')
    open.push(stdout)
    const stderr = fs.openSync(errFile, 'w')
    open.push(stderr)

    trace(`execFile spawnSync begin: ${cmd} ${args.join(' ')}`)
    const result = spawnSync(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: [stdin, stdout, stderr]
    })
    trace(
      `execFile spawnSync returned: status=${result.status} pid=${result.pid} error=${result.error ? result.error.message : 'none'}`
    )

    while (open.length) fs.closeSync(open.pop())

    if (result.error) throw result.error

    return {
      stdout: fs.readFileSync(outFile),
      stderr: fs.readFileSync(errFile),
      status: result.status ?? 0
    }
  } finally {
    for (const fd of open) {
      try {
        fs.closeSync(fd)
      } catch {}
    }
    for (const file of files) {
      try {
        fs.unlinkSync(file)
      } catch {}
    }
  }
}

async function exec(cmd, args, opts = {}) {
  trace(`sh.exec enter (${isWindows ? 'sync/file' : 'async/pipe'}): ${cmd} ${args.join(' ')}`)
  const result = isWindows ? execFile(cmd, args, opts) : await execAsync(cmd, args, opts)
  trace(`sh.exec leave: ${cmd} status=${result.status}`)
  return result
}

function execAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: opts.input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']
    })

    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)

    child.stdout.on('data', (data) => {
      stdout = Buffer.concat([stdout, data])
    })

    child.stderr.on('data', (data) => {
      stderr = Buffer.concat([stderr, data])
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('exit', (code) => {
      resolve({
        stdout,
        stderr,
        status: code ?? 0
      })
    })

    if (opts.input) {
      child.stdin.write(opts.input)
      child.stdin.end()
    }
  })
}

function cat(filePath, cmd, opts = {}) {
  return pipe(`cat ${filePath}`, { cwd: opts.cwd, env: opts.env }).pipe(cmd).exec()
}

function pipe(initialCmd, opts = {}) {
  return new PipeChain(initialCmd, opts)
}

class PipeChain {
  constructor(initialCmd, opts = {}) {
    this.commands = [initialCmd]
    this.opts = opts
  }

  pipe(cmd) {
    this.commands.push(cmd)
    return this
  }

  exec() {
    return new Promise((resolve, reject) => {
      if (this.commands.length === 0) {
        reject(new Error('No commands to execute'))
        return
      }

      // Build the pipeline command
      const pipelineCmd = this.commands.join(' | ')

      const child = spawn('sh', ['-c', pipelineCmd], {
        cwd: this.opts.cwd,
        env: this.opts.env,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let stdout = Buffer.alloc(0)
      let stderr = Buffer.alloc(0)

      child.stdout.on('data', (data) => {
        stdout = Buffer.concat([stdout, data])
      })

      child.stderr.on('data', (data) => {
        stderr = Buffer.concat([stderr, data])
      })

      child.on('error', (error) => {
        reject(error)
      })

      child.on('exit', (code) => {
        resolve({
          stdout,
          stderr,
          status: code ?? 0
        })
      })
    })
  }
}

module.exports = {
  exec,
  cat,
  pipe
}
