// git runs `git-remote-git+pear <remote> <url>`. Find the url by its scheme, not by
// position: a standalone build has no script path in argv, which shifts everything.
module.exports = function parseArgs(argv) {
  const i = argv.findIndex((arg) => arg.startsWith('git+pear://'))
  if (i === -1) return null
  return { remote: argv[i - 1], url: argv[i] }
}
