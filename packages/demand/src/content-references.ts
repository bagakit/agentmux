/** Original content resources, independent of display occurrences and executing Sessions. */
export type DemandContentReference = { hostId: string; workspaceId: string; zoneId: string }

export function contentReferenceKey(reference: DemandContentReference): string {
  return JSON.stringify([reference.hostId, reference.workspaceId, reference.zoneId])
}

export function parseDemandContentReferences(value: unknown): DemandContentReference[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('Goal content references must be an array of at most 64 exact resources.')
  const keys = new Set<string>()
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 3) throw new Error('Goal content reference requires hostId, workspaceId and zoneId only.')
    const fields = item as Record<string, unknown>
    for (const field of ['hostId', 'workspaceId', 'zoneId']) {
      const text = fields[field]
      if (typeof text !== 'string' || !text.trim() || /[\0\r\n]/u.test(text) || new TextEncoder().encode(text).length > 4096) throw new Error(`Goal content reference ${field} is invalid.`)
    }
    const reference = { hostId: fields.hostId as string, workspaceId: fields.workspaceId as string, zoneId: fields.zoneId as string }
    const key = contentReferenceKey(reference)
    if (keys.has(key)) throw new Error('Goal content references contain a duplicate resource.')
    keys.add(key); return reference
  })
}

/** Recorded provenance is appended atomically; a stale caller cannot remove another source. */
export function appendDemandContentReferences(original: readonly DemandContentReference[], additions: readonly DemandContentReference[]): DemandContentReference[] {
  const merged = new Map(original.map(reference => [contentReferenceKey(reference), reference]))
  for (const reference of parseDemandContentReferences(additions)) merged.set(contentReferenceKey(reference), reference)
  return parseDemandContentReferences([...merged.values()])
}
