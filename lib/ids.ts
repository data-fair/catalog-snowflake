/**
 * Snowflake identifiers can contain almost any character when quoted, so every
 * identifier we interpolate in SQL must be wrapped in double quotes with the
 * embedded double quotes doubled.
 */
export const quoteIdentifier = (name: string) => `"${name.replace(/"/g, '""')}"`

/**
 * Ids join the identifiers with "/". Only "%" and "/" are escaped inside a segment,
 * so the ids of identifiers without these characters stay unchanged.
 */
export const encodeSegment = (name: string) => name.replace(/[%/]/g, c => c === '%' ? '%25' : '%2F')
const decodeSegment = (segment: string) => segment.replace(/%(25|2F)/gi, m => m === '%25' ? '%' : '/')

/** Build a folder or resource id (e.g. "DB/SCHEMA/TABLE") from its identifiers. */
export const buildId = (...names: string[]) => names.map(encodeSegment).join('/')

/** Split a folder id (e.g. "DB/SCHEMA") into its non empty identifiers. */
export const folderSegments = (currentFolderId?: string): string[] =>
  (currentFolderId ?? '').split('/').filter(Boolean).map(decodeSegment)

/** Split a resource id (e.g. "DB/SCHEMA/TABLE") into its three identifiers. */
export const resourceParts = (resourceId: string): [string, string, string] => {
  const parts = folderSegments(resourceId)
  if (parts.length !== 3) throw new Error(`Invalid Snowflake resource id: ${resourceId}`)
  return parts as [string, string, string]
}
