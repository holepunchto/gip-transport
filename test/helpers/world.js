// Two copies of the same setup, one against a bare file:// remote (the oracle) and one against
// git+pear://. The shell snippets here are run by the harness and printed verbatim into the
// repro script, so the two cannot drift apart.

const fs = require('fs')
const path = require('path')
const process = require('process')
const Hyperswarm = require('hyperswarm')
const sh = require('../../lib/bare-sh')
const { GipLocalDB } = require('../../lib/db')

const ROOT = path.join(__dirname, '..', '..')
const EPOCH = 1700000000

// A file:// remote refuses to delete the branch its HEAD names; the pear remote has no such rule.
const ORACLE = `git init -q --bare -b main oracle.git
git -C oracle.git config receive.denyDeleteCurrent ignore`

// origin/HEAD is kept out of it: the pear remote's HEAD follows the pusher's HEAD while a bare
// repo's stays on its initial branch, which is an allowed difference.
const SETUP = `for r in work second; do
  git init -q -b main $r && git -C $r remote add origin "$REMOTE"
  git -C $r config remote.origin.followRemoteHEAD never
done
git -C second symbolic-ref HEAD refs/heads/scratch
mkdir clones`

const COMMIT = ['work', null, 'echo one > f && git add -A && git commit -q -m one']
const PUSH = ['work', 'write', 'git push -q origin main']

// Bugs found so far, each with the smallest op sequence that shows it. Unless strict, the
// generator leaves out the ops in `avoid`, `setup` runs once and `mend` after every remote op on
// both sides, and the comparison looks away as noted, so a run gets past these and on to the
// next bug.
exports.KNOWN = [
  {
    // The helper answers "Repo not found, peers required". Not strict: a tag nothing ever deletes
    // keeps the remote from running empty.
    bug: 'a remote without refs cannot be listed, fetched or cloned',
    repro: [['second', 'read', 'git fetch -q origin']],
    avoid: [],
    setup: `git init -q keep && git -C keep commit -q --allow-empty -m keep && git -C keep tag keep && git -C keep push -q "$REMOTE" keep`
  },
  {
    bug: 'fetch force-writes every fetched branch into the local refs/heads',
    repro: [COMMIT, PUSH, ['second', 'read', 'git fetch -q origin']],
    avoid: ['work-fetch', 'work-pull'],
    mend: `git -C second for-each-ref --format="delete %(refname)" refs/heads | grep -v "/scratch$" | git -C second update-ref --stdin`
  },
  {
    bug: 'a push the remote should refuse as non-fast-forward overwrites the branch',
    repro: [
      COMMIT,
      PUSH,
      [
        '',
        'write',
        'git clone -q "$REMOTE" clones/c1 && cd clones/c1 && echo two > g && git add -A && git commit -q -m two && git push -q origin main'
      ],
      ['work', null, 'echo three > f && git add -A && git commit -q -m three'],
      PUSH
    ],
    avoid: ['second-push']
  },
  {
    bug: 'a bare or mirror clone fails with "remote did not send all necessary objects"',
    repro: [COMMIT, PUSH, ['', 'read', 'git clone -q --bare "$REMOTE" clones/c1']],
    avoid: ['clone-bare', 'clone-mirror']
  },
  {
    bug: 'a tag on a tree is not stored, and the push still reports success',
    repro: [COMMIT, PUSH, ['work', 'write', 'git tag t "HEAD^{tree}" && git push -q origin t']],
    avoid: ['tag-tree']
  },
  {
    bug: 'HEAD is listed for push, so pushing a detached HEAD lands on a ref named HEAD',
    repro: [COMMIT, PUSH, ['work', 'write', 'git checkout -q --detach && git push -q origin HEAD']],
    avoid: ['push-head']
  },
  {
    // So fetch and single-branch clone do not follow them. Not strict: ls-remote runs with --refs
    // and `second` stops following tags.
    bug: 'annotated tags are listed without their peeled ^{} entry',
    repro: [COMMIT, PUSH, ['work', 'write', 'git tag -a -m t t && git push -q origin t']],
    avoid: ['clone-single-branch'],
    mend: `git -C second config remote.origin.tagOpt --no-tags`
  },
  {
    bug: 'when git gives up early the helper never exits and keeps the store locked',
    repro: [COMMIT, PUSH, ['second', 'read', 'git fetch -q origin nope'], PUSH],
    avoid: [],
    mend: `while pkill -9 -f "storage=$T/store"; do sleep 0.05; done`
  }
]

