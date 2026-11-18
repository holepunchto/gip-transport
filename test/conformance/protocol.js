const path = require('path')
const conform = require('../helpers/conformance')

// The remote-helper protocol itself (gitremote-helpers(7), git's
// t5801-remote-helpers): some scenarios through git, some speaking to the
// helper directly, where there is no file:// to compare with.

function helper(name, opts, fn) {
  conform(`helper ${name}`, { only: 'pear', snapshot: false, ...opts }, fn)
}

// A session ends on the blank line that closes a (here empty) batch.
helper(
  'advertises its capabilities',
  {
    check(t, [[, session]]) {
      t.is(session.status, 0)
      t.alike(session.stdout.split('\n').slice(0, 5), ['option', 'fetch', 'push', 'list', ''])
    }
  },
  async (w) => {
    w.note('session', await w.helper('capabilities\n\n'))
  }
)

const implemented = [
  'verbosity 1',
  'progress false',
  'followtags true',
  'dry-run true',
  'atomic true',
  'cas refs/heads/main:0000000000000000000000000000000000000000',
  'pushcert if-asked'
]

helper(
  'answers ok to the options it implements',
  {
    check(t, [[, session]]) {
      t.alike(
        session.stdout.split('\n').slice(0, implemented.length),
        implemented.map(() => 'ok')
      )
    }
  },
  async (w) => {
    w.note(
      'session',
      await w.helper(implemented.map((option) => `option ${option}\n`).join('') + '\n')
    )
  }
)

// When git dies mid-session all the helper sees is its stdin closing.
helper(
  'exits when stdin closes',
  {
    check(t, [[, session]]) {
      t.is(session.status, 0)
    }
  },
  async (w) => {
    w.note('session', await w.helper('capabilities\n', { timeout: 15000 }))
  }
)

// gitremote-helpers(7): "unsupported" is how a helper tells git it cannot
// honour an option. Answering ok makes git believe a clone is shallow, a push
// is signed, the objects it was handed are already checked.
const options = [
  'frobnicate true',
  'cloning true',
  'check-connectivity true',
  'depth 1',
  'deepen-since 1700000000',
  'deepen-not refs/tags/v1',
  'filter blob:none',
  'push-option ci.skip',
  'pushcert true',
  'object-format sha256'
]

helper(
  'answers unsupported to the options it does not implement',
  {
    check(t, [[, session]]) {
      const answers = session.stdout.split('\n')
      options.forEach((option, i) => t.is(answers[i], 'unsupported', `option ${option}`))
    }
  },
  async (w) => {
    w.note('session', await w.helper(options.map((option) => `option ${option}\n`).join('') + '\n'))
  }
)

// t5801 "fetch multiple branches" / transport-helper.c fetch_with_fetch: git
// keeps the helper for a second batch when it follows tags.
helper(
  'serves a second fetch batch in the same session',
  {
    check(t, pear) {
      const seen = Object.fromEntries(pear)
      t.is(seen.session.status, 0)
      t.ok(seen.session.stdout.endsWith('\n\n\n'), 'both batches are terminated')
      t.is(seen.first, 'commit\n')
      t.is(seen.second, 'tag\n')
    }
  },
  async (w) => {
    await w.seed()
    const main = await w.ok(['rev-parse', 'main'])
    const tag = await w.ok(['rev-parse', 'v1'])

    const local = path.join(w.dir, 'local')
    await w.ok(['init', '-q', local])
    const session = await w.helper(
      `list\nfetch ${main} refs/heads/main\n\nfetch ${tag} refs/tags/v1\n\n`,
      { cwd: local }
    )

    w.note('session', session)
    w.note('first', (await w.git(['cat-file', '-t', main], { cwd: local })).stdout)
    w.note('second', (await w.git(['cat-file', '-t', tag], { cwd: local })).stdout)
  }
)

// gitremote-helpers(7) push: without a leading + the update has to be a
// fast-forward. Git checks against the list it was given, so only a helper
// can refuse when the remote moved in between.
helper(
  'refuses a non-fast-forward push that was not forced',
  {
    check(t, pear) {
      const seen = Object.fromEntries(pear)
      t.is(seen.session.stdout, 'error refs/heads/main non-fast-forward\n\n')
      t.is(seen.after, seen.before, 'the ref did not move')
    }
  },
  async (w) => {
    await w.commit('one')
    await w.commit('two')
    await w.run(['push', w.url, 'main'])
    w.note('before', (await w.git(['ls-remote', w.url, 'refs/heads/main'])).stdout)

    await w.ok(['reset', '-q', '--hard', 'HEAD~1'])
    await w.commit('other')
    w.note('session', await w.helper('push refs/heads/main:refs/heads/main\n\n'))
    w.note('after', (await w.git(['ls-remote', w.url, 'refs/heads/main'])).stdout)
  }
)

