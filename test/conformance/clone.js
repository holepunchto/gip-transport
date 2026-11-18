const path = require('path')
const conform = require('../helpers/conformance')

// Scenarios from git's t5601-clone, t5500/t5537 (shallow) and t5616 (partial
// clone), run against file:// and git+pear://.

const GIT_DIR =
  'objects are written to dirname(GIT_DIR)/.git, which only is the repository when GIT_DIR ' +
  'ends in /.git (gip-remote lib/git.js toDisk)'
const PEELED =
  'the annotated tag on the branch is not followed: option followtags is answered ok and ' +
  'ignored (bin.js), and the list has no peeled refs'

const flags = {
  plain: {},
  '--bare': { args: ['--bare'], todo: GIT_DIR },
  '--mirror': { args: ['--mirror'], todo: GIT_DIR },
  '--separate-git-dir': { args: ['--separate-git-dir', 'elsewhere'], todo: GIT_DIR },
  '--branch <branch>': { args: ['--branch', 'side'] },
  '--branch <tag>': { args: ['--branch', 'v1'] },
  '--single-branch': { args: ['--single-branch'], todo: PEELED },
  '--single-branch --branch <branch>': { args: ['--single-branch', '--branch', 'side'] },
  '--no-tags': { args: ['--no-tags'] },
  '--origin': { args: ['--origin', 'upstream'] },
  '--no-checkout': { args: ['--no-checkout'] }
}

for (const [name, { args, todo }] of Object.entries(flags)) {
  conform(`clone ${name}`, { snapshot: false, todo }, async (w) => {
    await w.seed()
    await w.inspect(await w.clone('local', args))
  })
}

// Shallow and partial clones are not supported. Git must be told so, not
// handed a full clone that claims to be what was asked for.
// t5500 "clone shallow depth 1", t5537, t5616 "do partial clone 1"
const unsupported = {
  '--depth 1': ['--depth', '1'],
  '--shallow-since': ['--shallow-since', '2023-11-14T22:13:21Z'],
  '--shallow-exclude': ['--shallow-exclude', 'light'],
  '--filter=blob:none': ['--filter=blob:none', '--no-checkout']
}

for (const [name, args] of Object.entries(unsupported)) {
  const todo = `a full clone, silently: the option for ${name} is answered ok and ignored (bin.js)`

  conform(`clone ${name}`, { snapshot: false, check: conform.loud, todo }, async (w) => {
    if (!w.pear) await w.ok(['config', 'uploadpack.allowFilter', 'true'], { cwd: remote(w) })
    await w.seed()
    await w.commit('three', { env: { GIT_COMMITTER_DATE: '1700000100 +0000' } })
    await w.run(['push', w.url, 'main'])
    const local = await w.clone('local', args)
    await w.inspect(local)
    w.note('missing objects', await missing(w, local))
  })
}

// t5601 "clone empty repository"
conform(
  'clone an empty remote',
  {
    todo: 'list throws "Repo not found, peers required" for a repo with no refs (lib/gip.js list)'
  },
  async (w) => {
    await w.inspect(await w.clone())
  }
)

// t5601 "clone from a repository with two identical branches": HEAD is
// ambiguous by oid, the symref has to carry it.
conform('clone when HEAD points at a non-default branch', { snapshot: false }, async (w) => {
  await w.commit('one')
  await w.ok(['branch', 'aaa'])
  await w.ok(['checkout', '-q', '-b', 'trunk'])
  if (!w.pear) await w.ok(['symbolic-ref', 'HEAD', 'refs/heads/trunk'], { cwd: remote(w) })
  await w.run(['push', w.url, '--all'])
  await w.inspect(await w.clone())
})

// t5601 "clone with a remote HEAD pointing at an unborn branch". The remote
// picks its own HEAD (the first branch pushed), so this cannot match file://
// ref for ref — the clone still has to be usable.
conform(
  'clone when the branch HEAD names was never pushed',
  {
    snapshot: false,
    check(t, pear) {
      t.alike(pear[0], ['git push <url> side', 0])
      const seen = Object.fromEntries(pear)
      t.is(seen['git clone -q <url> <dir>/local'], 0)
      t.is(seen['local: fsck'], 0)
      t.ok(seen['local: refs'].some((ref) => ref.startsWith('refs/remotes/origin/side ')))
    }
  },
  async (w) => {
    await w.commit('one')
    await w.ok(['branch', 'side'])
    await w.run(['push', w.url, 'side'])
    await w.inspect(await w.clone())
  }
)

// t5601 "clone --recurse-submodules": the superproject comes through the
// remote under test, the submodule itself is a plain repo on disk.
conform('clone --recurse-submodules', { snapshot: false }, async (w) => {
  const sub = path.join(w.dir, 'sub')
  await w.ok(['init', '-q', sub])
  const oid = await w.commit('sub', { cwd: sub })
  await w.ok(['config', '--global', `url.${sub}.insteadOf`, 'file:///conformance/sub'])

  w.write('.gitmodules', '[submodule "sub"]\n\tpath = sub\n\turl = file:///conformance/sub\n')
  await w.ok(['add', '.gitmodules'])
  await w.ok(['update-index', '--add', '--cacheinfo', `160000,${oid},sub`])
  await w.ok(['commit', '-qm', 'add sub'])
  await w.run(['push', w.url, 'main'])

  const local = await w.clone('local', ['--recurse-submodules'])
  w.note('submodule status', (await w.git(['submodule', 'status'], { cwd: local })).stdout)
  await w.inspect(local)
})

function remote(w) {
  return path.join(w.dir, 'remote')
}

// What a partial clone left on the remote.
async function missing(w, cwd) {
  const result = await w.git(['rev-list', '--objects', '--all', '--missing=print'], { cwd })
  return result.stdout.split('\n').filter((line) => line.startsWith('?')).length
}
