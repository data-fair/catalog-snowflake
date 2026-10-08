import type { SnowflakeConfig } from '#types'
import type { Connection } from 'snowflake-sdk'
import type { ListContext, Folder, CatalogPlugin } from '@data-fair/types-catalogs'
import type capabilities from './capabilities.ts'
import { executeQuery, withSnowflakeConnection } from './connection.ts'
import { buildId, folderSegments, quoteIdentifier } from './ids.ts'

type ResourceList = Awaited<ReturnType<CatalogPlugin['list']>>['results']
type ResourceItem = Extract<ResourceList[number], { type: 'resource' }>

const SYSTEM_DATABASES = new Set(['SNOWFLAKE'])
const SYSTEM_SCHEMAS = new Set(['INFORMATION_SCHEMA'])

/**
 * SHOW commands column names casing is not guaranteed, so read them case-insensitively.
 */
const rowValue = (row: Record<string, any>, key: string): any => {
  if (row[key] !== undefined) return row[key]
  const found = Object.keys(row).find(k => k.toLowerCase() === key.toLowerCase())
  return found ? row[found] : undefined
}

const folder = (id: string, title: string): Folder => ({ id, title, type: 'folder' })

/** Map a `SHOW OBJECTS` row (a table or a view) to an importable CSV resource. */
const resource = (database: string, schema: string, row: Record<string, any>): ResourceItem => {
  const name = String(rowValue(row, 'name'))
  const comment = rowValue(row, 'comment')
  // integers are returned as big integers (see jsTreatIntegerAsBigInt), views have no size
  const bytes = rowValue(row, 'bytes')
  const size = bytes === null || bytes === undefined ? NaN : Number(String(bytes))
  return {
    id: buildId(database, schema, name),
    title: name,
    type: 'resource',
    description: comment ? String(comment) : '',
    format: 'csv',
    mimeType: 'text/csv',
    ...(Number.isFinite(size) && size > 0 ? { size } : {})
  }
}

/**
 * The configured database is passed to the connection, where Snowflake resolves it like an
 * unquoted identifier ("mydb" is MYDB). Read back its actual name to quote it in later queries.
 */
const configuredDatabase = async (connection: Connection, catalogConfig: SnowflakeConfig): Promise<string> => {
  const [row] = await executeQuery(connection, 'SELECT CURRENT_DATABASE() AS "NAME"')
  const name = row?.NAME
  if (!name) throw new Error(`Database ${catalogConfig.database} does not exist or is not authorized for the current role`)
  return name
}

/**
 * Lists databases, schemas or tables/views depending on the current folder.
 *
 * - no `database` in the config and no current folder: lists the accessible databases
 * - a database selected (or `database` in the config): lists its schemas
 * - a schema selected: lists its tables and views as importable CSV resources
 *
 * SHOW commands do not need a running warehouse, but return at most 10000 objects.
 */
export const list = async ({ catalogConfig, secrets, params }: ListContext<SnowflakeConfig, typeof capabilities>): ReturnType<CatalogPlugin['list']> => {
  const segments = folderSegments(params.currentFolderId)
  let folders: Folder[] = []
  let resources: ResourceItem[] = []

  await withSnowflakeConnection(catalogConfig, secrets, async (connection) => {
    if (segments.length === 0 && !catalogConfig.database) {
      const rows = await executeQuery(connection, 'SHOW DATABASES')
      folders = rows
        .map(row => String(rowValue(row, 'name')))
        .filter(name => !SYSTEM_DATABASES.has(name.toUpperCase()))
        .map(name => folder(buildId(name), name))
      return
    }

    const database = segments[0] ?? await configuredDatabase(connection, catalogConfig)

    if (segments.length <= 1) {
      const rows = await executeQuery(connection, `SHOW SCHEMAS IN DATABASE ${quoteIdentifier(database)}`)
      folders = rows
        .map(row => String(rowValue(row, 'name')))
        .filter(name => !SYSTEM_SCHEMAS.has(name.toUpperCase()))
        .map(name => folder(buildId(database, name), name))
      return
    }

    const schema = segments[1]
    // unlike SHOW TABLES, SHOW OBJECTS also returns the views
    const rows = await executeQuery(connection, `SHOW OBJECTS IN SCHEMA ${quoteIdentifier(database)}.${quoteIdentifier(schema)}`)
    resources = rows.map(row => resource(database, schema, row))
  })

  let results: ResourceList = [...folders, ...resources]
  if (params.q) {
    const q = params.q.toLowerCase()
    results = results.filter(item => item.title.toLowerCase().includes(q))
  }

  const path = segments.map((segment, i) => folder(buildId(...segments.slice(0, i + 1)), segment))

  return {
    count: results.length,
    results,
    path
  }
}
