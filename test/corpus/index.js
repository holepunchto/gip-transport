const test = require('brittle')
const path = require('path')
const process = require('process')

const harness = require('./harness')
const sources = require('./sources')
const synth = require('./synth')

// Opt-in corpus and scale run (plan §4.C): `npm run test:corpus`.
//
//   GIP_CORPUS_QUICK=1          small stressors, an early git/git release, small mirrors
//   GIP_CORPUS_ONLY=<substring> run the matching cases only
//   GIP_CORPUS_TAGS / _FILES / _BLOB_MB / _PUSHES / _GIT_TAG / _MIRRORS / _MIRROR_MAX_MB
//   GIP_CORPUS_CACHE            where pinned downloads are kept
//   GIP_CORPUS_MIRROR           directory of bare clones to reuse as real repos
//   GIP_CORPUS_REPORT           where the JSON report goes
//   GIP_CORPUS_TIMEOUT_MIN      per git command, default 30
const ENABLED = process.env.GIP_CORPUS === '1'
const QUICK = process.env.GIP_CORPUS_QUICK === '1'
const ONLY = process.env.GIP_CORPUS_ONLY || ''

// gip-remote/lib/objects.js OBJECT_CHUNK_SIZE: larger objects are split across rows.
const CHUNK = 8 * 1024 * 1024

const scale = {
  tags: number('GIP_CORPUS_TAGS', QUICK ? 200 : 10000),
  files: number('GIP_CORPUS_FILES', QUICK ? 2000 : 100000),
  blobMB: number('GIP_CORPUS_BLOB_MB', QUICK ? 17 : 100),
  pushes: number('GIP_CORPUS_PUSHES', QUICK ? 20 : 1000),
  gitTag: process.env.GIP_CORPUS_GIT_TAG || (QUICK ? 'v1.0.0' : 'v2.50.1'),
  mirrors: number('GIP_CORPUS_MIRRORS', QUICK ? 3 : 10),
  mirrorMaxMB: number('GIP_CORPUS_MIRROR_MAX_MB', QUICK ? 2 : Infinity)
}

// Known failures, named once. Every case carrying one still runs and is measured.
const BUG = {
  tagTarget:
    'a tag of a blob or tree is dropped: Remote.push requires a commit ("Expected commit, got blob"), gip-remote index.js _push',
  mode: 'a tree entry with mode 100664 is unreadable ("Unexpected GitTree entry mode: 100664"), on push and on clone, gip-remote lib/git.js walkTree/treeEntries',
  unsafePath:
    'refs whose tree has a .git or dot-dot path are refused ("Unsafe path") where git stores them, and the push still exits 0',
  empty:
    'an empty remote cannot be listed or cloned ("Repo not found, peers required"), lib/gip.js list',
  head: 'HEAD is invented: with the pusher on an unborn branch the remote HEAD becomes the first branch pushed, gip-remote first-push head default',
  shallow:
    'a push from a shallow repository is not rejected (file:// answers "shallow update not allowed") and exits 0'
}

// libgit2 tests/resources: whole repositories with unusual refs and objects.
const LIBGIT2 = [
  [
    'testrepo.git',
    'packed-refs, loose and packed objects, tag chains, a tag of a blob',
    BUG.tagTarget
  ],
  ['peeled.git', 'packed-refs with peeled tags only'],
  ['short_tag.git', 'annotated tag with no message'],
  ['deprecated-mode.git', 'tree entry with the deprecated 100664 mode', BUG.mode],
  [
    'nasty/.gitted',
    'tree entries named .git, .GIT, dot-dot and backslash variants',
    BUG.unsafePath
  ],
  ['win32-forbidden/.gitted', 'paths that are reserved names on Windows'],
  ['icase/.gitted', 'paths that differ only by case'],
  ['unsymlinked.git', 'symlink entries (mode 120000)'],
  ['filemodes/.gitted', 'executable bit on and off'],
  ['submod2/.gitted', 'submodule gitlinks (mode 160000) with .gitmodules'],
  ['typechanges/.gitted', 'a path that changes between blob, tree, symlink and gitlink'],
  ['merge-recursive/.gitted', 'criss-cross merges across many branches'],
  ['revwalk.git', 'branching history built for revision walks'],
  ['shallow.git', 'shallow source repository (grafted history)', BUG.shallow],
  ['namespace.git', 'refs under refs/namespaces, HEAD on a branch that does not exist', BUG.head]
]

// go-git-fixtures .git tarballs: repositories as left by real git operations.
const GO_GIT_DOT_GIT = [
  ['bf3fedcc8e20fd0dec9172987ceea0038d17b516', 'empty: no refs, no objects', BUG.empty],
  [
    'c0c7c57ab1753ddbd26cc45322299ddd12842794',
    'tags: light, annotated, tag of tag, tag of tree and blob',
    BUG.tagTarget
  ],
  [
    '78c5fb882e76286d8201016cffee63ea7060a0c2',
    'root-references: many branches, remote-tracking refs and a tag'
  ],
  ['174be6bd4292c18160542ae6dc6704b877b8a01a', 'multi-packfile: several packs plus loose objects'],
  [
    '26baa505b9f6fb2024b9999c140b75514718c988',
    'merge-base: branching history built for merge-base lookups'
  ],
  [
    'e1580a78f7d36791249df76df8a2a2613d629902',
    'empty-folder: history of a repository that held an empty directory'
  ]
]

