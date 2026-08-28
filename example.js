const { GipLocalDB } = require('./lib/db/index.js')

const url = 'git+pear://somez32encodedkey/example'

const local = new GipLocalDB()

const main = async () => {
  await local.ready()
  const remote = await local.openRemote(url)

  console.log(remote.availablePeers)
  console.log(remote.core)
}

main()
