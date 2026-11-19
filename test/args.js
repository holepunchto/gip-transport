const test = require('brittle')
const parseArgs = require('../lib/args')

const url = 'git+pear://0.3.abc/repo?storage=/tmp/s'

test('runtime with a script path', function (t) {
  t.alike(parseArgs(['bare', '/bin/git-remote-git+pear', 'origin', url]), { remote: 'origin', url })
})

test('standalone build without a script path', function (t) {
  t.alike(parseArgs(['/bin/git-remote-git+pear', 'origin', url]), { remote: 'origin', url })
})

test('no url', function (t) {
  t.is(parseArgs(['/bin/git-remote-git+pear', 'origin']), null)
})
