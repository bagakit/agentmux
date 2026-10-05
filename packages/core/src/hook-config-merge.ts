import { isDeepStrictEqual } from 'node:util'
import { isAlias, isMap, isSeq, parseDocument, visit, YAMLMap, YAMLSeq } from 'yaml'
import { AgentMuxError } from './errors.js'

/** The Provider declares current native entries; shared entries are never swept. */
export type AgentHookMergeStrategy =
  | AgentHookOwnedKeyMerge
  | AgentHookManagedEventsMerge
  | AgentHookRootManagedEventsMerge
  | AgentHookYamlManagedEventsMerge
  | AgentHookManagedApprovalsMerge

/** An explicitly exclusive native key. Every sibling remains outside AgentMux's ownership. */
export type AgentHookOwnedKeyMerge = { kind: 'json-owned-key'; key: string }
/** Append missing current declarations under hooks.<event>, preserving every existing entry. */
export type AgentHookManagedEventsMerge = { kind: 'json-managed-events' }
/** The same declaration rule where native event buckets live at the root. */
export type AgentHookRootManagedEventsMerge = { kind: 'json-root-managed-events' }
/** Edit the existing YAML document, preserving foreign nodes and comments. */
export type AgentHookYamlManagedEventsMerge = { kind: 'yaml-managed-events' }
/** Native approvals identify a declaration by the exact (event, command) pair. */
export type AgentHookManagedApprovalsMerge = { kind: 'json-managed-approvals' }

type JsonObject = Record<string, unknown>
const SERIALIZE = (value: unknown): string => JSON.stringify(value, null, 2) + '\n'

