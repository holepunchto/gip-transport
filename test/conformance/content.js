const fs = require('fs')
const path = require('path')
const b4a = require('b4a')
const conform = require('../helpers/conformance')

// Ref names and object shapes that have to survive a push and a fresh clone
// bit for bit: the clone's object list and fsck are compared with file://.
// Names from t1400/t3200 (refs), t5516 (odd ref names); content from
// t0020 (crlf), t3600/t4000 (modes), t7400 (gitlinks), t7600 (octopus),
// t3900 (i18n), t7510 (signed commits), t6000 (timestamps).

function content(name, opts, build) {
  if (typeof opts === 'function') return content(name, {}, opts)

  conform(name, opts, async (w) => {
    await build(w)
    await w.publish()
  })
}

content('a branch name with slashes', async (w) => {
  await w.commit('one')
  await w.ok(['branch', 'feature/deep/er/name'])
})

content('unicode branch and tag names', async (w) => {
  await w.commit('one')
  await w.ok(['branch', 'héllo/✓-ブランチ'])
  await w.ok(['tag', 'v✓'])
})

// A branch really called tags/foo must not become the tag foo, or shadow it.
content('a branch named tags/foo next to a tag foo', async (w) => {
  await w.commit('one')
  await w.ok(['tag', 'foo'])
  await w.commit('two')
  await w.ok(['branch', 'tags/foo'])
})

content('a branch named tags/foo and no such tag', async (w) => {
  await w.commit('one')
  await w.ok(['branch', 'tags/foo'])
})

// t1400: refs/heads/HEAD is a legal ref
content('a branch named HEAD', async (w) => {
  await w.commit('one')
  await w.commit('two')
  await w.ok(['update-ref', 'refs/heads/HEAD', 'HEAD~1'])
})

content('a branch named like a full ref', async (w) => {
  await w.commit('one')
  await w.ok(['branch', 'refs/heads/main'])
})

// Reftable keeps the local side honest on case-insensitive filesystems.
content(
  'branch names that differ only by case',
  { env: { GIT_DEFAULT_REF_FORMAT: 'reftable' } },
  async (w) => {
    await w.commit('one')
    await w.ok(['branch', 'Topic'])
    await w.commit('two')
    await w.ok(['branch', 'topic'])
  }
)

content('a branch name over 255 bytes', async (w) => {
  await w.commit('one')
  await w.ok(['branch', ['a', 'b', 'c'].map((c) => c.repeat(100)).join('/')])
})

content('odd path names', async (w) => {
  w.write('dir with space/file name.txt', 'spaces\n')
  w.write('ünïcödé/日本語.txt', 'unicode\n')
  w.write('-leading-dash', 'dash\n')
  w.write('trailing.dot./x', 'dot\n')
  w.write('a/b/c/d/e/f/g/h/deep.txt', 'deep\n')
  await w.commit('one')
})

// t0020: no line-ending conversion, no byte left behind
content('CRLF and binary bytes', async (w) => {
  w.write('crlf.txt', 'one\r\ntwo\r\n')
  w.write('mixed.txt', 'one\ntwo\r\nthree\r')
  w.write('bytes.bin', b4a.from(Array.from({ length: 512 }, (_, i) => i % 256)))
  await w.commit('one')
})

content('an executable file', async (w) => {
  w.write('run.sh', '#!/bin/sh\n')
  fs.chmodSync(path.join(w.repo, 'run.sh'), 0o755)
  await w.commit('one')
})

content('a symlink', async (w) => {
  fs.symlinkSync('one.txt', path.join(w.repo, 'link'))
  fs.symlinkSync('nowhere/at/all', path.join(w.repo, 'dangling'))
  await w.commit('one')
})

// t7400: mode 160000, pointing at a commit the remote will never have
content('a submodule gitlink', async (w) => {
  await w.commit('one')
  await w.ok(['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},sub`])
  await w.ok(['commit', '-qm', 'gitlink'])
})

content('an empty root tree', async (w) => {
  await w.ok(['commit', '-q', '--allow-empty', '-m', 'nothing'])
})

content('an empty blob', async (w) => {
  w.write('empty', '')
  await w.commit('one')
})

content('an empty commit', async (w) => {
  await w.commit('one')
  await w.ok(['commit', '-q', '--allow-empty', '-m', 'same tree'])
})

// t7600 "merge c1 with c2 and c3"
content('an octopus merge', async (w) => {
  await w.commit('one')
  for (const name of ['a', 'b']) {
    await w.ok(['checkout', '-q', '-b', name, 'main'])
    await w.commit(name)
  }
  await w.ok(['checkout', '-q', 'main'])
  await w.ok(['merge', '-q', '--no-edit', 'a', 'b'])
})

content('a merge with eight parents', async (w) => {
  const base = await w.commit('one')
  const parents = []
  for (let i = 0; i < 8; i++) {
    parents.push('-p', await w.ok(['commit-tree', `${base}^{tree}`, '-p', base, '-m', `p${i}`]))
  }
  const merge = await w.ok(['commit-tree', `${base}^{tree}`, ...parents, '-m', 'eight'])
  await w.ok(['update-ref', 'refs/heads/main', merge])
})

// t3900: the message bytes are latin-1, the header says so
content('a commit with a non-UTF-8 encoding header', async (w) => {
  w.write('one.txt', 'one\n')
  w.write('../message', b4a.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
  await w.ok(['add', '-A'])
  await w.ok(['-c', 'i18n.commitEncoding=ISO-8859-1', 'commit', '-q', '-F', '../message'])
})

// t7510: the gpgsig header is part of the object, continuation lines and all
content('a signed commit', async (w) => {
  const base = await w.commit('one')
  const tree = await w.ok(['rev-parse', `${base}^{tree}`])
  const signed = await w.ok(['hash-object', '-t', 'commit', '-w', '--stdin'], {
    input:
      `tree ${tree}\n` +
      `parent ${base}\n` +
      'author t <t@t.t> 1700000000 +0000\n' +
      'committer t <t@t.t> 1700000000 +0000\n' +
      'gpgsig -----BEGIN PGP SIGNATURE-----\n' +
      ' \n' +
      ' iQEzBAABCAAdFiEEnotarealsignaturebutthebytesmustsurviveAAoJEA==\n' +
      ' =abcd\n' +
      ' -----END PGP SIGNATURE-----\n' +
      '\n' +
      'signed\n'
  })
  await w.ok(['update-ref', 'refs/heads/main', signed])
})

// t6000-series: a child older than its parent
content('non-monotonic commit timestamps', async (w) => {
  const date = (seconds) => ({
    env: { GIT_AUTHOR_DATE: `${seconds} +0000`, GIT_COMMITTER_DATE: `${seconds} +0000` }
  })
  await w.commit('future', date(2000000000))
  await w.commit('past', date(1000000000))
  await w.commit('epoch', date(1))
})
