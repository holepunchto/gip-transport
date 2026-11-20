// Seeded random git histories, applied to a bare file:// remote and to a git+pear:// remote and
// compared after every step.
//
//   GIP_SEED=7 npm test          replay one seed
//   GIP_FUZZ_ITERS=200 npm test  run 200 fresh seeds (GIP_SEED sets the first)
//   GIP_STRICT=1 npm test        stop steering around the known bugs, and run their repros

const test = require('brittle')
const tmp = require('test-tmp')
const path = require('path')
const process = require('process')
const createTestnet = require('hyperdht/testnet')

const generate = require('./helpers/ops')
const { KNOWN, FIXED, createWorld, destroyWorld, run, script } = require('./helpers/world')

const OPS = 30
const SEEDS = [1, 2, 3]

const { GIP_SEED, GIP_FUZZ_ITERS, GIP_STRICT } = process.env
const AVOID = GIP_STRICT ? [] : KNOWN.flatMap((known) => known.avoid)

if (GIP_FUZZ_ITERS) {
  test(`differential fuzz, ${GIP_FUZZ_ITERS} seeds`, async (t) => {
    t.timeout(24 * 60 * 60 * 1000)
    const attempt = await setup(t)
    const first = GIP_SEED ? Number(GIP_SEED) : Math.floor(Math.random() * 2 ** 31)
    const seen = new Map()

    for (let seed = first; seed < first + Number(GIP_FUZZ_ITERS); seed++) {
      const ops = generate(seed, OPS, AVOID)
      const found = await attempt(ops)
      if (!found) continue

      const signature = `${found.kind} after ${found.op.name}`
      t.comment(`seed ${seed}: ${signature}`)
      if (seen.has(signature)) {
        seen.get(signature).push(seed)
        continue
      }

      seen.set(signature, [seed])
      t.comment(await report(attempt, seed, ops, found))
    }

    for (const [signature, seeds] of seen) t.fail(`${signature}: seeds ${seeds.join(' ')}`)
    t.pass(`${seen.size} distinct divergences`)
  })
} else {
  for (const seed of GIP_SEED ? [Number(GIP_SEED)] : SEEDS) {
    test(`differential seed ${seed}`, async (t) => {
      t.timeout(10 * 60 * 1000)
      const attempt = await setup(t)
      const ops = generate(seed, OPS, AVOID)
      const found = await attempt(ops)

      if (found) t.comment(await report(attempt, seed, ops, found))
      t.absent(found, `seed ${seed} matches file:// after each of ${ops.length} ops`)
    })
  }

  for (const { bug, repro } of FIXED) {
    test(`fixed: ${bug}`, async (t) => {
      const attempt = await setup(t)
      const found = await attempt(repro, { strict: true })

      if (found) t.comment([found.kind, ...found.detail].join('\n'))
      t.absent(found, 'matches file://')
    })
  }

  for (const { bug, repro } of KNOWN) {
    test(`known bug: ${bug}`, { todo: !GIP_STRICT }, async (t) => {
      const attempt = await setup(t)
      const found = await attempt(repro, { strict: true })

      if (found) t.comment([found.kind, ...found.detail].join('\n'))
      t.absent(found, 'matches file://')
    })
  }
}

async function setup(t) {
  const testnet = await createTestnet(3, t.teardown)
  const dir = await tmp(t)
  let worlds = 0

  return async function attempt(ops, opts = {}) {
    const root = path.join(dir, `${worlds++}`)
    const { strict = GIP_STRICT, from } = opts
    const world = await createWorld(root, testnet.bootstrap, strict)
    const found = await run(world, ops, { strict, from })
    await destroyWorld(world)
    return found
  }
}

// Shrinks by delta debugging: drop ever smaller chunks of ops for as long as the last one still
// diverges the same way. Only the last op is compared, which is what keeps this affordable.
async function report(attempt, seed, ops, found) {
  let minimal = ops.slice(0, found.step + 1)
  let last = found

  let size = minimal.length >> 1
  while (size >= 1) {
    let dropped = false
    for (let start = minimal.length - 1 - size; start >= 0; start -= size) {
      const candidate = minimal.slice(0, start).concat(minimal.slice(start + size))
      const again = await attempt(candidate, { from: candidate.length - 1 })
      if (again?.kind !== found.kind) continue
      minimal = candidate
      last = again
      dropped = true
    }
    if (size > 1 || !dropped) size >>= 1
  }

  const title = `${GIP_STRICT ? 'GIP_STRICT=1 ' : ''}GIP_SEED=${seed}: ${last.kind} diverged after "${last.op.cmd}"`
  return [
    title,
    ...last.detail,
    `oracle stderr: ${last.stderr.oracle.trim()}`,
    `pear stderr: ${last.stderr.pear.trim()}`,
    script(minimal, title, GIP_STRICT)
  ].join('\n')
}
