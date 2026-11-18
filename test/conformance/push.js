const conform = require('../helpers/conformance')

// Scenarios from git's t5516-fetch-push, t5533-push-cas, t5543-atomic-push,
// t5545-push-options and t5534-push-signed, run against file:// and
// git+pear://. The fresh clone taken after each one is what proves the push.

// t5516 "push without wildcard"
conform('push a new branch', async (w) => {
  await w.commit('one')
  await w.run(['push', w.url, 'main'])
})

// t5516 "push with matching heads on the command line"
conform('push a fast-forward', async (w) => {
  await w.commit('one')
  await w.run(['push', w.url, 'main'])
  await w.commit('two')
  await w.run(['push', w.url, 'main'])
})

// t5516 "push with non-ff"
conform('push rejects a non-fast-forward', async (w) => {
  await diverge(w)
  await w.run(['push', w.url, 'main'])
})

// t5516 "push with non-ff", from the other side: the remote moved to a commit this repo has
// never seen, so git cannot tell and the remote has to refuse.
conform('push rejects when the remote has commits it never fetched', async (w) => {
  await w.commit('one')
  await w.run(['push', w.url, 'main'])

  const other = await w.clone('other')
  await w.commit('theirs', { cwd: other })
  await w.run(['push', 'origin', 'main'], { cwd: other })

  await w.commit('mine')
  await w.run(['push', w.url, 'main'])
})

// t5516 "push with +HEAD"
conform('push +refspec forces a non-fast-forward', async (w) => {
  await diverge(w)
  await w.run(['push', w.url, '+main'])
})

// t5516 "push --force with matching heads"
conform('push --force', async (w) => {
  await diverge(w)
  await w.run(['push', '--force', w.url, 'main'])
})

// t5533 "push to update (protected)", "(protected, tracking)": the remote
// moved since we last saw it, every form of the lease has to refuse.
conform('push --force-with-lease rejects a stale lease', async (w) => {
  const { ours } = await lease(w)
  await w.run(['push', '--force-with-lease', 'origin', 'main'])
  await w.run(['push', '--force-with-lease=main', 'origin', 'main'])
  await w.run(['push', `--force-with-lease=main:${ours}`, 'origin', 'main'])
})

// t5533 "push to update (allowed)"
conform('push --force-with-lease accepts a current lease', async (w) => {
  const { theirs } = await lease(w)
  await w.run(['push', `--force-with-lease=main:${theirs}`, 'origin', 'main'])
})

// t5543 "atomic push fails if one branch fails"
conform('push --atomic lands nothing when one ref is rejected', async (w) => {
  await diverge(w)
  await w.ok(['branch', 'topic'])
  await w.run(['push', '--atomic', w.url, 'main', 'topic'])
})

// t5516 "push --dry-run"
conform('push --dry-run writes nothing', async (w) => {
  await w.commit('one')
  await w.run(['push', w.url, 'main'])
  await w.commit('two')
  await w.ok(['branch', 'topic'])
  await w.run(['push', '--dry-run', w.url, 'main', 'topic'])
})

// t5516 "allow deleting a ref using --delete"
conform('push --delete a branch', async (w) => {
  await w.seed()
  await w.run(['push', w.url, '--delete', 'side'])
})

conform('push --delete a tag', async (w) => {
  await w.seed()
  await w.run(['push', w.url, '--delete', 'refs/tags/v1'])
  await w.run(['push', w.url, ':refs/tags/light'])
})

// t5516 "push --delete refuses empty string" / a ref that is not there
conform('push --delete a ref the remote does not have', async (w) => {
  await w.seed()
  await w.run(['push', w.url, '--delete', 'nope'])
})

// t5516 "deny deleting the current branch" (receive.denyDeleteCurrent)
conform('push --delete refuses the branch HEAD points at', async (w) => {
  await w.seed()
  await w.run(['push', w.url, '--delete', 'main'])
})

conform('push deletes and updates in one go', async (w) => {
  await w.seed()
  await w.commit('three')
  await w.run(['push', w.url, ':refs/heads/side', 'main'])
})

// t5516 "push --tags"
conform('push --tags', async (w) => {
  await w.commit('one')
  await w.ok(['tag', 'light'])
  await w.ok(['tag', '-a', 'v1', '-m', 'v1'])
  await w.run(['push', w.url, 'main'])
  await w.run(['push', w.url, '--tags'])
})

