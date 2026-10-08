import fs from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { stringify } from 'csv-stringify'
import type { Column } from 'snowflake-sdk'
import type { SnowflakeConfig } from '#types'
import type { CatalogPlugin, GetResourceContext, Resource } from '@data-fair/types-catalogs'
import { executeStreaming, withSnowflakeConnection } from './connection.ts'
import { quoteIdentifier, resourceParts } from './ids.ts'

type DataFairField = { key: string, type: string, format?: string, 'x-originalName': string }

/**
 * Map Snowflake columns to data-fair schema fields, so the imported dataset
 * keeps accurate types instead of relying on CSV value sniffing.
 */
export const columnsToSchema = (columns: Column[]): DataFairField[] =>
  columns.map((column) => {
    const name = column.getName()
    const field: DataFairField = { key: name, type: 'string', 'x-originalName': name }
    if (column.isNumber()) {
      field.type = column.getScale() === 0 ? 'integer' : 'number'
    } else if (column.isBoolean()) {
      field.type = 'boolean'
    } else if (column.isDate()) {
      field.format = 'date'
    } else if (column.isTimestamp() || column.isTimestampLtz() || column.isTimestampNtz() || column.isTimestampTz()) {
      field.format = 'date-time'
    }
    return field
  })

/**
 * Export a table (or view) to a CSV file and return the data-fair resource.
 * Rows are streamed from Snowflake to the file to avoid buffering large tables.
 */
export const getResource = async (context: GetResourceContext<SnowflakeConfig>): ReturnType<CatalogPlugin['getResource']> => {
  const { catalogConfig, secrets, resourceId, tmpDir, update } = context
  const [database, schema, table] = resourceParts(resourceId)
  const sqlText = `SELECT * FROM ${quoteIdentifier(database)}.${quoteIdentifier(schema)}.${quoteIdentifier(table)}`
  const filePath = `${tmpDir}/${table}.csv`

  let schemaFields: DataFairField[] | undefined
  await withSnowflakeConnection(catalogConfig, secrets, async (connection) => {
    const statement = await executeStreaming(connection, sqlText)
    const columns = statement.getColumns() ?? []
    if (update.schema && columns.length > 0) schemaFields = columnsToSchema(columns)

    const csv = stringify({
      header: true,
      ...(columns.length > 0 ? { columns: columns.map(column => column.getName()) } : {}),
      cast: {
        date: (value: Date) => value.toISOString(),
        boolean: (value: boolean) => value ? 'true' : 'false'
      }
    })
    await pipeline(statement.streamRows(), csv, fs.createWriteStream(filePath))
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
