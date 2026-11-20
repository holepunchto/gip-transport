const fs = require('fs')
const os = require('os')
const path = require('path')
const process = require('process')

const { git, sh } = require('./harness')

// Fixtures are downloaded on demand, pinned by commit, and never vendored.
//
// Everything under the cache is untrusted data. The pinned tree is checked
// out as plain files, and the repositories inside it are only ever served by
// git (upload-pack, index-pack): no git command runs with a fixture's own
// config or hooks, no fixture history is checked out, no file is executed.
const CACHE = process.env.GIP_CORPUS_CACHE || path.join(os.tmpdir(), 'gip-corpus-cache')
const MIRROR =
  process.env.GIP_CORPUS_MIRROR ||
  path.join(os.homedir(), 'Dev', 'pear', 'gear', 'mirror', 'clones')

const GO_GIT = {
  name: 'go-git-fixtures',
  url: 'https://github.com/go-git/go-git-fixtures',
  commit: 'f9ff7cee7e18f418f283a3100c75946dd4b78a90', // v5.1.1
  sparse: '/data/'
}

const LIBGIT2 = {
  name: 'libgit2',
  url: 'https://github.com/libgit2/libgit2',
  commit: '49e408b3208bc3093757a1c2db938d3590f3f412', // v1.9.7
  sparse: '/tests/resources/'
}

// git/git by release tag (tag object id), oldest first: a ladder of history depths.
const GIT_GIT = {
  url: 'https://github.com/git/git',
  tags: {
    'v1.0.0': 'f665776185ad074b236c00751d666da7d1977dbe',
    'v1.5.0': '6db027ffe03210324939b3dd655c4223ca023b45',
    'v2.0.0': '18a07354e33f86c8349ffdc300d9087876658264',
    'v2.20.0': '90141c859541f8daa08bdb0621c64cbd7dadbd8c',
    'v2.50.1': 'f92a7aa85a6c7fe9c45d944ec3b37598ede47274'
  }
}

async function checkout(pin) {
  const dir = path.join(CACHE, `${pin.name}-${pin.commit.slice(0, 12)}`)
  const done = path.join(dir, '.gip-corpus-complete')
  if (fs.existsSync(done)) return dir

  fs.mkdirSync(dir, { recursive: true })
  await git(['init', '-q', dir])
  await git(['fetch', '-q', '--depth', '1', '--filter=blob:none', pin.url, pin.commit], {
    cwd: dir
  })
  await git(['sparse-checkout', 'set', '--no-cone', pin.sparse], { cwd: dir })
  await git(['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'], { cwd: dir })

  const head = (await git(['rev-parse', 'HEAD'], { cwd: dir })).trim()
  if (head !== pin.commit) throw new Error(`${pin.name}: got ${head}, pinned ${pin.commit}`)

  fs.writeFileSync(done, '')
  return dir
}

// A fresh repo holding the fixture's refs and objects, fetched over upload-pack.
async function serve(gitDir, dest) {
  await git(['init', '-q', '--bare', dest])
  await git(['fetch', '-q', gitDir, '+refs/*:refs/*'], { cwd: dest })

  const head = (await git(['ls-remote', '--symref', gitDir, 'HEAD'])).match(/^ref: (\S+)\tHEAD$/m)
  if (head) await git(['symbolic-ref', 'HEAD', head[1]], { cwd: dest })
  return dest
}

async function libgit2(dest, resource) {
  const root = await checkout(LIBGIT2)
  return serve(path.join(root, 'tests', 'resources', resource), dest)
}

async function goGitDotGit(dest, hash) {
  const root = await checkout(GO_GIT)
  const extracted = dest + '.extracted'
  fs.mkdirSync(extracted)
  const tar = await sh('tar -xzf "$1" -C "$2"', [
    path.join(root, 'data', `git-${hash}.tgz`),
    extracted
  ])
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`)
  return serve(extracted, dest)
}

// The packfile is indexed as is, so its delta encoding reaches the helper's
// cat-file untouched. A pack has no refs: every unreferenced commit or tag
// becomes one.
async function goGitPack(dest, hash) {
  const root = await checkout(GO_GIT)
  await git(['-c', 'init.defaultBranch=tip-0', 'init', '-q', '--bare', dest])

  const index = await sh('git -C "$1" index-pack --stdin < "$2"', [
    dest,
    path.join(root, 'data', `pack-${hash}.pack`)
  ])
  if (index.status !== 0) throw new Error(`index-pack failed: ${index.stderr}`)

  const fsck = await sh('git -C "$1" fsck --no-reflogs --dangling 2>/dev/null | sort', [dest])
  let commits = 0
  let tags = 0
  for (const line of fsck.stdout.split('\n')) {
    const [state, type, oid] = line.split(' ')
    if (state !== 'dangling' || (type !== 'commit' && type !== 'tag')) continue
    const ref = type === 'tag' ? `refs/tags/tip-${tags++}` : `refs/heads/tip-${commits++}`
    await git(['update-ref', ref, oid], { cwd: dest })
  }
  return dest
}

async function gitGit(dest, tag) {
  const oid = GIT_GIT.tags[tag]
  if (!oid) throw new Error(`${tag} is not pinned, pick one of ${Object.keys(GIT_GIT.tags)}`)

  const cache = path.join(CACHE, 'git.git')
  const ref = `refs/tags/${tag}`
  if (!fs.existsSync(cache)) await git(['init', '-q', '--bare', cache])

  const have = await sh('git -C "$1" rev-parse -q --verify "$2"', [cache, ref])
  if (have.stdout.trim() !== oid) {
    await git(['fetch', '-q', '--no-tags', GIT_GIT.url, `+${ref}:${ref}`], { cwd: cache })
    const got = (await git(['rev-parse', ref], { cwd: cache })).trim()
    if (got !== oid) throw new Error(`git/git ${tag}: got ${got}, pinned ${oid}`)
  }

  await git(['-c', 'init.defaultBranch=master', 'init', '-q', '--bare', dest])
  await git(['fetch', '-q', '--no-tags', cache, `${ref}:${ref}`], { cwd: dest })
  await git(['update-ref', 'refs/heads/master', `${ref}^{commit}`], { cwd: dest })
  return dest
}

// The mirror's bare clones, largest first. They are only ever read.
function mirrors(count, maxMB) {
  if (!fs.existsSync(MIRROR)) return []

  return fs
    .readdirSync(MIRROR)
    .filter((name) => name.endsWith('.git'))
    .map((name) => ({ name, packMB: packBytes(path.join(MIRROR, name)) / 1024 / 1024 }))
    .filter((repo) => repo.packMB > 0 && repo.packMB <= maxMB)
    .sort((a, b) => b.packMB - a.packMB)
    .slice(0, count)
    .map((repo) => repo.name)
}

function packBytes(repo) {
  const dir = path.join(repo, 'objects', 'pack')
  if (!fs.existsSync(dir)) return 0

  let bytes = 0
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.pack')) bytes += fs.statSync(path.join(dir, name)).size
  }
  return bytes
}

async function mirror(dest, name) {
  await git(['clone', '-q', '--mirror', '--no-hardlinks', path.join(MIRROR, name), dest])
  return dest
}

module.exports = { libgit2, goGitDotGit, goGitPack, gitGit, mirrors, mirror }