// t5533: git checks a lease against the list it was given. The remote may have moved since,
// so the oid in `option cas` is what the write itself has to find.
helper(
  'refuses a forced push whose lease is stale',
  {
    check(t, pear) {
      const seen = Object.fromEntries(pear)
      t.is(seen.session.stdout, 'ok\nerror refs/heads/main stale info\n\n')
      t.is(seen.after, seen.before, 'the ref did not move')
    }
  },
  async (w) => {
    const one = await w.commit('one')
    await w.commit('two')
    await w.run(['push', w.url, 'main'])
    w.note('before', (await w.git(['ls-remote', w.url, 'refs/heads/main'])).stdout)

    await w.ok(['reset', '-q', '--hard', one])
    await w.commit('other')
    w.note(
      'session',
      await w.helper(`option cas refs/heads/main:${one}\npush +refs/heads/main:refs/heads/main\n\n`)
    )
    w.note('after', (await w.git(['ls-remote', w.url, 'refs/heads/main'])).stdout)
  }
)

// t5543: git only sends an atomic push it found no fault with, so a ref the helper refuses
// has to take the others down itself.
helper(
  'lands no ref of an atomic push when it refuses one',
  {
    check(t, pear) {
      const seen = Object.fromEntries(pear)
      t.is(
        seen.session.stdout,
        'ok\nerror refs/heads/topic atomic push failed\nerror refs/heads/main non-fast-forward\n\n'
      )
      t.is(seen.after, seen.before, 'no ref moved')
    }
  },
  async (w) => {
    await w.commit('one')
    await w.commit('two')
    await w.run(['push', w.url, 'main'])
    w.note('before', (await w.git(['ls-remote', w.url])).stdout)

    await w.ok(['reset', '-q', '--hard', 'HEAD~1'])
    await w.commit('other')
    await w.ok(['branch', 'topic'])
    w.note(
      'session',
      await w.helper(
        'option atomic true\npush refs/heads/topic:refs/heads/topic\npush refs/heads/main:refs/heads/main\n\n'
      )
    )
    w.note('after', (await w.git(['ls-remote', w.url])).stdout)
  }
)

helper(
  'exits non-zero when it cannot open its store',
  {
    check(t, [[, session]]) {
      t.not(session.status, 0)
    }
  },
  async (w) => {
    w.url = w.url.replace(/storage=.*/, 'storage=/dev/null/store')
    w.note('session', await w.helper('capabilities\nlist\n\n'))
  }
)

// The same failure as git reports it.
conform('git fails when the helper fails', { snapshot: false }, async (w) => {
  await w.run(['ls-remote', w.url.replace(/remote$|store$/, 'dev/null/nowhere')])
})

// `git ls-remote` prints what the helper lists: an annotated tag comes with
// its peeled `^{}` line, which is also what tag following keys on.
conform('ls-remote lists peeled tags', { snapshot: false }, async (w) => {
  await w.seed()
  const ls = await w.run(['ls-remote', w.url])
  w.note('refs', ls.stdout.split('\n').sort())
})

conform('ls-remote with patterns and --exit-code', { snapshot: false }, async (w) => {
  await w.seed()
  for (const args of [['--heads'], ['--tags', '--refs'], ['--exit-code', 'nope'], ['main']]) {
    const ls = await w.run(['ls-remote', ...args, w.url])
    w.note('refs', ls.stdout.split('\n').sort())
  }
})

// t5801 / GIT_TRACE: tracing must not change what the helper says on stdout.
conform(
  'GIT_TRACE and GIT_TRACE_PACKET leave the result alone',
  { env: { GIT_TRACE: '1', GIT_TRACE_PACKET: '1', GIT_TRANSPORT_HELPER_DEBUG: '1' } },
  async (w) => {
    await w.seed()
    const local = await w.clone()
    await w.commit('three')
    await w.run(['push', w.url, 'main'])
    await w.run(['fetch'], { cwd: local })
  }
)

// git passes -q/-v/--progress down as `option verbosity` / `option progress`.
conform('verbosity and progress flags', async (w) => {
  await w.commit('one')
  await w.run(['push', '-v', '--progress', w.url, 'main'])
  const local = await w.clone('local', ['-v', '--progress'])
  await w.commit('two')
  await w.run(['push', '--no-progress', w.url, 'main'])
  await w.run(['fetch', '-vv'], { cwd: local })
})

// t5601 "clone -q is quiet", t5510, t5523 "push -q": nothing on stderr
conform('-q is quiet', async (w) => {
  await w.commit('one')
  w.note('push -q', (await w.run(['push', '-q', w.url, 'main'])).stderr)
  const local = path.join(w.dir, 'local')
  w.note('clone -q', (await w.run(['clone', '-q', w.url, local])).stderr)
  w.note('fetch -q', (await w.run(['fetch', '-q'], { cwd: local })).stderr)
})