// go-git-fixtures packfiles, indexed byte for byte to keep their delta encoding.
const GO_GIT_PACK = [
  ['a3fed42da1e8189a077c0e6846c040dcf73fc9dd', 'ofs-delta: offset deltas'],
  ['c544593473465e6315ad4182d04d366c4592b829', 'ref-delta: the same objects as reference deltas'],
  [
    '90fedc00729b64ea0d0406db861be081cda25bbf',
    'delta-before-base: a delta stored ahead of its base'
  ],
  [
    '9733763ae7ee6efcf452d373d6fff77424fb1dcc',
    'codecommit: pack served by a non-git implementation'
  ],
  ['bc4b855a55cae7703c023d4e36e3a7c9f5d84491', 'notes: a notes tree next to the history'],
  ['f2e0a8889a746f7600e07d2246a2e29a72f696be', 'spinnaker: a mid-sized real history in one pack']
]

for (const [resource, why, bug] of LIBGIT2) {
  corpus(`libgit2 ${resource}`, { why, bug }, (dir) =>
    sources.libgit2(path.join(dir, 'src.git'), resource)
  )
}

for (const [hash, why, bug] of GO_GIT_DOT_GIT) {
  corpus(`go-git .git ${hash.slice(0, 8)} ${why.split(':')[0]}`, { why, bug }, (dir) =>
    sources.goGitDotGit(path.join(dir, 'src.git'), hash)
  )
}

for (const [hash, why, bug] of GO_GIT_PACK) {
  corpus(`go-git pack ${hash.slice(0, 8)} ${why.split(':')[0]}`, { why, bug }, (dir) =>
    sources.goGitPack(path.join(dir, 'src.git'), hash)
  )
}

for (const name of sources.mirrors(scale.mirrors, scale.mirrorMaxMB)) {
  corpus(`mirror ${name}`, { why: 'real holepunch repository' }, (dir) =>
    sources.mirror(path.join(dir, 'src.git'), name)
  )
}

corpus(`git/git ${scale.gitTag}`, { why: 'deep history', bug: BUG.mode }, (dir) =>
  sources.gitGit(path.join(dir, 'src.git'), scale.gitTag)
)

corpus(
  'synth unborn HEAD',
  { why: 'HEAD names a branch that does not exist', bug: BUG.head },
  (dir) => synth.unbornHead(path.join(dir, 'src.git'))
)

for (const [label, size] of [
  ['chunk size - 1', CHUNK - 1],
  ['chunk size', CHUNK],
  ['chunk size + 1', CHUNK + 1],
  ['2 x chunk size', 2 * CHUNK],
  [`${scale.blobMB} MB`, scale.blobMB * 1024 * 1024]
]) {
  corpus(
    `synth blob of ${label}`,
    { why: `one ${size} byte blob around the chunking threshold` },
    (dir) => synth.bigBlob(path.join(dir, 'src.git'), size)
  )
}

corpus(`synth ${scale.tags} tags`, { why: 'many refs, half of them annotated' }, (dir) =>
  synth.manyTags(path.join(dir, 'src.git'), scale.tags)
)

corpus(`synth ${scale.files} files in one directory`, { why: 'one very wide tree' }, (dir) =>
  synth.wideTree(path.join(dir, 'src.git'), scale.files)
)

corpus(
  `synth ${scale.pushes} sequential pushes`,
  { why: 'many small incremental pushes', push: harness.pushEach },
  (dir) => synth.chain(path.join(dir, 'src.git'), scale.pushes)
)

test('corpus report', { skip: !ENABLED }, (t) => {
  t.comment(`report: ${harness.REPORT}`)
  t.pass()
})

// A case with `bug` set is a known failure: it still runs and is measured, but
// its differences are reported instead of asserted.
function corpus(name, opts, build) {
  if (!name.includes(ONLY)) return

  test(name, { skip: !ENABLED, timeout: 0 }, async (t) => {
    const entry = harness.begin(name, opts.why)
    harness.report.scale = scale
    harness.report.git = (await harness.git(['--version'])).trim()

    try {
      const ctx = await harness.setup(t)
      const src = await build(ctx.dir)
      await harness.adoptHead(ctx, src)
      await (opts.push ?? harness.pushAll)(ctx, src, entry)
      await harness.verify(ctx, entry)
    } catch (err) {
      entry.diffs.push(`harness: ${err.stack}`)
    }

    if (opts.bug) {
      entry.bug = opts.bug
      entry.status = entry.diffs.length ? 'todo' : 'fixed'
      for (const diff of entry.diffs) t.comment(diff)
      t.pass(entry.diffs.length ? `known failure: ${opts.bug}` : 'passes now, drop the bug marker')
    } else {
      t.alike(entry.diffs, [], 'git+pear behaves like file://')
    }

    harness.finish(entry)
    t.comment(JSON.stringify(line(entry)))
  })

  if (opts.bug) test.todo(`${name}: ${opts.bug}`)
}

function line(entry) {
  return {
    status: entry.status,
    objects: entry.file.clone?.objects,
    pushMs: [entry.file.pushAll?.ms, entry.pear.pushAll?.ms],
    cloneMs: [entry.file.clone?.ms, entry.pear.clone?.ms],
    diskKB: [entry.file.diskKB, entry.pear.diskKB],
    rssMB: [entry.pear.pushAll?.rssMB, entry.pear.clone?.rssMB]
  }
}

function number(name, fallback) {
  return process.env[name] ? Number(process.env[name]) : fallback
}
