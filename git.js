#!/usr/bin/env node
const process = require('process')
const { spawnSync } = require('child_process')

const n = Math.max(process.env.GIT_CONFIG_COUNT | 0, 0)

const result = spawnSync('git', process.argv.slice(2), {
  stdio: 'inherit',
  env: {
    ...process.env,
    GIT_CONFIG_COUNT: `${n + 2}`,
    [`GIT_CONFIG_KEY_${n}`]: 'url.git+pear://.insteadOf',
    [`GIT_CONFIG_VALUE_${n}`]: 'file://pear/',
    [`GIT_CONFIG_KEY_${n + 1}`]: 'protocol.git+pear.allow',
    [`GIT_CONFIG_VALUE_${n + 1}`]: 'always'
  }
})

if (result.error) throw result.error

process.exit(result.status ?? 1)
