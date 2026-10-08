import type { SnowflakeConfig } from '#types'
import type { ListContext, Folder, CatalogPlugin } from '@data-fair/types-catalogs'
import type capabilities from './capabilities.ts'
import { executeQuery, withSnowflakeConnection } from './connection.ts'
import { folderSegments, quoteIdentifier } from './ids.ts'

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

const resource = (database: string, schema: string, row: Record<string, any>): ResourceItem => {
  const name = String(rowValue(row, 'name'))
  const comment = rowValue(row, 'comment')
  const lastAltered = rowValue(row, 'last_altered')
  const lastAlteredDate = lastAltered ? new Date(lastAltered) : undefined
  const updatedAt = lastAlteredDate && !isNaN(lastAlteredDate.getTime()) ? lastAlteredDate.toISOString() : undefined
  return {
    id: `${database}/${schema}/${name}`,
    title: name,
    type: 'resource',
    description: comment ? String(comment) : '',
    format: 'csv',
    mimeType: 'text/csv',
    ...(updatedAt ? { updatedAt } : {})
  }
}

/**
 * Lists databases, schemas or tables/views depending on the current folder.
 *
 * - no `database` in the config and no current folder: lists the accessible databases
 * - a database selected (or `database` in the config): lists its schemas
 * - a schema selected: lists its tables and views as importable CSV resources
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
        .map(name => folder(name, name))
      return
    }

    const database = segments[0] ?? catalogConfig.database
    if (!database) throw new Error('No database selected')

    if (segments.length <= 1) {
      const rows = await executeQuery(connection, `SHOW SCHEMAS IN DATABASE ${quoteIdentifier(database)}`)
      folders = rows
        .map(row => String(rowValue(row, 'name')))
        .filter(name => !SYSTEM_SCHEMAS.has(name.toUpperCase()))
        .map(name => folder(`${database}/${name}`, name))
      return
    }

    const schema = segments[1]
    const rows = await executeQuery(connection, `SHOW TABLES IN SCHEMA ${quoteIdentifier(database)}.${quoteIdentifier(schema)}`)
    resources = rows.map(row => resource(database, schema, row))
  })

  let results: ResourceList = [...folders, ...resources]
  if (params.q) {
    const q = params.q.toLowerCase()
    results = results.filter(item => item.title.toLowerCase().includes(q))
  }

  const path = segments.map((segment, i) => folder(segments.slice(0, i + 1).join('/'), segment))

  return {
    count: results.length,
    results,
    path
  }
}