for (const known of exports.KNOWN) {
  known.repro = known.repro.map(([dir, remote, cmd], tick) => {
    return { name: 'known', dir, cmd, remote, tick }
  })
}

const steer = (field) =>
  exports.KNOWN.map((known) => known[field])
    .filter(Boolean)
    .join('\n')
const STEER = steer('setup')
const MEND = steer('mend')

// Allowed differences: a clone's origin/HEAD and own HEAD follow the remote's HEAD (see SETUP),
// and FETCH_HEAD comes in the order the remote lists its refs (see remoteState).
const LOCAL = `for r in work second clones/*; do
  [ -d $r ] || continue
  echo "## $r refs"
  git -C $r for-each-ref --format="%(objectname) %(refname)" | grep -v " refs/remotes/origin/HEAD$"
  echo "## $r FETCH_HEAD"
  [ -f $r/.git/FETCH_HEAD ] && sed "s/ of .*//" $r/.git/FETCH_HEAD | sort
  echo "## $r objects"
  git -C $r rev-list --objects --all | sort | git hash-object --stdin
  git -C $r fsck --strict >/dev/null 2>&1; echo "fsck $?"
done
for r in work second; do
  echo "## $r HEAD"
  git -C $r symbolic-ref -q HEAD
  git -C $r rev-parse -q --verify HEAD
done`

// Allowed differences: HEAD (see SETUP), and the pear remote lists refs in store order, not
// sorted by name.
const remoteState = (strict) => `echo "## ls-remote"
git ls-remote ${strict ? '' : '--refs '}"$REMOTE" 2>/dev/null | awk '$2 != "HEAD"' | sort -k 2
rm -rf .fresh
echo "## fresh clone"
git clone -q "$REMOTE" .fresh >/dev/null 2>&1; echo "clone $?"
echo "## fresh clone objects"
git -C .fresh rev-list --objects --all | sort
echo "## fresh clone fsck"
git -C .fresh fsck --strict >/dev/null 2>&1; echo "fsck $?"`

const IDENTITY = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t.t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t.t'
}

exports.createWorld = async function createWorld(root, bootstrap, strict) {
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const shim = path.join(bin, 'git-remote-git+pear')
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${ROOT}/bin.js" "$@"\n`)
  fs.chmodSync(shim, 0o755)

  const env = {
    ...process.env,
    ...IDENTITY,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    T: root,
    GIP_NO_UPDATES: '1',
    GIP_BOOTSTRAP: bootstrap.map((node) => `${node.host}:${node.port}`).join(',')
  }

  const store = path.join(root, 'store')
  const db = new GipLocalDB({ dir: store, swarm: new Hyperswarm({ bootstrap }) })
  await db.ready()
  const remote = await db.createRemote('t')
  const url = `${remote.url}?storage=${store}`
  await db.close()

  const world = {
    env,
    sides: [
      { dir: path.join(root, 'oracle'), remote: `file://${root}/oracle.git` },
      { dir: path.join(root, 'pear'), remote: url }
    ]
  }

  await sh.exec('sh', ['-c', ORACLE], { cwd: root, env })
  for (const side of world.sides) fs.mkdirSync(side.dir)
  await both(world, SETUP)
  if (!strict) await both(world, STEER)

  return world
}

// Kills any helper that outlived its git (see KNOWN): it would keep this process alive too.
exports.destroyWorld = async function destroyWorld(world) {
  await sh.exec('pkill', ['-9', '-f', `storage=${world.env.T}/store`])
  await fs.promises.rm(world.env.T, { recursive: true, force: true })
}

// Applies ops to both sides, comparing after each one from step `from` on. Resolves to the first
// divergence, or null.
exports.run = async function run(world, ops, { strict, from = 0 } = {}) {
  for (let step = 0; step < ops.length; step++) {
    const op = ops[step]
    const [oracle, pear] = await both(world, op.cmd, op)
    const stderr = { oracle: oracle.stderr.toString(), pear: pear.stderr.toString() }

    if (op.remote && !strict) await both(world, MEND)
    if (step < from) continue

    if ((oracle.status === 0) !== (pear.status === 0) && !excused(stderr)) {
      const detail = [`oracle exit ${oracle.status}`, `pear exit ${pear.status}`]
      return { step, op, kind: 'exit status', detail, stderr }
    }

    // An op that stays local runs the same git on the same input, so there is nothing to compare.
    if (!op.remote) continue

    const local = compare(await both(world, LOCAL))
    if (local) return { step, op, ...local, stderr }

    const remote = compare(await both(world, remoteState(strict)))
    if (remote) return { step, op, ...remote, stderr }
  }

  return null
}

