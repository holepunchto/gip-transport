// Seeded generator of git operation sequences. Each op is a shell command run in `dir` under a
// side's root, with $REMOTE set to that side's url and `origin` pointing at it. `work` is the
// main repo; `second` is another repo on the same remote that stays on a detached HEAD.
//
// Left out on purpose, the conformance tests own them: refs outside refs/heads and refs/tags
// (--mirror, notes), and the push/fetch options the helper acks without implementing (--dry-run,
// --atomic, --force-with-lease, --depth). They diverge on every run and would drown the rest.

const WEIGHTS = [
  ['commit', 30],
  ['push', 24],
  ['second', 10],
  ['branch', 8],
  ['checkout', 8],
  ['merge', 8],
  ['tag', 8],
  ['rewrite', 5],
  ['pull', 4],
  ['clone', 4],
  ['drop', 3]
]

// `avoid` lists op names to leave out, which is how runs get past bugs that are already known.
module.exports = function generate(seed, count, avoid = []) {
  const rand = mulberry32(seed)
  const int = (n) => Math.floor(rand() * n)
  const pick = (list) => list[int(list.length)]
  const chance = (p) => rand() < p

  const ops = []
  const branches = ['main']
  const pushed = ['main']
  const tags = []
  const annotated = []
  const files = []
  let n = 0

  const emit = (dir, remote, variants) => {
    const allowed = variants.filter(([name]) => !avoid.includes(name))
    if (allowed.length === 0) return null
    const [name, cmd] = pick(allowed)
    ops.push({ name, dir, cmd, remote, tick: ops.length })
    return name
  }

  const fresh = () => {
    const file = pick(['', 'd/', 'd/e/']) + 'f' + ++n
    files.push(file)
    return file
  }
  const old = () => (files.length ? pick(files) : fresh())
  const bytes = (size) =>
    `LC_ALL=C awk "BEGIN{s=${1 + int(1e6)};for(i=0;i<${size};i++){s=s*16807%2147483647;printf \\"%c\\",s%256}}"`

  const change = {
    add: () => `echo "add ${n}" > ${fresh()}`,
    modify: () => `echo "mod ${++n}" >> ${old()}`,
    replace: () => `seq 1 ${1 + int(300)} > ${old()}`,
    delete: () => `rm -f ${old()}`,
    rename: () => `mv ${old()} ${fresh()}`,
    chmod: () => `chmod ${pick(['+x', '-x'])} ${old()}`,
    symlink: () => `ln -sfn ${pick(['f1', '../f2', 'nowhere'])} ${fresh()}`,
    binary: () => `${bytes(200 + int(4000))} > ${fresh()}`,
    empty: () => `: > ${fresh()}`,
    large: () => `${bytes(200000 + int(400000))} > ${old()}`
  }
  const changes = Object.keys(change).concat(['add', 'add', 'modify', 'modify', 'replace'])

  const op = {
    commit() {
      const edits = []
      for (let i = int(3); i >= 0; i--) edits.push(change[pick(changes)]())
      const cmd = `mkdir -p d/e; ${edits.join('; ')}; git add -A && git commit -q --allow-empty -m c${++n}`
      emit('work', null, [['commit', cmd]])
    },

    branch() {
      const b = pick(['b', 'feat/b', 'fix/x.b']) + ++n
      branches.push(b)
      emit('work', null, [
        ['branch', `git branch ${b}`],
        ['branch', `git checkout -q -b ${b}`],
        ['branch', `git checkout -q -b ${b}`],
        ['branch', `git branch ${b} HEAD~1`],
        [
          'branch-orphan',
          `git checkout -q --orphan ${b} && echo ${b} > root${n} && git add -A && git commit -q -m o${n}`
        ]
      ])
    },

    checkout() {
      emit('work', null, [
        ['checkout', `git checkout -q ${pick(branches)}`],
        ['checkout', `git checkout -q ${pick(branches)}`],
        ['checkout', `git checkout -q ${pick(branches)}`],
        ['checkout-detach', `git checkout -q --detach`]
      ])
    },

    merge() {
      const a = pick(branches)
      const b = pick(branches)
      const merge = 'git merge -q --allow-unrelated-histories'
      const abort = '|| { git merge --abort; false; }'
      emit('work', null, [
        ['merge-ff', `git merge -q --ff-only ${a}`],
        ['merge', `${merge} --no-ff -X theirs -m m${++n} ${a} ${abort}`],
        ['merge', `${merge} --no-ff -X theirs -m m${++n} ${a} ${abort}`],
        ['merge-octopus', `${merge} -m m${++n} ${a} ${b} ${abort}`]
      ])
    },

    rewrite() {
      emit('work', null, [
        ['amend', `git commit -q --amend --allow-empty -m a${++n}`],
        ['reset', `git reset -q --hard HEAD~1`],
        ['rebase', `git rebase -q ${pick(branches)} || { git rebase --abort; false; }`]
      ])
    },

    tag() {
      const t = 't' + ++n
      const name = emit('work', null, [
        ['tag', `git tag ${t}`],
        ['tag', `git tag ${t} HEAD~1`],
        ['tag-annotated', `git tag -a -m ${t} ${t}`],
        ['tag-annotated', `git tag -a -m ${t} ${t}`],
        ['tag-nested', `git tag -a -m ${t} ${t} ${annotated.length ? pick(annotated) : 'HEAD'}`],
        ['tag-tree', `git tag ${t} "HEAD^{tree}"`],
        ['tag-tree', `git tag -a -m ${t} ${t} "HEAD^{tree}"`],
        ['tag-move', `git tag -f ${tags.length ? pick(tags) : t}`]
      ])
      if (name === 'tag-move') return
      if (name === 'tag-annotated' || name === 'tag-nested') annotated.push(t)
      tags.push(t)
    },

    drop() {
      if (tags.length && chance(0.5)) {
        const [t] = tags.splice(int(tags.length), 1)
        if (annotated.includes(t)) annotated.splice(annotated.indexOf(t), 1)
        return emit('work', null, [['drop-tag', `git tag -d ${t}`]])
      }
      if (branches.length === 1) return
      const [b] = branches.splice(1 + int(branches.length - 1), 1)
      emit('work', null, [['drop-branch', `git branch -D ${b}`]])
    },

    push() {
      const b = pick(branches)
      const t = tags.length ? pick(tags) : 't0'
      const gone = pick(pushed)
      const renamed = 'r' + (n + 1)
      const other = pick(branches)
      const name = emit('work', 'write', [
        ['push', `git push -q origin ${b}`],
        ['push', `git push -q origin ${b}`],
        ['push', `git push -q origin ${b}`],
        ['push-head', `git push -q origin HEAD`],
        ['push', `git push -q -u origin ${b}:${b}`],
        ['push', `git push -q "$REMOTE" ${b}`],
        ['push-force', `git push -q origin +${b}`],
        ['push-force', `git push -q origin +${b}`],
        ['push-force', `git push -q --force origin ${b}`],
        ['push-rename', `git push -q origin ${b}:refs/heads/${renamed}`],
        ['push-over', `git push -q origin HEAD:refs/heads/${gone}`],
        ['push-all', `git push -q --all origin`],
        ['push-all', `git push -q --all origin`],
        ['push-all', `git push -q --force --all origin`],
        ['push-tags', `git push -q --tags origin`],
        ['push-tags', `git push -q --tags origin`],
        ['push-tags', `git push -q --force --tags origin`],
        ['push-follow-tags', `git push -q --follow-tags origin ${b}`],
        ['push-tag', `git push -q origin ${t}`],
        ['push-tag', `git push -q origin +refs/tags/${t}`],
        ['push-mixed', `git push -q origin ${b} ${t}`],
        ['push-mixed', `git push -q origin ${b === other ? '' : b} +${other} :refs/tags/${t}`],
        ['push-delete', `git push -q origin --delete ${gone}`],
        ['push-delete', `git push -q origin :${gone}`],
        ['push-delete-tag', `git push -q origin :refs/tags/${t}`],
        ['push-prune', `git push -q --prune origin "refs/heads/*:refs/heads/*"`]
      ])
      if (name === 'push-rename') pushed.push('r' + ++n)
      else if (name === 'push-delete' && pushed.length > 1) pushed.splice(pushed.indexOf(gone), 1)
      else if (!pushed.includes(b)) pushed.push(b)
    },

    second() {
      const b = pick(pushed)
      const sync = `git fetch -q origin && git checkout -q --detach origin/${b}`
      const name = emit('second', 'read', [
        ['fetch', `git fetch -q origin`],
        ['fetch', `git fetch -q origin`],
        ['fetch', `git fetch -q origin`],
        ['fetch-prune', `git fetch -q --prune origin`],
        ['fetch-prune-tags', `git fetch -q --prune --prune-tags origin`],
        ['fetch-tags', `git fetch -q --tags origin`],
        ['fetch-tags-refspec', `git fetch -q origin "refs/tags/*:refs/tags/*"`],
        ['fetch-one', `git fetch -q origin ${b}`],
        ['second-pull', `git pull -q --ff-only origin ${b}`],
        ['second-sync', sync],
        [
          'second-push',
          `${sync} && echo s${++n} >> s${n} && git add -A && git commit -q -m s${n} && git push -q origin HEAD:refs/heads/${b}`
        ]
      ])
      if (name === 'second-push') ops[ops.length - 1].remote = 'write'
    },

    pull() {
      const b = pick(pushed)
      emit('work', 'read', [
        ['work-fetch', `git fetch -q origin`],
        ['work-pull', `git pull -q --ff-only origin ${b}`],
        ['work-pull', `git pull -q --rebase origin ${b} || { git rebase --abort; false; }`]
      ])
    },

    clone() {
      const b = pick(pushed)
      const dest = `"$REMOTE" clones/c${++n}`
      emit('', 'read', [
        ['clone-mirror', `git clone -q --mirror ${dest}`],
        ['clone-bare', `git clone -q --bare ${dest}`],
        ['clone-branch', `git clone -q --branch ${b} ${dest}`],
        ['clone-single-branch', `git clone -q --branch ${b} --single-branch ${dest}`],
        ['clone-no-tags', `git clone -q --branch ${b} --no-tags ${dest}`],
        ['clone-tag', `git clone -q --branch ${tags.length ? pick(tags) : b} ${dest}`]
      ])
    }
  }

  // Most runs start from a populated remote; the rest get to poke at an empty one.
  if (chance(0.9)) {
    op.commit()
    emit('work', 'write', [['push', 'git push -q origin main']])
  }

  const total = WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0)
  while (ops.length < count) {
    let roll = int(total)
    for (const [name, weight] of WEIGHTS) {
      if ((roll -= weight) < 0) {
        op[name]()
        break
      }
    }
  }

  return ops
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