// t5516 "push --follow-tags only pushes relevant tags"
conform('push --follow-tags', async (w) => {
  await w.commit('one')
  await w.ok(['tag', '-a', 'reachable', '-m', 'reachable'])
  await w.ok(['tag', 'light'])
  await w.commit('two')
  await w.ok(['tag', '-a', 'ahead', '-m', 'ahead'])
  await w.run(['push', '--follow-tags', w.url, 'main~1:refs/heads/main'])
})

// t5516 "push --all"
conform('push --all', async (w) => {
  await w.commit('one')
  await w.ok(['branch', 'aaa'])
  await w.ok(['tag', 'not-a-branch'])
  await w.commit('two')
  await w.run(['push', '--all', w.url])
})

// t5516 "push --mirror": removes what is gone locally as well
conform('push --mirror', async (w) => {
  await w.seed()
  await w.ok(['branch', '-D', 'side'])
  await w.ok(['tag', '-d', 'light'])
  await w.ok(['branch', 'topic'])
  await w.run(['push', '--mirror', w.url])
})

// t5516 "push --prune"
conform('push --prune', async (w) => {
  await w.seed()
  await w.ok(['branch', '-D', 'side'])
  await w.run(['push', '--prune', w.url, 'refs/heads/*:refs/heads/*'])
})

// t5516 "push with colon-less refspec" / "push with explicit refspec"
conform('push a refspec that renames', async (w) => {
  await w.commit('one')
  await w.run(['push', w.url, 'main'])
  await w.commit('two')
  await w.run(['push', w.url, 'main:renamed'])
})

// t5516 "push with HEAD"
conform('push HEAD:refs/heads/x', async (w) => {
  await w.commit('one')
  await w.run(['push', w.url, 'main'])
  await w.commit('two')
  await w.run(['push', w.url, 'HEAD:refs/heads/x'])
})

// t5516 "push from a detached HEAD"
conform('push from a detached HEAD', async (w) => {
  await w.commit('one')
  await w.run(['push', w.url, 'main'])
  await w.ok(['checkout', '-q', '--detach'])
  await w.commit('two')
  await w.run(['push', w.url, 'HEAD:refs/heads/detached'])
})

// t5516 "push with matching heads": `:` pushes what both sides have
conform('push the matching refspec', async (w) => {
  await w.commit('one')
  await w.ok(['branch', 'local-only'])
  await w.run(['push', w.url, 'main'])
  await w.commit('two')
  await w.run(['push', w.url, ':'])
})

conform('push a ref that does not exist locally', async (w) => {
  await w.commit('one')
  await w.run(['push', w.url, 'main'])
  await w.run(['push', w.url, 'nope'])
})

// t5528-push-default
conform('push.default variants', async (w) => {
  await w.ok(['remote', 'add', 'origin', w.url])
  await w.commit('one')
  await w.run(['push', '-u', 'origin', 'main'])
  await w.ok(['branch', 'untracked'])

  for (const mode of ['current', 'upstream', 'simple', 'matching', 'nothing']) {
    await w.commit(mode)
    await w.run(['-c', `push.default=${mode}`, 'push'])
  }

  // A named remote also moves refs/remotes/origin/*.
  await w.inspect(w.repo)
})

// t5516 "push to an unrelated history"
conform('push an unrelated history', async (w) => {
  await w.commit('one')
  await w.run(['push', w.url, 'main'])
  const tree = await w.ok(['hash-object', '-w', '-t', 'tree', '/dev/null'])
  const root = await w.ok(['commit-tree', tree, '-m', 'another root'])
  await w.ok(['branch', 'orphan', root])
  await w.run(['push', w.url, 'orphan'])
  await w.run(['push', '--force', w.url, 'orphan:main'])
})

// t5516 "push into refs/notes", "refs/pull", any namespace: the store only has
// branches and tags, so anything else is refused, never filed as a branch.
for (const ref of [
  'refs/notes/commits',
  'refs/pull/1/head',
  'refs/remotes/origin/main',
  'refs/meta/config'
]) {
  conform(`push to ${ref}`, { check: refused }, async (w) => {
    await w.commit('one')
    await w.run(['push', w.url, 'main'])
    await w.commit('two')
    const push = await w.run(['push', w.url, `main:${ref}`])
    w.note('why', push.stderr.includes('unsupported ref namespace'))
  })
}

