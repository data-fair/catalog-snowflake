import snowflake from 'snowflake-sdk'
import type { Connection, ConnectionOptions, RowStatement } from 'snowflake-sdk'
import type { SnowflakeConfig } from '#types'

// By default the driver logs at INFO level both to the console and to a "snowflake.log" file
// in the working directory, and parses non strict JSON variants with `new Function()`.
snowflake.configure({ logLevel: 'WARN', logFilePath: 'STDOUT', jsonColumnVariantParser: JSON.parse })

/** The value displayed in the config in place of a secret stored in the catalog secrets. */
export const MASKED_SECRET = '********'

const secret = (value: string | undefined, stored: string | undefined) => value === MASKED_SECRET ? stored : value

/** Timeouts (in seconds) of the metadata queries and of the table exports. */
export const METADATA_STATEMENT_TIMEOUT = 120
export const EXPORT_STATEMENT_TIMEOUT = 3600

/**
 * Resolve the connection options for the Snowflake driver.
 * The masked secrets ("********") are replaced by the deciphered ones.
 * Configs created before `authMethod` existed use the password.
 */
export const snowflakeConnectionOptions = (
  catalogConfig: SnowflakeConfig,
  secrets: Record<string, string>
): ConnectionOptions => {
  const privateKeyPass = secret(catalogConfig.privateKeyPass, secrets.privateKeyPass)
  const auth = catalogConfig.authMethod === 'keyPair'
    ? {
        authenticator: 'SNOWFLAKE_JWT',
        privateKey: secret(catalogConfig.privateKey, secrets.privateKey),
        ...(privateKeyPass ? { privateKeyPass } : {})
      }
    : { password: secret(catalogConfig.password, secrets.password) }
  return {
    account: catalogConfig.account,
    username: catalogConfig.user,
    ...auth,
    warehouse: catalogConfig.warehouse,
    ...(catalogConfig.role ? { role: catalogConfig.role } : {}),
    ...(catalogConfig.database ? { database: catalogConfig.database } : {}),
    // INTEGER columns are returned as big integers instead of losing precision above 2^53
    jsTreatIntegerAsBigInt: true,
    // otherwise null TIME values are returned as the "NULL" string
    representNullAsStringNull: false
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
      parameters: { STATEMENT_TIMEOUT_IN_SECONDS: METADATA_STATEMENT_TIMEOUT },
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
      parameters: { STATEMENT_TIMEOUT_IN_SECONDS: EXPORT_STATEMENT_TIMEOUT },
      complete: (err, stmt) => err ? reject(err) : resolve(stmt as RowStatement)
    })
  })
