import type { SnowflakeConfig } from '#types'
import type { PrepareContext } from '@data-fair/types-catalogs'
import type { SnowflakeCapabilities } from './capabilities.ts'
import { MASKED_SECRET, executeQuery, withSnowflakeConnection } from './connection.ts'

type SecretKey = 'password' | 'privateKey' | 'privateKeyPass'

export default async ({ catalogConfig, secrets }: PrepareContext<SnowflakeConfig, SnowflakeCapabilities>) => {
  // move a secret from the config to the catalog secrets, and mask it in the config
  const storeSecret = (key: SecretKey) => {
    const value = catalogConfig[key]
    if (value === '') {
      delete secrets[key]
    } else if (value && value !== MASKED_SECRET) {
      secrets[key] = value
      catalogConfig[key] = MASKED_SECRET
    }
  }
  // forget the secrets of the authentication method not used
  const dropSecret = (key: SecretKey) => {
    delete secrets[key]
    delete catalogConfig[key]
  }

  if (catalogConfig.authMethod === 'keyPair') {
    dropSecret('password')
    storeSecret('privateKey')
    storeSecret('privateKeyPass')
  } else {
    dropSecret('privateKey')
    dropSecret('privateKeyPass')
    storeSecret('password')
  }

  // try the Snowflake connection
  try {
    await withSnowflakeConnection(catalogConfig, secrets, async (connection) => {
      // an unknown or unauthorized warehouse or database does not make the login fail
      const [row] = await executeQuery(connection, 'SELECT CURRENT_WAREHOUSE() AS "WAREHOUSE", CURRENT_DATABASE() AS "DATABASE"')
      if (!row?.WAREHOUSE) throw new Error(`Warehouse ${catalogConfig.warehouse} does not exist or is not authorized for the current role`)
      if (catalogConfig.database && !row?.DATABASE) throw new Error(`Database ${catalogConfig.database} does not exist or is not authorized for the current role`)
    })
  } catch (error) {
    console.error('Connection test failed:', error)
    throw new Error('Connection test failed: ' + (error as Error).message, { cause: error })
  }

  return {
    catalogConfig,
    secrets
  }
}
