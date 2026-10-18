/** An author's original reference, or a snapshot of the original Files resource. */
export type DemandEvidence = string | DemandFileEvidence
export type DemandFileEvidence = {
  kind: 'file'
  /** Fields returned by the Files owner; this record does not own their identities. */
  resource: {
    hostId: string; workspaceId: string; workspacePath: string
    zoneId: string; zonePath: string; path: string; logicalDirectory?: string
  }
  /** The reported Files revision, not a claim that the evidence has been verified. */
  revision: string | null
  location?: { line: number; column?: number }
}

function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Evidence must be original text or a file resource.')
  const data = value as Record<string, unknown>
  if (required.some(key => !Object.hasOwn(data, key)) || Object.keys(data).some(key => !required.includes(key) && !optional.includes(key)))
    throw new Error('File evidence has unsupported or missing fields.')
  return data
}
function identity(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) throw new Error('File evidence requires its exact original resource.')
  return value
}
function relativePath(value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value) || /[\0\r\n\\]/u.test(value) || value.startsWith('/') || /^[A-Za-z]:/u.test(value) ||
      value !== '' && value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('File evidence requires a confined resource-relative path.')
  return value
}

export function parseDemandEvidence(value: unknown): DemandEvidence {
  if (typeof value === 'string') {
    if (!value.trim()) throw new Error('Evidence text must be nonempty.')
    return value
  }
  const data = object(value, ['kind', 'resource', 'revision'], ['location'])
  if (data.kind !== 'file') throw new Error('Choose an original file evidence resource.')
  const source = object(data.resource, ['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path'], ['logicalDirectory'])
  const resource: DemandFileEvidence['resource'] = {
    hostId: identity(source.hostId), workspaceId: identity(source.workspaceId), workspacePath: identity(source.workspacePath),
    zoneId: identity(source.zoneId), zonePath: identity(source.zonePath), path: relativePath(source.path),
    ...(source.logicalDirectory === undefined ? {} : { logicalDirectory: relativePath(source.logicalDirectory, true) })
  }
  if (!resource.workspacePath.startsWith('/') || !resource.zonePath.startsWith('/')) throw new Error('File evidence requires original absolute resource roots.')
  const root = resource.workspacePath.replace(/\/+$/u, '') || '/', zone = resource.zonePath.replace(/\/+$/u, '') || '/'
  const prefix = root === '/' ? '/' : root + '/'
  if (resource.logicalDirectory === undefined && zone !== root && !zone.startsWith(prefix)) throw new Error('File evidence Zone is outside its original Workspace.')
  const directory = resource.logicalDirectory ?? (zone === root ? '' : zone.slice(prefix.length))
  if (directory && !resource.path.startsWith(directory + '/')) throw new Error('File evidence path does not belong to its recorded Zone.')
  if (data.revision !== null && (typeof data.revision !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(data.revision))) throw new Error('File evidence requires the complete original revision or null.')
  let location: DemandFileEvidence['location']
  if (data.location !== undefined) {
    const position = object(data.location, ['line'], ['column'])
    if (!Number.isSafeInteger(position.line) || Number(position.line) < 1 || position.column !== undefined && (!Number.isSafeInteger(position.column) || Number(position.column) < 1))
      throw new Error('File evidence line and column must be positive integers.')
    location = { line: Number(position.line), ...(position.column === undefined ? {} : { column: Number(position.column) }) }
  }
  return { kind: 'file', resource, revision: data.revision as string | null, ...(location ? { location } : {}) }
}

/** Copy preserves the entire original address; it never invents a local file URI. */
export function demandEvidenceText(evidence: DemandEvidence): string {
  return typeof evidence === 'string' ? evidence : JSON.stringify(evidence)
}
export function demandEvidenceLabel(evidence: DemandEvidence): string {
  if (typeof evidence === 'string') return evidence
  return evidence.resource.path + (evidence.location ? `:${evidence.location.line}${evidence.location.column ? `:${evidence.location.column}` : ''}` : '')
}
