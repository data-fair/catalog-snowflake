import type { SnowflakeConfig } from '#types'
import type { PrepareContext } from '@data-fair/types-catalogs'
import type { SnowflakeCapabilities } from './capabilities.ts'
import { executeQuery, withSnowflakeConnection } from './connection.ts'

export default async ({ catalogConfig, secrets }: PrepareContext<SnowflakeConfig, SnowflakeCapabilities>) => {
  if (catalogConfig.password === '') {
    delete secrets.password
  } else if (catalogConfig.password && catalogConfig.password !== '********') {
    secrets.password = catalogConfig.password
    catalogConfig.password = '********'
  }

  // try the Snowflake connection
  try {
    await withSnowflakeConnection(catalogConfig, secrets, async (connection) => {
      await executeQuery(connection, 'SELECT 1')
    })
  } catch (error) {
    console.error('Connection test failed:', error)
    throw new Error('Connection test failed', { cause: error })
  }

  return {
    catalogConfig,
    secrets
  }
}