// t7004 / t5516 tags of every shape
const tags = {
  'a lightweight tag': { tag: ['tag', 'it'] },
  'an annotated tag': { tag: ['tag', '-a', 'it', '-m', 'it'] },
  'a tag of a tag': { tag: ['tag', '-a', 'it', '-m', 'outer', 'inner'] },
  'a lightweight tag of a tree': { tag: ['tag', 'it', 'HEAD^{tree}'] },
  'a lightweight tag of a blob': { tag: ['tag', 'it', 'HEAD:one.txt'] },
  'an annotated tag of a tree': { tag: ['tag', '-a', 'it', '-m', 'it', 'HEAD^{tree}'] },
  'an annotated tag of a blob': { tag: ['tag', '-a', 'it', '-m', 'it', 'HEAD:one.txt'] }
}

for (const [name, { tag }] of Object.entries(tags)) {
  conform(`push ${name}`, async (w) => {
    await w.commit('one')
    await w.ok(['tag', '-a', 'inner', '-m', 'inner'])
    await w.ok(tag)
    await w.run(['push', w.url, 'main', 'refs/tags/it'])
  })
}

// t5516 "push tag with non-existent, incomplete dest": moving a tag needs force
conform('push refuses to move a tag without --force', async (w) => {
  await w.commit('one')
  await w.ok(['tag', 'it'])
  await w.run(['push', w.url, 'main', 'it'])
  await w.commit('two')
  await w.ok(['tag', '-f', 'it'])
  await w.run(['push', w.url, 'it'])
  await w.run(['push', '--force', w.url, 'it'])
})

// t5537 "push from shallow clone": a history cut short cannot be stored whole.
conform('push from a shallow clone is refused', async (w) => {
  const full = `${w.dir}/full`
  await w.ok(['init', '-q', full])
  await w.commit('one', { cwd: full })
  await w.commit('two', { cwd: full })

  const shallow = `${w.dir}/shallow`
  await w.ok(['clone', '-q', '--depth', '1', `file://${full}`, shallow])
  await w.run(['push', w.url, 'main'], { cwd: shallow })
})

// t5545 "push option denied by remote": we do not take push options, and
// git has to hear that instead of dropping them.
conform('push -o is refused by a remote without push options', async (w) => {
  await w.commit('one')
  await w.run(['push', '-o', 'ci.skip', w.url, 'main'])
})

// t5534 "signed push sends push certificate": same for a push certificate
// nobody will check.
conform('push --signed is refused by a remote that cannot verify it', async (w) => {
  await w.commit('one')
  await w.run(['push', '--signed', w.url, 'main'])
})

conform('push --signed=if-asked', async (w) => {
  await w.commit('one')
  await w.run(['push', '--signed=if-asked', w.url, 'main'])
})

// Where file:// stores the ref, the push has to fail, say why, and leave the
// remote as it was.
function refused(t, pear) {
  const seen = Object.fromEntries(pear)
  const main = seen['ls-remote'].refs.filter((line) => line.endsWith('refs/heads/main'))

  t.is(pear[1][1], 1, pear[1][0])
  t.ok(seen.why, 'unsupported ref namespace')
  t.is(seen['ls-remote'].refs.length, 3, 'HEAD, its symref and main')
  t.is(main.length, 1)
  t.is(seen['fresh clone fsck'], 0)
}

// main is two commits on the remote, and a different second commit locally.
async function diverge(w) {
  await w.commit('one')
  await w.commit('two')
  await w.run(['push', w.url, 'main'])
  await w.ok(['reset', '-q', '--hard', 'HEAD~1'])
  await w.commit('other')
}

// The remote moved to `theirs` behind our back: origin/main still says `ours`,
// and main has been rewritten on top of that.
async function lease(w) {
  await w.ok(['remote', 'add', 'origin', w.url])
  const ours = await w.commit('one')
  await w.run(['push', 'origin', 'main'])
  const theirs = await w.commit('theirs')
  await w.run(['push', w.url, 'main'])
  await w.ok(['update-ref', 'refs/remotes/origin/main', ours])
  await w.ok(['reset', '-q', '--hard', ours])
  await w.commit('mine')
  return { ours, theirs }
}
