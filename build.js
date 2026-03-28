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
    compact: true,
    fields: [
      { name: 'blindPeers', type: 'fixed32', array: true }
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
