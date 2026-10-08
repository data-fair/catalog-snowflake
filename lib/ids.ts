/**
 * Snowflake identifiers can contain almost any character when quoted, so every
 * identifier we interpolate in SQL must be wrapped in double quotes with the
 * embedded double quotes doubled.
 */
export const quoteIdentifier = (name: string) => `"${name.replace(/"/g, '""')}"`

/** Split a folder id (e.g. "DB/SCHEMA") into its non empty segments. */
export const folderSegments = (currentFolderId?: string): string[] =>
  (currentFolderId ?? '').replace(/^\.\//, '').split('/').filter(Boolean)

/** Split a resource id (e.g. "DB/SCHEMA/TABLE") into its three identifiers. */
export const resourceParts = (resourceId: string): [string, string, string] => {
  const parts = folderSegments(resourceId)
  if (parts.length !== 3) throw new Error(`Invalid Snowflake resource id: ${resourceId}`)
  return parts as [string, string, string]
}
