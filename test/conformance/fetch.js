const conform = require('../helpers/conformance')

// Scenarios from git's t5510-fetch, t5503 (tag following), t5516-fetch-push
// and t5537 (shallow), run against file:// and git+pear://. Every scenario
// starts from a clone of the seeded remote, moves the remote, then fetches.

function fetching(name, opts, fn) {
  if (typeof opts === 'function') return fetching(name, {}, opts)

  conform(`fetch ${name}`, { snapshot: false, ...opts }, async (w) => {
    await w.seed()
    const local = await w.clone('local', opts.clone)
    await fn(w, local)
    await w.inspect(local)
  })
}

// t5510 "fetch test"
fetching('with the default refspec', async (w, local) => {
  await w.commit('three')
  await w.ok(['branch', 'topic'])
  await w.run(['push', w.url, 'main', 'topic'])
  await w.run(['fetch'], { cwd: local })
})

// t5510 "fetch must not resolve short remote name" / local branches are the
// user's: a fetch only moves remote-tracking refs.
fetching('leaves local branches alone', async (w, local) => {
  await w.commit('three')
  await w.run(['push', w.url, 'main'])
  await w.commit('mine', { cwd: local })
  await w.run(['fetch'], { cwd: local })
})

fetching('with explicit refspecs', async (w, local) => {
  await w.commit('three')
  await w.run(['push', w.url, 'main'])
  await w.run(['fetch', 'origin', 'main:refs/heads/copy', 'side:refs/remotes/origin/renamed'], {
    cwd: local
  })
})

// t5510 "fetch --prune on its own works as expected"
fetching('--prune', async (w, local) => {
  await w.run(['push', w.url, '--delete', 'side'])
  await w.run(['fetch', '--prune'], { cwd: local })
})

// t5510 "fetch --prune-tags"
fetching('--prune --prune-tags', async (w, local) => {
  await w.run(['push', w.url, '--delete', 'refs/tags/light'])
  await w.run(['fetch', '--prune', '--prune-tags'], { cwd: local })
})

// t5510 "fetch --tags": tags that no fetched branch reaches still come.
fetching('--tags', async (w, local) => {
  await w.ok(['checkout', '-q', '--detach'])
  await w.commit('unreachable')
  await w.ok(['tag', '-a', 'loose', '-m', 'loose'])
  await w.run(['push', w.url, 'loose'])
  await w.run(['fetch', '--tags'], { cwd: local })
})

fetching('--no-tags', async (w, local) => {
  await w.commit('three')
  await w.ok(['tag', 'v2'])
  await w.run(['push', w.url, 'main', 'v2'])
  await w.run(['fetch', '--no-tags'], { cwd: local })
})

// t5503 "auto-follow tag": an annotated tag on a fetched commit is not part
// of the first batch — git asks for it in a second one.
fetching('follows an annotated tag on new history', async (w, local) => {
  await w.commit('three')
  await w.ok(['tag', '-a', 'v2', '-m', 'v2'])
  await w.run(['push', w.url, 'main', 'v2'])
  await w.run(['fetch'], { cwd: local })
})

fetching('follows a lightweight tag on new history', async (w, local) => {
  await w.commit('three')
  await w.ok(['tag', 'v2'])
  await w.run(['push', w.url, 'main', 'v2'])
  await w.run(['fetch'], { cwd: local })
})

// t5510 "fetch updates remote-tracking on non-ff" / refuses for a local ref
// without --force.
fetching('a rewritten branch needs --force', async (w, local) => {
  await w.ok(['commit', '-q', '--amend', '-m', 'rewritten'])
  await w.run(['push', '--force', w.url, 'main'])
  await w.ok(['branch', 'keep', 'origin/main'], { cwd: local })
  await w.run(['fetch', 'origin', 'main:keep'], { cwd: local })
  await w.run(['fetch', '--force', 'origin', 'main:keep'], { cwd: local })
})

