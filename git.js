const process = require('bare-process')
const { spawnSync } = require('bare-subprocess')

const result = spawnSync('git', process.argv.slice(2), {
  stdio: 'inherit',
  env: {
    ...process.env,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'url.git+pear://.insteadOf',
    GIT_CONFIG_VALUE_0: 'file://pear/',
    GIT_CONFIG_KEY_1: 'protocol.git+pear.allow',
    GIT_CONFIG_VALUE_1: 'always'
  }
})

if (result.error) throw result.error

process.exit(result.status ?? 1)
