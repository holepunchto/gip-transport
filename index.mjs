import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { GipLocalDB } = require('./lib/db')

export { GipLocalDB }
