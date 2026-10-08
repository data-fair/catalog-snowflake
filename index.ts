import type CatalogPlugin from '@data-fair/types-catalogs'
import { type SnowflakeConfig, configSchema, assertConfigValid } from '#types'
import { type SnowflakeCapabilities, capabilities } from './lib/capabilities.ts'

// Since the plugin is very frequently imported, each function is imported on demand,
// instead of loading the entire plugin.
// This file should not contain any code, but only constants and dynamic imports of functions.

const plugin: CatalogPlugin<SnowflakeConfig, SnowflakeCapabilities> = {
  async prepare (context) {
    const prepare = (await import('./lib/prepare.ts')).default
    return prepare(context)
  },

  async list (context) {
    const { list } = await import('./lib/imports.ts')
    return list(context)
  },

  async getResource (context) {
    const { getResource } = await import('./lib/download.ts')
    return getResource(context)
  },

  metadata: {
    title: 'Snowflake',
    capabilities
  },
  configSchema,
  assertConfigValid
}
export default plugin
