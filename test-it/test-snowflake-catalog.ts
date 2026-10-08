import type { SnowflakeConfig } from '#types'
import type { CatalogPlugin } from '@data-fair/types-catalogs'

import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import { describe, it, before, after, beforeEach, mock } from 'node:test'
import fs from 'fs-extra'
import { logFunctions } from './test-utils.ts'

// The real driver internals, used to build the columns and values the driver would return.
const requireSdk = createRequire(createRequire(import.meta.url).resolve('snowflake-sdk'))
const Column = requireSdk('./lib/connection/result/column.js')
const DataTypes = requireSdk('./lib/connection/result/data_types.js')
const bigInt = requireSdk('big-integer')

type ExecuteOptions = { sqlText: string, binds?: any[], parameters?: Record<string, any>, streamResult?: boolean, complete: (err: any, stmt: any, rows?: any[]) => void }

// Mutable state driving the mocked Snowflake driver.
let connectError: Error | undefined
let executeImpl: (options: ExecuteOptions) => void
let connectionOptions: any[] = []
let executed: ExecuteOptions[] = []
let destroyed = 0

const fakeSnowflake = {
  configure: () => {},
  createConnection: (options: any) => {
    connectionOptions.push(options)
    return {
      connect: (cb: (err?: Error) => void) => cb(connectError),
      destroy: (cb: () => void) => { destroyed++; cb() },
      execute: (options: ExecuteOptions) => {
        executed.push(options)
        executeImpl(options)
        return {}
      }
    }
  }
}

// Must be registered before the plugin (and its connection module) is imported.
mock.module('snowflake-sdk', { exports: { default: fakeSnowflake } })

const catalogConfig: SnowflakeConfig = {
  account: 'xy12345',
  user: 'test_user',
  password: '********',
  warehouse: 'WH',
  role: 'ROLE',
  database: undefined
}

const secrets = { password: 's3cr3t' }

// Rows as returned by the SHOW commands (integers are big integers, see jsTreatIntegerAsBigInt).
const defaultQueryResult = (options: ExecuteOptions) => {
  const { sqlText } = options
  if (/SHOW DATABASES/i.test(sqlText)) {
    options.complete(undefined, {}, [{ name: 'DB1' }, { name: 'SNOWFLAKE' }, { name: 'DB2' }])
  } else if (/SHOW SCHEMAS IN DATABASE/i.test(sqlText)) {
    options.complete(undefined, {}, [{ name: 'PUBLIC' }, { name: 'INFORMATION_SCHEMA' }, { name: 'RAW' }])
  } else if (/SHOW OBJECTS IN SCHEMA/i.test(sqlText)) {
    options.complete(undefined, {}, [
      { created_on: new Date(), name: 'T1', database_name: 'DB1', schema_name: 'RAW', kind: 'TABLE', comment: 'Table 1', rows: bigInt(10), bytes: bigInt(2048) },
      { created_on: new Date(), name: 'V1', database_name: 'DB1', schema_name: 'RAW', kind: 'VIEW', comment: '', rows: null, bytes: null },
      { created_on: new Date(), name: 'a/b%c', database_name: 'DB1', schema_name: 'RAW', kind: 'TABLE', comment: '', rows: bigInt(0), bytes: bigInt(0) }
    ])
  } else if (/CURRENT_DATABASE/i.test(sqlText)) {
    options.complete(undefined, {}, [{ WAREHOUSE: 'WH', DATABASE: 'DB1', NAME: 'DB1' }])
  } else {
    options.complete(undefined, {}, [])
  }
}