// t5510 "fetch --dry-run does not touch FETCH_HEAD" or any ref
fetching('--dry-run', async (w, local) => {
  await w.commit('three')
  await w.run(['push', w.url, 'main'])
  await w.run(['fetch', '--dry-run'], { cwd: local })
})

// t5510 "fetch --atomic aborts all reference updates if hook aborts": one
// non-ff ref takes the others down with it.
fetching('--atomic', async (w, local) => {
  await w.ok(['commit', '-q', '--amend', '-m', 'rewritten'])
  await w.ok(['branch', 'topic'])
  await w.run(['push', '--force', w.url, 'main', 'topic'])
  await w.ok(['branch', 'keep', 'origin/main'], { cwd: local })
  await w.run(['fetch', '--atomic', 'origin', 'main:keep', 'topic:atomic'], { cwd: local })
})

// t5510 "fetch of a ref that was deleted"
fetching('a ref deleted on the remote', async (w, local) => {
  await w.run(['push', w.url, '--delete', 'side'])
  await w.run(['fetch', 'origin', 'side'], { cwd: local })
})

// t5516 "fetch exact SHA1": the tip of an advertised ref, by oid.
fetching('by raw oid', async (w, local) => {
  const oid = await w.commit('three')
  await w.run(['push', w.url, 'main'])
  await w.run(['fetch', 'origin', oid], { cwd: local })
  w.note('fetched', (await w.git(['cat-file', '-t', oid], { cwd: local })).stdout)
})

// t5510 "fetch --all"
conform('fetch --all with two remotes', { snapshot: false }, async (w) => {
  await w.seed()
  const second = await w.second()
  await w.run(['push', second, 'side:refs/heads/main'])

  const local = await w.clone()
  await w.ok(['remote', 'add', 'second', second], { cwd: local })
  await w.commit('three')
  await w.run(['push', w.url, 'main'])
  await w.run(['fetch', '--all'], { cwd: local })
  await w.inspect(local)
})

// t5510 "pull": fetch + merge through the same path.
fetching('via pull --ff-only', async (w, local) => {
  await w.commit('three')
  await w.run(['push', w.url, 'main'])
  await w.run(['pull', '-q', '--ff-only'], { cwd: local })
})

// t2400-series: a linked worktree has its own GIT_DIR under .git/worktrees
conform('fetch from a linked worktree', { snapshot: false }, async (w) => {
  await w.seed()
  const local = await w.clone()
  const linked = `${w.dir}/linked`
  await w.ok(['worktree', 'add', '-q', '--detach', linked], { cwd: local })
  await w.commit('three')
  await w.run(['push', w.url, 'main'])
  await w.run(['fetch'], { cwd: linked })
  await w.inspect(local)
})

// t5510 fetch into a bare repository
conform('fetch into a bare repository', { snapshot: false }, async (w) => {
  await w.seed()
  const bare = `${w.dir}/bare.git`
  await w.ok(['init', '-q', '--bare', bare])
  await w.run(['fetch', w.url, 'refs/heads/*:refs/heads/*'], { cwd: bare })
  await w.inspect(bare)
})

// Shallow fetches are not supported: they have to say so.
// t5537 / t5500 "fetch --depth", "--deepen", "--unshallow"
fetching('--depth 1', { check: conform.loud }, async (w, local) => {
  await w.commit('three')
  await w.commit('four')
  await w.run(['push', w.url, 'main'])
  await w.run(['fetch', '--depth', '1'], { cwd: local })
})

fetching('--deepen', { check: conform.loud, clone: ['--depth', '1'] }, async (w, local) => {
  await w.run(['fetch', '--deepen', '1'], { cwd: local })
})

fetching('--unshallow', { check: conform.loud, clone: ['--depth', '1'] }, async (w, local) => {
  await w.run(['fetch', '--unshallow'], { cwd: local })
})
