import type { Capability } from '@data-fair/types-catalogs'

/**
 * The list of capabilities of the plugin.
 * 'import' lets the plugin list resources organized in folders and import them.
 * 'search' lets the plugin filter the list results with the search param 'q'.
 */
export const capabilities = [
  'import',
  'search'
] satisfies Capability[]

export type SnowflakeCapabilities = typeof capabilities
export default capabilities