// Allowed differences in exit status: a push that matches no refs dies in git's own transport but
// returns 0 from its helper transport, and deleting a ref from an empty remote is a warning for
// file:// and an error for the helper.
function excused(stderr) {
  return (
    stderr.pear.includes('No refs in common and none specified') ||
    stderr.oracle.includes('deleting a non-existent ref')
  )
}

exports.script = function script(ops, title, strict) {
  const steps = ops.map(
    (op, i) => `(cd ${op.dir || '.'} && at ${op.tick} && ${op.cmd}); status ${i} ${op.name}`
  )

  return `#!/bin/sh
# ${title}
GIP=\${GIP:-${ROOT}}
T=$(mktemp -d) && cd "$T" && mkdir bin
printf '#!/bin/sh\\nexec bare "%s/bin.js" "$@"\\n' "$GIP" > bin/git-remote-git+pear
chmod +x bin/git-remote-git+pear
export PATH="$T/bin:$PATH" HOME="$T"
export ${Object.entries(IDENTITY)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')}

${ORACLE}
PEAR=$(cd "$GIP" && bare -e "
  const { GipLocalDB } = require('./lib/db')
  const db = new GipLocalDB({ dir: '$T/store' })
  db.ready()
    .then(() => db.createRemote('t'))
    .then((remote) => console.log(remote.url + '?storage=$T/store'))
    .then(() => db.close())
")

at() {
  export GIT_AUTHOR_DATE="@$((${EPOCH} + $1 * 60)) +0000"
  export GIT_COMMITTER_DATE="$GIT_AUTHOR_DATE"
}
status() {
  if [ $? = 0 ]; then echo "step $1 $2: ok"; else echo "step $1 $2: failed"; fi
${strict ? '' : MEND}
}
ops() {
${steps.join('\n')}
}

for side in oracle pear; do
  mkdir "$T/$side" && cd "$T/$side"
  if [ $side = oracle ]; then export REMOTE="file://$T/oracle.git"; else export REMOTE="$PEAR"; fi
  {
${SETUP}
${strict ? '' : STEER}
ops
${LOCAL}
${remoteState(strict)}
  } > "$T/$side.out" 2> "$T/$side.err"
done

echo "logs in $T, oracle on the left:"
diff "$T/oracle.out" "$T/pear.out" && echo "no divergence"
`
}

function both(world, cmd, opts = {}) {
  const date = `@${EPOCH + (opts.tick ?? 0) * 60} +0000`

  return Promise.all(
    world.sides.map((side) =>
      sh.exec('sh', ['-c', cmd], {
        cwd: path.join(side.dir, opts.dir ?? ''),
        env: { ...world.env, REMOTE: side.remote, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
      })
    )
  )
}

function compare([oracle, pear]) {
  const a = oracle.stdout.toString().split('\n')
  const b = pear.stdout.toString().split('\n')

  let first = 0
  while (first < a.length && a[first] === b[first]) first++
  if (first === a.length && a.length === b.length) return null

  let section = Math.min(first, a.length - 1)
  if (a[section].startsWith('## ') && section > 0) section--
  while (section > 0 && !a[section].startsWith('## ')) section--

  const end = (lines) => {
    const next = lines.findIndex((line, i) => i > section && line.startsWith('## '))
    return next === -1 ? lines.length : next
  }
  const only = (mine, theirs) => {
    const other = new Set(theirs.slice(section, end(theirs)))
    return mine.slice(section + 1, end(mine)).filter((line) => !other.has(line))
  }

  return {
    kind: a[section].slice(3).replace(/clones\/c\d+/, 'clone'),
    detail: [
      ...only(a, b).map((line) => `oracle only: ${line}`),
      ...only(b, a).map((line) => `pear only: ${line}`)
    ].slice(0, 12)
  }
}
