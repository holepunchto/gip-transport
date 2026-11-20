// Real git through the helper: conformance against file://, chaos and the differential fuzz.
// POSIX only (sh shims, signals) and slow, so CI runs it in its own job, not in npm test.

runTests()

async function runTests() {
  const test = (await import('brittle')).default

  test.pause()

  await import('./bootstrap.js')
  await import('./chaos.js')
  await import('./conformance/clone.js')
  await import('./conformance/content.js')
  await import('./conformance/fetch.js')
  await import('./conformance/protocol.js')
  await import('./conformance/push.js')
  await import('./differential.js')

  test.resume()
}
