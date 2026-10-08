import snowflake from 'snowflake-sdk'
import type { Connection, ConnectionOptions, RowStatement } from 'snowflake-sdk'
import type { SnowflakeConfig } from '#types'

/**
 * Resolve the connection options for the Snowflake driver.
 * The masked password ("********") is replaced by the deciphered secret.
 */
export const snowflakeConnectionOptions = (
  catalogConfig: SnowflakeConfig,
  secrets: Record<string, string>
): ConnectionOptions => {
  const password = catalogConfig.password === '********' ? secrets.password : catalogConfig.password
  return {
    account: catalogConfig.account,
    username: catalogConfig.user,
    password,
    warehouse: catalogConfig.warehouse,
    ...(catalogConfig.role ? { role: catalogConfig.role } : {}),
    ...(catalogConfig.database ? { database: catalogConfig.database } : {})
  }
}

const connect = (connection: Connection) => new Promise<Connection>((resolve, reject) => {
  connection.connect(err => err ? reject(err) : resolve(connection))
})

const destroy = (connection: Connection) => new Promise<void>((resolve) => {
  connection.destroy(() => resolve())
})

/**
 * Timeouts and login failures are hard to diagnose from the config alone.
 * Enrich the error with the account actually targeted.
 */
export const snowflakeConnectionError = (err: any, catalogConfig: SnowflakeConfig) => {
  const target = `${catalogConfig.user}@${catalogConfig.account}`
  console.error(`Snowflake connection failed for ${target}`, err)
  return new Error(`Connection failed for ${target}: ${err?.message ?? err}`, { cause: err })
}

/**
 * Open a single Snowflake connection, run the callback, and always destroy the
 * connection. The plugin runs inside long lived processes: an undisposed
 * connection keeps a Snowflake session alive until the process restarts.
 */
export const withSnowflakeConnection = async <T>(
  catalogConfig: SnowflakeConfig,
  secrets: Record<string, string>,
  fn: (connection: Connection) => Promise<T>
): Promise<T> => {
  const connection = snowflake.createConnection(snowflakeConnectionOptions(catalogConfig, secrets))
  try {
    await connect(connection)
  } catch (err) {
    await destroy(connection)
    throw snowflakeConnectionError(err, catalogConfig)
  }
  try {
    return await fn(connection)
  } finally {
    await destroy(connection)
  }
}

/** Run a query and return its rows (object mode, keyed by column name). */
export const executeQuery = (connection: Connection, sqlText: string): Promise<any[]> =>
  new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      complete: (err, _stmt, rows) => err ? reject(err) : resolve(rows ?? [])
    })
  })

/**
 * Run a query in streaming mode. The statement's `streamRows()` can then be
 * consumed as a Node.js Readable stream, without loading the whole result in memory.
 */
export const executeStreaming = (connection: Connection, sqlText: string): Promise<RowStatement> =>
  new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      streamResult: true,
      complete: (err, stmt) => err ? reject(err) : resolve(stmt as RowStatement)
    })
  })
