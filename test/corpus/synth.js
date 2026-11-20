const fs = require('fs')
const b4a = require('b4a')

const { git, sh } = require('./harness')

const WHO = 'gip <gip@corpus.test> 1700000000 +0000'

// Stressors are written as one fast-import stream each: no worktree, no index,
// no process per object.
async function fastImport(dest, write) {
  await git(['-c', 'init.defaultBranch=main', 'init', '-q', '--bare', dest])

  const stream = dest + '.fast-import'
  const fd = fs.openSync(stream, 'w')
  let pending = []
  const flush = () => {
    fs.writeSync(fd, b4a.from(pending.join('')))
    pending = []
  }
  write({
    text(chunk) {
      pending.push(chunk)
      if (pending.length >= 4096) flush()
    },
    bytes(buffer) {
      flush()
      fs.writeSync(fd, buffer)
    }
  })
  flush()
  fs.closeSync(fd)

  const result = await sh('git -C "$1" fast-import --quiet < "$2"', [dest, stream])
  if (result.status !== 0) throw new Error(`fast-import failed: ${result.stderr}`)
  fs.unlinkSync(stream)
  return dest
}

function commit(out, mark, message, from) {
  out.text(`commit refs/heads/main\nmark :${mark}\ncommitter ${WHO}\n`)
  out.text(`data ${b4a.byteLength(message)}\n${message}\n`)
  if (from) out.text(`from :${from}\n`)
}

// Half lightweight, half annotated, spread over one commit per hundred tags.
function manyTags(dest, count) {
  return fastImport(dest, (out) => {
    let mark = 0
    for (let i = 0; i < count; i++) {
      if (i % 100 === 0) {
        commit(out, mark + 1, `commit ${mark + 1}`, mark)
        out.text(`M 100644 inline file.txt\ndata ${String(i).length + 1}\n${i}\n\n`)
        mark++
      }
      if (i % 2 === 0) {
        out.text(`reset refs/tags/light-${i}\nfrom :${mark}\n\n`)
      } else {
        const message = `annotated ${i}`
        out.text(`tag annotated-${i}\nfrom :${mark}\ntagger ${WHO}\n`)
        out.text(`data ${message.length + 1}\n${message}\n\n`)
      }
    }
  })
}

// One commit, one directory, `count` distinct blobs.
function wideTree(dest, count) {
  return fastImport(dest, (out) => {
    commit(out, 1, 'wide')
    for (let i = 0; i < count; i++) {
      const content = `file ${i}\n`
      out.text(`M 100644 inline wide/f${String(i).padStart(7, '0')}.txt\n`)
      out.text(`data ${content.length}\n${content}\n`)
    }
    out.text('\n')
  })
}

// One commit holding one incompressible blob of exactly `size` bytes.
function bigBlob(dest, size) {
  return fastImport(dest, (out) => {
    out.text(`blob\nmark :1\ndata ${size}\n`)

    const slice = b4a.alloc(1024 * 1024)
    const words = new Uint32Array(slice.buffer, slice.byteOffset, slice.byteLength / 4)
    let x = 0x9e3779b9
    for (let left = size; left > 0; left -= slice.byteLength) {
      for (let i = 0; i < words.length; i++) {
        x ^= x << 13
        x ^= x >>> 17
        x ^= x << 5
        words[i] = x
      }
      out.bytes(left < slice.byteLength ? slice.subarray(0, left) : slice)
    }

    out.text('\n')
    commit(out, 2, 'big')
    out.text('M 100644 :1 big.bin\n\n')
  })
}

// A linear history of `count` small commits, pushed one at a time by the caller.
function chain(dest, count) {
  return fastImport(dest, (out) => {
    for (let i = 1; i <= count; i++) {
      const content = `revision ${i}\n`
      commit(out, i, `commit ${i}`, i - 1)
      out.text(`M 100644 inline dir${i % 7}/file${i % 31}.txt\n`)
      out.text(`data ${content.length}\n${content}\n`)
    }
  })
}

// Two branches, and a HEAD naming a third that does not exist.
async function unbornHead(dest) {
  await fastImport(dest, (out) => {
    commit(out, 1, 'one')
    out.text('M 100644 inline a.txt\ndata 2\na\n\n')
    out.text('reset refs/heads/other\nfrom :1\n\n')
  })
  await git(['symbolic-ref', 'HEAD', 'refs/heads/unborn'], { cwd: dest })
  return dest
}

module.exports = { manyTags, wideTree, bigBlob, chain, unbornHead }