describe('snowflake catalog', () => {
  before(async () => {
    if (!fs.existsSync('./test-it/test-dl')) fs.mkdirSync('./test-it/test-dl', { recursive: true })
  })
  after(() => fs.removeSync('./test-it/test-dl'))
  beforeEach(() => {
    connectError = undefined
    executeImpl = defaultQueryResult
    connectionOptions = []
    executed = []
    destroyed = 0
    fs.emptyDirSync('./test-it/test-dl')
  })

  const getPlugin = async () => {
    const mod = await import('../index.ts')
    return mod.default as CatalogPlugin
  }

  describe('connection options', () => {
    it('should use the secret password when the config one is masked', async () => {
      const { snowflakeConnectionOptions } = await import('../lib/connection.ts')
      const options = snowflakeConnectionOptions(catalogConfig, secrets)
      assert.equal(options.account, 'xy12345')
      assert.equal(options.username, 'test_user')
      assert.equal(options.password, 's3cr3t')
      assert.equal(options.authenticator, undefined)
      assert.equal(options.warehouse, 'WH')
      assert.equal(options.role, 'ROLE')
      assert.equal(options.database, undefined)
      assert.equal(options.jsTreatIntegerAsBigInt, true)
      assert.equal(options.representNullAsStringNull, false)
    })

    it('should use the plain password and the configured database when set', async () => {
      const { snowflakeConnectionOptions } = await import('../lib/connection.ts')
      const options = snowflakeConnectionOptions({ ...catalogConfig, password: 'plain', database: 'DB1' }, {})
      assert.equal(options.password, 'plain')
      assert.equal(options.database, 'DB1')
    })

    it('should use the key pair from the secrets', async () => {
      const { snowflakeConnectionOptions } = await import('../lib/connection.ts')
      const config: SnowflakeConfig = { ...catalogConfig, password: undefined, authMethod: 'keyPair', privateKey: '********', privateKeyPass: '********' }
      const options = snowflakeConnectionOptions(config, { privateKey: 'PEM', privateKeyPass: 'pass' })
      assert.equal(options.authenticator, 'SNOWFLAKE_JWT')
      assert.equal(options.privateKey, 'PEM')
      assert.equal(options.privateKeyPass, 'pass')
      assert.equal(options.password, undefined)
    })

    it('should omit the passphrase of an unencrypted private key', async () => {
      const { snowflakeConnectionOptions } = await import('../lib/connection.ts')
      const options = snowflakeConnectionOptions({ ...catalogConfig, authMethod: 'keyPair', privateKey: '********' }, { privateKey: 'PEM' })
      assert.equal(options.privateKey, 'PEM')
      assert.ok(!('privateKeyPass' in options))
    })
  })

  describe('config schema', () => {
    it('should keep accepting the configs stored before the authentication method choice', async () => {
      const plugin = await getPlugin()
      assert.doesNotThrow(() => plugin.assertConfigValid({ account: 'xy12345.eu-west-1', user: 'u', password: '********', warehouse: 'WH' }))
    })

    it('should require the field of the selected authentication method', async () => {
      const plugin = await getPlugin()
      const base = { account: 'xy12345', user: 'u', warehouse: 'WH' }
      assert.throws(() => plugin.assertConfigValid(base))
      assert.throws(() => plugin.assertConfigValid({ ...base, authMethod: 'keyPair', password: 'x' }))
      assert.doesNotThrow(() => plugin.assertConfigValid({ ...base, authMethod: 'keyPair', privateKey: 'PEM' }))
    })
  })

  describe('prepare', () => {
    it('should mask the password and store it as a secret', async () => {
      const plugin = await getPlugin()
      const config = { ...catalogConfig, password: '12345' }
      const { catalogConfig: newConfig, secrets: newSecrets } = await plugin.prepare({ catalogConfig: config, secrets: {}, capabilities: [] })
      assert.equal((newConfig as SnowflakeConfig).password, '********')
      assert.equal(newSecrets?.password, '12345')
      assert.equal(destroyed, 1)
    })

    it('should mask the key pair, store it as secrets and drop the password', async () => {
      const plugin = await getPlugin()
      const config: SnowflakeConfig = { ...catalogConfig, authMethod: 'keyPair', password: '********', privateKey: 'PEM', privateKeyPass: 'pass' }
      const { catalogConfig: newConfig, secrets: newSecrets } = await plugin.prepare({ catalogConfig: config, secrets: { password: 'old' }, capabilities: [] })
      assert.equal((newConfig as SnowflakeConfig).privateKey, '********')
      assert.equal((newConfig as SnowflakeConfig).privateKeyPass, '********')
      assert.equal((newConfig as SnowflakeConfig).password, undefined)
      assert.deepEqual(newSecrets, { privateKey: 'PEM', privateKeyPass: 'pass' })
      assert.equal(connectionOptions[0].privateKey, 'PEM')
    })

    it('should forget the passphrase when it is emptied', async () => {
      const plugin = await getPlugin()
      const config: SnowflakeConfig = { ...catalogConfig, authMethod: 'keyPair', privateKey: '********', privateKeyPass: '' }
      const { secrets: newSecrets } = await plugin.prepare({ catalogConfig: config, secrets: { privateKey: 'PEM', privateKeyPass: 'pass' }, capabilities: [] })
      assert.deepEqual(newSecrets, { privateKey: 'PEM' })
    })

    it('should throw Connection test failed with the reason on a login error', async () => {
      const plugin = await getPlugin()
      connectError = new Error('Incorrect username or password')
      await assert.rejects(
        plugin.prepare({ catalogConfig: { ...catalogConfig }, secrets: {}, capabilities: [] }),
        /Connection test failed: .*Incorrect username or password/
      )
      assert.equal(destroyed, 1)
    })

    it('should fail when the warehouse is not usable', async () => {
      const plugin = await getPlugin()
      executeImpl = (options) => options.complete(undefined, {}, [{ WAREHOUSE: null, DATABASE: null }])
      await assert.rejects(
        plugin.prepare({ catalogConfig: { ...catalogConfig }, secrets, capabilities: [] }),
        /Connection test failed: Warehouse WH does not exist/
      )
      assert.equal(destroyed, 1)
    })

    it('should fail when the configured database is not usable', async () => {
      const plugin = await getPlugin()
      executeImpl = (options) => options.complete(undefined, {}, [{ WAREHOUSE: 'WH', DATABASE: null }])
      await assert.rejects(
        plugin.prepare({ catalogConfig: { ...catalogConfig, database: 'nope' }, secrets, capabilities: [] }),
        /Connection test failed: Database nope does not exist/
      )
    })
  })

  describe('ids', () => {
    it('should round trip identifiers containing "/" and "%"', async () => {
      const { buildId, resourceParts } = await import('../lib/ids.ts')
      const names: [string, string, string] = ['my/db', '100%', 'a%2Fb/"c"']
      assert.deepEqual(resourceParts(buildId(...names)), names)
    })

    it('should keep the ids of plain identifiers unchanged', async () => {
      const { buildId, resourceParts } = await import('../lib/ids.ts')
      assert.equal(buildId('DB1', 'RAW', 'My Table.v2'), 'DB1/RAW/My Table.v2')
      assert.deepEqual(resourceParts('DB1/RAW/My Table.v2'), ['DB1', 'RAW', 'My Table.v2'])
    })
  })

  describe('list', () => {
    it('should list databases and filter system databases', async () => {
      const plugin = await getPlugin()
      const res = await plugin.list!({ catalogConfig, secrets, params: {} })
      assert.equal(res.count, 2)
      assert.deepEqual(res.results.map(r => r.title), ['DB1', 'DB2'])
      assert.ok(res.results.every(r => r.type === 'folder'))
      assert.equal(res.path.length, 0)
      assert.equal(destroyed, 1)
    })

    it('should list schemas of the configured database with its actual name', async () => {
      const plugin = await getPlugin()
      const res = await plugin.list!({ catalogConfig: { ...catalogConfig, database: 'db1' }, secrets, params: {} })
      assert.deepEqual(res.results.map(r => r.title), ['PUBLIC', 'RAW'])
      assert.deepEqual(res.results.map(r => r.id), ['DB1/PUBLIC', 'DB1/RAW'])
      assert.ok(executed.some(e => e.sqlText === 'SHOW SCHEMAS IN DATABASE "DB1"'))
    })

    it('should list schemas of a selected database', async () => {
      const plugin = await getPlugin()
      const res = await plugin.list!({ catalogConfig, secrets, params: { currentFolderId: 'DB1' } })
      assert.deepEqual(res.results.map(r => r.title), ['PUBLIC', 'RAW'])
      assert.equal(res.path.length, 1)
      assert.equal(res.path[0].id, 'DB1')
    })

    it('should list tables and views as csv resources', async () => {
      const plugin = await getPlugin()
      const res = await plugin.list!({ catalogConfig, secrets, params: { currentFolderId: 'DB1/RAW' } })
      assert.ok(executed.some(e => e.sqlText === 'SHOW OBJECTS IN SCHEMA "DB1"."RAW"'))
      assert.ok(executed.every(e => e.parameters?.STATEMENT_TIMEOUT_IN_SECONDS > 0))
      assert.equal(res.count, 3)
      const [t1, v1, special] = res.results as any[]
      assert.equal(t1.type, 'resource')
      assert.equal(t1.id, 'DB1/RAW/T1')
      assert.equal(t1.format, 'csv')
      assert.equal(t1.description, 'Table 1')
      assert.equal(t1.size, 2048)
      assert.equal(v1.title, 'V1')
      assert.equal(v1.size, undefined)
      assert.equal(special.title, 'a/b%c')
      assert.equal(special.id, 'DB1/RAW/a%2Fb%25c')
      assert.equal(res.path.length, 2)
    })

    it('should filter results with the search param', async () => {
      const plugin = await getPlugin()
      const res = await plugin.list!({ catalogConfig, secrets, params: { currentFolderId: 'DB1/RAW', q: 'v1' } })
      assert.equal(res.count, 1)
      assert.equal(res.results[0].title, 'V1')
    })

    it('should destroy the connection when a query fails', async () => {
      const plugin = await getPlugin()
      executeImpl = (options) => options.complete(new Error('Insufficient privileges'), undefined)
      await assert.rejects(plugin.list!({ catalogConfig, secrets, params: {} }), /Insufficient privileges/)
      assert.equal(destroyed, 1)
    })
  })

  describe('getResource', () => {
    // Snowflake column metadata and raw values, converted by the real driver columns.
    const statementParameters = {
      TIMEZONE: 'Europe/Paris',
      DATE_OUTPUT_FORMAT: 'YYYY-MM-DD',
      TIME_OUTPUT_FORMAT: 'HH24:MI:SS',
      TIMESTAMP_OUTPUT_FORMAT: 'YYYY-MM-DD HH24:MI:SS.FF3 TZHTZM',
      TIMESTAMP_NTZ_OUTPUT_FORMAT: 'YYYY-MM-DD HH24:MI:SS.FF3',
      BINARY_OUTPUT_FORMAT: 'HEX',
      JS_TREAT_INTEGER_AS_BIGINT: true
    }
    const rawColumns: [Record<string, any>, string | null, string | null][] = [
      [{ name: 'ID', type: 'fixed', scale: 0, precision: 38 }, '12345678901234567890', '2'],
      [{ name: 'Price (€)', type: 'fixed', scale: 2, precision: 10 }, '1.50', null],
      [{ name: 'RATIO', type: 'real' }, '0.25', '2'],
      [{ name: 'ACTIVE', type: 'boolean' }, '1', '0'],
      [{ name: 'CREATED', type: 'date' }, '19723', null],
      [{ name: 'AT_NTZ', type: 'timestamp_ntz', scale: 9 }, '1704103200.123000000', null],
      [{ name: 'AT_LTZ', type: 'timestamp_ltz', scale: 9 }, '1704103200.000000000', null],
      [{ name: 'AT_TIME', type: 'time', scale: 0 }, '36000', null],
      [{ name: 'BIN', type: 'binary' }, 'ABCD', null],
      [{ name: 'DATA', type: 'variant' }, '{"a":[1,"x,y"]}', null],
      [{ name: '_FIVETRAN_SYNCED', type: 'text' }, 'a "quoted", text', null]
    ]
    const columns = rawColumns.map(([columnMetadata], index) => new Column({
      columnMetadata: { nullable: true, ...columnMetadata },
      index,
      statementParameters,
      resultVersion: '1',
      onPrecisionLoss: () => {},
      onNonJsonCompliantVariant: () => {}
    }))
    let rows: Record<string, any>[] = []

    before(async () => {
      // the real driver applies this connection option globally
      const { snowflakeConnectionOptions } = await import('../lib/connection.ts')
      DataTypes.setIsRepresentNullAsStringNull(snowflakeConnectionOptions(catalogConfig, secrets).representNullAsStringNull)
      rows = [1, 2].map(i => {
        const row = { values: rawColumns.map(column => column[i]), _arrayProcessedColumns: [] }
        return Object.fromEntries(columns.map((column: any) => [column.getName(), column._getRowValue(row)]))
      })
    })

    beforeEach(() => {
      executeImpl = (options) => {
        if (options.streamResult) {
          options.complete(undefined, {
            getColumns: () => columns,
            getNumRows: () => rows.length,
            streamRows: () => Readable.from(rows)
          })
          return
        }
        options.complete(undefined, {}, [])
      }
    })

    const getResource = async (resourceId: string, schema = true) => (await getPlugin()).getResource!({
      catalogConfig,
      secrets,
      importConfig: {},
      resourceId,
      tmpDir: './test-it/test-dl',
      log: logFunctions,
      update: { metadata: schema, schema }
    })

    it('should export the table to a csv file with a mapped schema', async () => {
      const res = await getResource('DB1/RAW/T1')
      assert.ok(executed.some(e => e.sqlText === 'SELECT * FROM "DB1"."RAW"."T1"' && e.parameters?.STATEMENT_TIMEOUT_IN_SECONDS > 0))
      assert.equal(destroyed, 1)
      assert.equal(res.title, 'T1')
      assert.equal(res.format, 'csv')
      assert.equal(res.filePath, 'test-it/test-dl/T1.csv')
      const lines = (await fs.readFile(res.filePath, 'utf-8')).trim().split('\n')
      assert.equal(lines[0], 'ID,Price (€),RATIO,ACTIVE,CREATED,AT_NTZ,AT_LTZ,AT_TIME,BIN,DATA,_FIVETRAN_SYNCED')
      assert.equal(lines[1], '12345678901234567890,1.5,0.25,true,2024-01-01,2024-01-01T10:00:00,2024-01-01T10:00:00.000Z,10:00:00,ABCD,"{""a"":[1,""x,y""]}","a ""quoted"", text"')
      assert.equal(lines[2], '2,,2,false,,,,,,,')
      assert.deepEqual(res.schema, [
        { key: 'id', type: 'integer', 'x-originalName': 'ID' },
        { key: 'price_euro', type: 'number', 'x-originalName': 'Price (€)' },
        { key: 'ratio', type: 'number', 'x-originalName': 'RATIO' },
        { key: 'active', type: 'boolean', 'x-originalName': 'ACTIVE' },
        { key: 'created', type: 'string', format: 'date', 'x-originalName': 'CREATED' },
        { key: 'at_ntz', type: 'string', format: 'date-time', 'x-originalName': 'AT_NTZ' },
        { key: 'at_ltz', type: 'string', format: 'date-time', 'x-originalName': 'AT_LTZ' },
        { key: 'at_time', type: 'string', 'x-originalName': 'AT_TIME' },
        { key: 'bin', type: 'string', 'x-originalName': 'BIN' },
        { key: 'data', type: 'string', 'x-originalName': 'DATA' },
        { key: 'fivetran_synced', type: 'string', 'x-originalName': '_FIVETRAN_SYNCED' }
      ])
    })

    it('should omit the schema when schema update is disabled', async () => {
      const res = await getResource('DB1/RAW/T1', false)
      assert.equal(res.schema, undefined)
    })

    it('should export a table whose name contains path separators inside the tmp dir', async () => {
      const res = await getResource('DB1/RAW/..%2F..%2Fevil')
      assert.ok(executed.some(e => e.sqlText === 'SELECT * FROM "DB1"."RAW"."../../evil"'))
      assert.equal(res.filePath, 'test-it/test-dl/.._.._evil.csv')
      assert.ok(await fs.pathExists(res.filePath))
    })

    it('should throw on an invalid resource id', async () => {
      await assert.rejects(getResource('DB1/RAW'), /Invalid Snowflake resource id/)
    })
  })
})
