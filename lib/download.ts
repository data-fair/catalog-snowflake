import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { stringify } from 'csv-stringify'
import slugify from 'slugify'
import type { Column } from 'snowflake-sdk'
import type { SnowflakeConfig } from '#types'
import type { CatalogPlugin, GetResourceContext, Resource } from '@data-fair/types-catalogs'
import { executeStreaming, withSnowflakeConnection } from './connection.ts'
import { quoteIdentifier, resourceParts } from './ids.ts'

type DataFairField = { key: string, type: string, format?: string, 'x-originalName': string }

/**
 * Same key escaping as data-fair, which matches the given schema with the CSV columns by key.
 */
export const escapeKey = (name: string) => slugify(name, { lower: true, strict: true, replacement: '_' })

/**
 * Map Snowflake columns to data-fair schema fields.
 * data-fair still detects the final types from the CSV values (see the formatting below),
 * and ignores the columns whose name escapes to an empty key.
 */
export const columnsToSchema = (columns: Column[]): DataFairField[] =>
  columns
    .map((column) => {
      const name = column.getName()
      const field: DataFairField = { key: escapeKey(name), type: 'string', 'x-originalName': name }
      if (column.isNumber()) {
        field.type = column.getScale() === 0 ? 'integer' : 'number'
      } else if (column.isBoolean()) {
        field.type = 'boolean'
      } else if (column.isDate()) {
        field.format = 'date'
      } else if (column.isTimestamp()) {
        field.format = 'date-time'
      }
      return field
    })
    .filter(field => field.key)

/**
 * The driver returns DATE and TIMESTAMP values as Date objects, all built in UTC.
 * DATE keeps only its day, TIMESTAMP_LTZ and TIMESTAMP_TZ are written as UTC instants.
 * TIMESTAMP_NTZ (no time zone) is written without the "Z" suffix nor the milliseconds,
 * the only local date-time format detected by data-fair.
 */
const toISOString = (value: Date) => value.toISOString()
const dateFormatter = (column: Column) => {
  if (column.isDate()) return (value: Date) => value.toISOString().slice(0, 10)
  if (column.isTimestampNtz()) return (value: Date) => value.toISOString().slice(0, 19)
  return toISOString
}

/**
 * Other non scalar values: BINARY is a Buffer (written in hexadecimal like Snowflake does),
 * big integers expose `toJSON()`, structured MAP columns are Map objects,
 * VARIANT, OBJECT and ARRAY values are plain JSON values. TIME values are already strings.
 */
const formatObject = (value: any): string => {
  if (Buffer.isBuffer(value)) return value.toString('hex').toUpperCase()
  if (value instanceof Map) return JSON.stringify(Object.fromEntries(value))
  if (typeof value.toJSON === 'function') return String(value.toJSON())
  return JSON.stringify(value)
}

/**
 * Export a table (or view) to a CSV file and return the data-fair resource.
 * Rows are streamed from Snowflake to the file to avoid buffering large tables.
 */
export const getResource = async (context: GetResourceContext<SnowflakeConfig>): ReturnType<CatalogPlugin['getResource']> => {
  const { catalogConfig, secrets, resourceId, tmpDir, update, log } = context
  const [database, schema, table] = resourceParts(resourceId)
  const sqlText = `SELECT * FROM ${quoteIdentifier(database)}.${quoteIdentifier(schema)}.${quoteIdentifier(table)}`
  // quoted identifiers can contain path separators
  const filePath = path.join(tmpDir, `${table.replace(/[/\\]/g, '_')}.csv`)

  await log.step(`Export of ${database}.${schema}.${table}`)
  let schemaFields: DataFairField[] | undefined
  await withSnowflakeConnection(catalogConfig, secrets, async (connection) => {
    const statement = await executeStreaming(connection, sqlText)
    const columns = statement.getColumns() ?? []
    if (update.schema && columns.length > 0) schemaFields = columnsToSchema(columns)

    const dateFormatters = new Map(columns.map(column => [column.getName(), dateFormatter(column)]))
    const csv = stringify({
      header: true,
      ...(columns.length > 0 ? { columns: columns.map(column => column.getName()) } : {}),
      cast: {
        date: (value, { column }) => (dateFormatters.get(String(column)) ?? toISOString)(value),
        boolean: (value: boolean) => value ? 'true' : 'false',
        object: formatObject
      }
    })
    await pipeline(statement.streamRows(), csv, fs.createWriteStream(filePath))
    await log.info(`${statement.getNumRows() ?? 0} rows exported`)
  })

  const resource: Resource = {
    id: resourceId,
    title: table,
    format: 'csv',
    filePath,
    ...(schemaFields ? { schema: schemaFields } : {})
  }
  return resource
}
