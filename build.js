const Hyperschema = require('hyperschema')
const HyperDB = require('hyperdb/builder')

const SCHEMA_DIR = 'lib/db/schema/hyperschema'
const DB_DIR = 'lib/db/schema/hyperdb'

{
  const schema = Hyperschema.from(SCHEMA_DIR)
  const ns = schema.namespace('gip')

  ns.register({
    name: 'repos',
    compact: true,
    fields: [
      { name: 'name', type: 'string', required: true },
      { name: 'key', type: 'buffer', required: true },
      { name: 'description', type: 'string', required: false },
      { name: 'lastPushed', type: 'uint', required: false }
    ]
  })

  ns.register({
    name: 'config',
    fields: [
      { name: 'blindPeers', type: 'fixed32', array: true },
      // When true (default), we act as a server on the swarm even for
      // read-only / cloned cores. This lets other peers discover us and
      // pull blocks we already have, which is the cheap way to reseed
      // someone else's repo from your phone. Stored as a bool so that
      // an unset field reads as undefined → treated as ON in code.
      { name: 'seedReadOnly', type: 'bool', required: false }
    ]
  })

  Hyperschema.toDisk(schema)
}

{
  const db = HyperDB.from(SCHEMA_DIR, DB_DIR)
  const ns = db.namespace('gip')

  ns.collections.register({
    name: 'repos',
    schema: '@gip/repos',
    key: ['name']
  })

  ns.collections.register({
    name: 'config',
    schema: '@gip/config',
    key: []
  })

  HyperDB.toDisk(db)
}