function object(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function targetShape(message: string): never {
  throw new AgentMuxError(message, 'HOOK_TARGET_UNPARSEABLE')
}
function invalidPlan(message: string): never {
  throw new AgentMuxError(message, 'INVALID_HOOK_PLAN')
}
function parseCurrentObject(current: string | null): JsonObject {
  if (current === null || current.trim() === '') return {}
  let parsed: unknown
  try { parsed = JSON.parse(current) }
  catch { return targetShape('Managed Hook target is not valid JSON; refusing to overwrite it.') }
  if (!object(parsed)) return targetShape('Managed Hook target is not a JSON object; refusing to overwrite it.')
  return parsed
}
function parseOwnedObject(content: string): JsonObject {
  let parsed: unknown
  try { parsed = JSON.parse(content) }
  catch { return invalidPlan('Managed Hook owned content is not valid JSON.') }
  if (!object(parsed)) return invalidPlan('Managed Hook owned content must be a JSON object.')
  return parsed
}
function commandEntry(value: unknown): boolean {
  return object(value) && typeof value.command === 'string' && value.command.trim().length > 0
}
function declarations(value: unknown): Record<string, JsonObject[]> {
  if (!object(value) || Object.keys(value).length === 0) return invalidPlan('Managed Hook plan declares no event entries.')
  const entries: Record<string, JsonObject[]> = Object.create(null)
  for (const [event, definitions] of Object.entries(value)) {
    if (!event || !Array.isArray(definitions) || definitions.length === 0) return invalidPlan('Managed Hook event declarations must be nonempty arrays.')
    for (const definition of definitions) {
      if (!object(definition) || !(commandEntry(definition) ||
          (Array.isArray(definition.hooks) && definition.hooks.length > 0 && definition.hooks.every(commandEntry)))) {
        return invalidPlan('Managed Hook declaration must contain complete native command entries.')
      }
    }
    entries[event] = definitions as JsonObject[]
  }
  return entries
}

/** A current declaration's presence is not ownership of the containing user entry. */
function containsDeclaration(actual: unknown, expected: JsonObject): boolean {
  if (!object(actual)) return false
  if (!Array.isArray(expected.hooks)) return isDeepStrictEqual(actual, expected)
  const { hooks: expectedHooks, ...expectedScope } = expected
  const { hooks: actualHooks, ...actualScope } = actual
  if (!Array.isArray(actualHooks) || !isDeepStrictEqual(actualScope, expectedScope)) return false
  // Foreign siblings remain untouched. Preserve the declared command order and multiplicity.
  let position = 0
  return (expectedHooks as unknown[]).every(leaf => {
    while (position < actualHooks.length) {
      if (isDeepStrictEqual(actualHooks[position++], leaf)) return true
    }
    return false
  })
}
function currentHooks(current: JsonObject): JsonObject {
  if (!Object.hasOwn(current, 'hooks')) return {}
  if (!object(current.hooks)) return targetShape('Managed Hook target hooks must be a JSON object; retaining the target.')
  return current.hooks
}
function currentBucket(current: JsonObject, event: string): unknown[] {
  if (!Object.hasOwn(current, event)) return []
  if (!Array.isArray(current[event])) return targetShape('Managed Hook target event must be an array; retaining the target.')
  return current[event]
}
function mergeEventBuckets(current: JsonObject, owned: Record<string, JsonObject[]>): { value: JsonObject; changed: boolean } {
  let value = { ...current }
  let changed = false
  for (const [event, definitions] of Object.entries(owned)) {
    const bucket = currentBucket(current, event)
    const missing = definitions.filter(definition => !bucket.some(entry => containsDeclaration(entry, definition)))
    if (missing.length) { value = { ...value, [event]: [...bucket, ...missing] }; changed = true }
  }
  return { value, changed }
}
function inspectEvents(current: JsonObject, owned: Record<string, JsonObject[]>): { present: boolean; current: boolean } {
  let count = 0, satisfied = 0
  for (const [event, definitions] of Object.entries(owned)) {
    const bucket = currentBucket(current, event)
    for (const definition of definitions) {
      ++count
      if (bucket.some(entry => containsDeclaration(entry, definition))) ++satisfied
    }
  }
  return { present: satisfied > 0, current: satisfied === count }
}
function applyOwnedKey(current: string | null, owned: JsonObject, key: string): string {
  if (!Object.hasOwn(owned, key)) return invalidPlan('Managed Hook owned content is missing its owned key.')
  return SERIALIZE({ ...parseCurrentObject(current), [key]: owned[key] })
}
function applyManagedEvents(current: string | null, owned: JsonObject, root = false): string {
  const parsed = parseCurrentObject(current)
  const expected = declarations(root ? owned : owned.hooks)
  const merged = mergeEventBuckets(root ? parsed : currentHooks(parsed), expected)
  if (!merged.changed && current !== null) return current
  if (root) return SERIALIZE(merged.value)
  let result: JsonObject = { ...parsed, hooks: merged.value }
  // A fragment does not grant ownership of an existing user's metadata key.
  for (const [key, value] of Object.entries(owned)) {
    if (key !== 'hooks' && !Object.hasOwn(result, key)) result = { ...result, [key]: value }
  }
  return SERIALIZE(result)
}

function yamlDocument(current: string | null) {
  const doc = parseDocument(current === null || current.trim() === '' ? '{}' : current)
  if (doc.errors.length || !isMap(doc.contents)) return targetShape('Managed Hook target must be a valid YAML mapping; retaining the target.')
  return doc
}
function yamlHooks(doc: ReturnType<typeof yamlDocument>): YAMLMap | undefined {
  const hooks = doc.get('hooks', true)
  if (hooks === undefined) return undefined
  if (!isMap(hooks)) return targetShape('Managed Hook target hooks must be a YAML mapping; retaining the target.')
  return hooks
}
function yamlBucket(hooks: YAMLMap | undefined, event: string): YAMLSeq | undefined {
  const bucket = hooks?.get(event, true)
  if (bucket === undefined) return undefined
  if (!isSeq(bucket)) return targetShape('Managed Hook target event must be a YAML sequence; retaining the target.')
  return bucket
}
function yamlEntry(node: unknown): unknown {
  // Unknown aliases/tags are preserved, never interpreted as a declaration or deleted.
  if (!isMap(node)) return undefined
  let opaque = false
  visit(node, { Node: (_key, value) => {
    if (isAlias(value) || value.tag !== undefined) opaque = true
  } })
  if (opaque) return undefined
  try { return node.toJSON() } catch { return undefined }
}
function applyYamlManagedEvents(current: string | null, owned: JsonObject): string {
  const expected = declarations(owned.hooks), doc = yamlDocument(current)
  let hooks = yamlHooks(doc), changed = false
  for (const [event, definitions] of Object.entries(expected)) {
    let bucket = yamlBucket(hooks, event)
    const existing = bucket?.items.map(yamlEntry) ?? []
    const missing = definitions.filter(definition => !existing.some(entry => containsDeclaration(entry, definition)))
    if (!missing.length) continue
    if (!hooks) { hooks = new YAMLMap(); doc.set('hooks', hooks) }
    if (!bucket) { bucket = new YAMLSeq(); hooks.set(event, bucket) }
    for (const definition of missing) bucket.add(doc.createNode(definition))
    changed = true
  }
  if (!changed && current !== null) return current
  return doc.toString({ lineWidth: 0 })
}
function approvalDeclarations(owned: JsonObject): JsonObject[] {
  if (!Array.isArray(owned.approvals) || owned.approvals.length === 0 ||
      !owned.approvals.every(entry => object(entry) && commandEntry(entry) && typeof entry.event === 'string' && entry.event.trim().length)) {
    return invalidPlan('Managed Hook plan must declare complete native approval pairs.')
  }
  return owned.approvals as JsonObject[]
}
function currentApprovals(parsed: JsonObject): unknown[] {
  if (!Object.hasOwn(parsed, 'approvals')) return []
  if (!Array.isArray(parsed.approvals)) return targetShape('Managed Hook target approvals must be an array; retaining the target.')
  return parsed.approvals
}
function containsApproval(current: unknown[], expected: JsonObject): boolean {
  return current.some(entry => object(entry) && entry.event === expected.event && entry.command === expected.command)
}
function applyManagedApprovals(current: string | null, owned: JsonObject): string {
  const expected = approvalDeclarations(owned), parsed = parseCurrentObject(current)
  const approvals = currentApprovals(parsed), missing = expected.filter(entry => !containsApproval(approvals, entry))
  if (!missing.length && current !== null) return current
  return SERIALIZE({ ...parsed, approvals: [...approvals, ...missing] })
}

/** Deterministic preparation; unknown shared entries never acquire deletion authority. */
export function renderMergedHookContent(current: string | null, ownedContent: string, strategy: AgentHookMergeStrategy): string {
  const owned = parseOwnedObject(ownedContent)
  switch (strategy.kind) {
    case 'json-owned-key': return applyOwnedKey(current, owned, strategy.key)
    case 'json-managed-events': return applyManagedEvents(current, owned)
    case 'json-root-managed-events': return applyManagedEvents(current, owned, true)
    case 'yaml-managed-events': return applyYamlManagedEvents(current, owned)
    case 'json-managed-approvals': return applyManagedApprovals(current, owned)
  }
}

/** Exact current declarations only; neither historical ownership nor native activation. */
export function inspectManagedHookContent(current: string, ownedContent: string, strategy: AgentHookMergeStrategy): { present: boolean; current: boolean } {
  const owned = parseOwnedObject(ownedContent)
  switch (strategy.kind) {
    case 'json-owned-key': {
      const parsed = parseCurrentObject(current)
      if (!Object.hasOwn(owned, strategy.key)) return invalidPlan('Managed Hook owned key is absent.')
      return { present: Object.hasOwn(parsed, strategy.key), current: isDeepStrictEqual(parsed[strategy.key], owned[strategy.key]) }
    }
    case 'json-managed-events': return inspectEvents(currentHooks(parseCurrentObject(current)), declarations(owned.hooks))
    case 'json-root-managed-events': return inspectEvents(parseCurrentObject(current), declarations(owned))
    case 'yaml-managed-events': {
      const expected = declarations(owned.hooks), hooks = yamlHooks(yamlDocument(current))
      let count = 0, satisfied = 0
      for (const [event, definitions] of Object.entries(expected)) {
        const bucket = yamlBucket(hooks, event)?.items.map(yamlEntry) ?? []
        for (const definition of definitions) { ++count; if (bucket.some(entry => containsDeclaration(entry, definition))) ++satisfied }
      }
      return { present: satisfied > 0, current: satisfied === count }
    }
    case 'json-managed-approvals': {
      const expected = approvalDeclarations(owned), approvals = currentApprovals(parseCurrentObject(current))
      const satisfied = expected.filter(entry => containsApproval(approvals, entry)).length
      return { present: satisfied > 0, current: satisfied === expected.length }
    }
  }
}
