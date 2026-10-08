import type { SnowflakeConfig } from '#types'
import type { CatalogPlugin } from '@data-fair/types-catalogs'

import { strict as assert } from 'node:assert'
import { Readable } from 'node:stream'
import { describe, it, before, after, beforeEach, mock } from 'node:test'
import fs from 'fs-extra'
import { logFunctions } from './test-utils.ts'

// Mutable state driving the mocked Snowflake driver.
let connectError: Error | undefined
let executeImpl: (options: { sqlText: string, streamResult?: boolean, complete: (err: any, stmt: any, rows?: any[]) => void }) => void

const fakeColumn = (name: string, opts: { number?: boolean, boolean?: boolean, date?: boolean, timestamp?: boolean, scale?: number } = {}) => ({
  getName: () => name,
  getScale: () => opts.scale ?? 0,
  isNumber: () => !!opts.number,
  isBoolean: () => !!opts.boolean,
  isDate: () => !!opts.date,
  isTimestamp: () => !!opts.timestamp,
  isTimestampLtz: () => false,
  isTimestampNtz: () => false,
  isTimestampTz: () => false
})

const fakeSnowflake = {
  createConnection: () => ({
    connect: (cb: (err?: Error) => void) => cb(connectError),
    destroy: (cb: () => void) => cb(),
    execute: (options: any) => {
      executeImpl(options)
      return {}
    }
  })
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

const defaultQueryResult = (options: { sqlText: string, complete: (err: any, stmt: any, rows?: any[]) => void }) => {
  const { sqlText } = options
  if (/SHOW DATABASES/i.test(sqlText)) {
    options.complete(undefined, {}, [{ name: 'DB1' }, { name: 'SNOWFLAKE' }, { name: 'DB2' }])
  } else if (/SHOW SCHEMAS IN DATABASE/i.test(sqlText)) {
    options.complete(undefined, {}, [{ name: 'PUBLIC' }, { name: 'INFORMATION_SCHEMA' }, { name: 'RAW' }])
  } else if (/SHOW TABLES IN SCHEMA/i.test(sqlText)) {
    options.complete(undefined, {}, [
      { name: 'T1', kind: 'TABLE', comment: 'Table 1', last_altered: '2024-01-02 03:04:05' },
      { name: 'V1', kind: 'VIEW' }
    ])
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
      assert.equal(options.warehouse, 'WH')
      assert.equal(options.role, 'ROLE')
      assert.equal(options.database, undefined)
    })

    it('should use the plain password and the configured database when set', async () => {
      const { snowflakeConnectionOptions } = await import('../lib/connection.ts')
      const options = snowflakeConnectionOptions({ ...catalogConfig, password: 'plain', database: 'DB1' }, {})
      assert.equal(options.password, 'plain')
      assert.equal(options.database, 'DB1')
    })
  })

  describe('prepare', () => {
    it('should mask the password and store it as a secret', async () => {
      const plugin = await getPlugin()
      const config = { ...catalogConfig, password: '12345' }
      const { catalogConfig: newConfig, secrets: newSecrets } = await plugin.prepare({ catalogConfig: config, secrets: {}, capabilities: [] })
      assert.equal((newConfig as SnowflakeConfig).password, '********')
      assert.equal(newSecrets?.password, '12345')
    })

    it('should throw Connection test failed on a login error', async () => {
      const plugin = await getPlugin()
      connectError = new Error('Incorrect username or password')
      await assert.rejects(
        plugin.prepare({ catalogConfig: { ...catalogConfig }, secrets: {}, capabilities: [] }),
        /Connection test failed/
      )
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
    })

    it('should list schemas of the configured database and filter INFORMATION_SCHEMA', async () => {
      const plugin = await getPlugin()
      const res = await plugin.list!({ catalogConfig: { ...catalogConfig, database: 'DB1' }, secrets, params: {} })
      assert.deepEqual(res.results.map(r => r.title), ['PUBLIC', 'RAW'])
      assert.deepEqual(res.results.map(r => r.id), ['DB1/PUBLIC', 'DB1/RAW'])
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
      assert.equal(res.count, 2)
      const t1 = res.results.find(r => r.title === 'T1')!
      assert.equal(t1.type, 'resource')
      assert.equal(t1.id, 'DB1/RAW/T1')
      assert.equal((t1 as any).format, 'csv')
      assert.equal((t1 as any).description, 'Table 1')
      assert.equal((t1 as any).updatedAt, new Date('2024-01-02 03:04:05').toISOString())
      assert.equal(res.path.length, 2)
    })

    it('should filter results with the search param', async () => {
      const plugin = await getPlugin()
      const res = await plugin.list!({ catalogConfig, secrets, params: { currentFolderId: 'DB1/RAW', q: 'v1' } })
      assert.equal(res.count, 1)
      assert.equal(res.results[0].title, 'V1')
    })
  })

  describe('getResource', () => {
    beforeEach(() => {
      executeImpl = (options) => {
        if (options.streamResult) {
          options.complete(undefined, {
            getColumns: () => [
              fakeColumn('ID', { number: true, scale: 0 }),
              fakeColumn('PRICE', { number: true, scale: 2 }),
              fakeColumn('ACTIVE', { boolean: true }),
              fakeColumn('CREATED', { date: true }),
              fakeColumn('UPDATED', { timestamp: true }),
              fakeColumn('NAME')
            ],
            streamRows: () => Readable.from([
              { ID: 1, PRICE: 1.5, ACTIVE: true, CREATED: new Date('2024-01-01T00:00:00.000Z'), UPDATED: new Date('2024-01-02T00:00:00.000Z'), NAME: 'a' },
              { ID: 2, PRICE: 2, ACTIVE: false, CREATED: new Date('2024-02-01T00:00:00.000Z'), UPDATED: new Date('2024-02-02T00:00:00.000Z'), NAME: 'b' }
            ])
          })
          return
        }
        options.complete(undefined, {}, [])
      }
    })

    it('should export the table to a csv file with a mapped schema', async () => {
      const plugin = await getPlugin()
      const res = await plugin.getResource!({
        catalogConfig,
        secrets,
        importConfig: {},
        resourceId: 'DB1/RAW/T1',
        tmpDir: './test-it/test-dl',
        log: logFunctions,
        update: { metadata: true, schema: true }
      })
      assert.equal(res.title, 'T1')
      assert.equal(res.format, 'csv')
      assert.equal(res.filePath, './test-it/test-dl/T1.csv')
      assert.ok(await fs.pathExists(res.filePath))
      const content = await fs.readFile(res.filePath, 'utf-8')
      const lines = content.trim().split('\n')
      assert.equal(lines[0], 'ID,PRICE,ACTIVE,CREATED,UPDATED,NAME')
      assert.match(lines[1], /^1,1\.5,true,2024-01-01T00:00:00\.000Z,/)
      assert.deepEqual(res.schema, [
        { key: 'ID', type: 'integer', 'x-originalName': 'ID' },
        { key: 'PRICE', type: 'number', 'x-originalName': 'PRICE' },
        { key: 'ACTIVE', type: 'boolean', 'x-originalName': 'ACTIVE' },
        { key: 'CREATED', type: 'string', format: 'date', 'x-originalName': 'CREATED' },
        { key: 'UPDATED', type: 'string', format: 'date-time', 'x-originalName': 'UPDATED' },
        { key: 'NAME', type: 'string', 'x-originalName': 'NAME' }
      ])
    })

    it('should omit the schema when schema update is disabled', async () => {
      const plugin = await getPlugin()
      const res = await plugin.getResource!({
        catalogConfig,
        secrets,
        importConfig: {},
        resourceId: 'DB1/RAW/T1',
        tmpDir: './test-it/test-dl',
        log: logFunctions,
        update: { metadata: false, schema: false }
      })
      assert.equal(res.schema, undefined)
    })

    it('should throw on an invalid resource id', async () => {
      const plugin = await getPlugin()
      await assert.rejects(
        plugin.getResource!({
          catalogConfig,
          secrets,
          importConfig: {},
          resourceId: 'DB1/RAW',
          tmpDir: './test-it/test-dl',
          log: logFunctions,
          update: { metadata: false, schema: false }
        }),
        /Invalid Snowflake resource id/
      )
    })
  })
})
