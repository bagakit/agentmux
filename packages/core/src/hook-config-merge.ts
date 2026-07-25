import { isMap, isSeq, parseDocument, YAMLMap, YAMLSeq } from 'yaml'
import { AgentMuxError } from './errors.js'

/**
 * How a managed Hook mutation is combined with the file already on disk.
 *
 * A provider's Hook config is frequently *shared* — antigravity writes into the same
 * `~/.gemini/config/hooks.json` the real Gemini CLI reads, a workspace `.codex/hooks.json`
 * may hold project-committed Codex hooks, and hermes' `~/.hermes/config.yaml` carries the user's
 * model, credentials, and their own shell hooks. Overwriting such a file wholesale destroys every
 * foreign entry (for YAML, every comment too). A merge strategy lets the installer inject only
 * AgentMux-owned content while preserving everything else, so install/uninstall are non-destructive
 * on shared files.
 */
export type AgentHookMergeStrategy =
  | AgentHookOwnedKeyMerge
  | AgentHookManagedEventsMerge
  | AgentHookYamlManagedEventsMerge
  | AgentHookManagedApprovalsMerge

/**
 * AgentMux owns exactly one top-level key of a JSON object (e.g. antigravity's `agentmux-status`
 * bundle under the shared Gemini hooks root). Install replaces that one key and preserves every
 * sibling key; a reinstall overwrites the same key, so it never accumulates duplicates.
 */
export type AgentHookOwnedKeyMerge = {
  kind: 'json-owned-key'
  key: string
}

/**
 * AgentMux owns command entries that must live *inside* a shared schema whose only recognised
 * top-level field is `hooks` (Codex rejects unknown top-level fields). Install sweeps AgentMux
 * entries — matched by the stable `marker` substring in their command — out of every event bucket,
 * then appends the fresh entries, preserving foreign buckets and foreign entries within our buckets.
 * Non-`hooks` top-level keys carried by the owned content (e.g. `description`) are also applied,
 * while foreign top-level keys are preserved.
 */
export type AgentHookManagedEventsMerge = {
  kind: 'json-managed-events'
  marker: string
}

/**
 * The YAML analogue of `json-managed-events`, for hermes' `~/.hermes/config.yaml`. That file holds
 * the user's model, credentials, and their own `hooks:` — and comments they wrote — so the merge is
 * comment-preserving: it edits the parsed YAML document in place rather than re-emitting it. AgentMux
 * owns command entries under `hooks.<event>`, matched by the `marker` substring in their `command`;
 * install sweeps our entries out of every bucket, drops any bucket left empty, then appends the fresh
 * entries after any foreign entries. Foreign keys, foreign hooks, and comments survive untouched.
 */
export type AgentHookYamlManagedEventsMerge = {
  kind: 'yaml-managed-events'
  marker: string
}

/**
 * AgentMux owns `approvals` array entries in hermes' `~/.hermes/shell-hooks-allowlist.json`, matched
 * by the `marker` substring in their `command`. hermes gates a shell hook on an exact `(event, command)`
 * approval, so the installer must add ours without a TTY prompt. Install sweeps our stale approvals and
 * appends the fresh ones, preserving every foreign approval verbatim (its `approved_at` timestamp and
 * all). Our entries carry only `{event, command}` — hermes never reads more at runtime — which keeps
 * the merge pure so the installer's unchanged-hash guard still works.
 */
export type AgentHookManagedApprovalsMerge = {
  kind: 'json-managed-approvals'
  marker: string
}

type JsonObject = Record<string, unknown>

const SERIALIZE = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/**
 * Parse a Hook config file that AgentMux is about to merge into.
 *
 * `null` (absent) and blank files are an empty object — there is nothing to lose. A file with
 * real but unparseable content is a hard error: silently treating it as `{}` would clobber a
 * user's hand-edited config, which is exactly the data loss the merge exists to prevent.
 */
function parseCurrentObject(current: string | null): JsonObject {
  if (current === null || current.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(current)
  } catch {
    throw new AgentMuxError('Managed Hook target is not valid JSON; refusing to overwrite it.', 'HOOK_TARGET_UNPARSEABLE')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AgentMuxError('Managed Hook target is not a JSON object; refusing to overwrite it.', 'HOOK_TARGET_UNPARSEABLE')
  }
  return parsed as JsonObject
}

function parseOwnedObject(content: string): JsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new AgentMuxError('Managed Hook owned content is not valid JSON.', 'INVALID_HOOK_PLAN')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AgentMuxError('Managed Hook owned content must be a JSON object.', 'INVALID_HOOK_PLAN')
  }
  return parsed as JsonObject
}

/** True when a single hook definition carries an AgentMux-managed command (flat or nested). */
function definitionOwnsMarker(definition: unknown, marker: string): boolean {
  if (typeof definition !== 'object' || definition === null) return false
  const record = definition as JsonObject
  if (typeof record.command === 'string' && record.command.includes(marker)) return true
  if (Array.isArray(record.hooks)) {
    return record.hooks.some((hook) =>
      typeof hook === 'object' && hook !== null &&
      typeof (hook as JsonObject).command === 'string' &&
      ((hook as JsonObject).command as string).includes(marker)
    )
  }
  return false
}

/** Drop AgentMux-managed definitions from one event bucket, keeping foreign definitions in order. */
function sweepManagedDefinitions(definitions: unknown, marker: string): unknown[] {
  if (!Array.isArray(definitions)) return []
  return definitions.filter((definition) => !definitionOwnsMarker(definition, marker))
}

function applyOwnedKey(current: string | null, owned: JsonObject, key: string): string {
  if (!(key in owned)) {
    throw new AgentMuxError(`Managed Hook owned content is missing its owned key "${key}".`, 'INVALID_HOOK_PLAN')
  }
  return SERIALIZE({ ...parseCurrentObject(current), [key]: owned[key] })
}

function applyManagedEvents(current: string | null, owned: JsonObject, marker: string): string {
  const result = parseCurrentObject(current)
  // AgentMux owns non-`hooks` labels it declares (e.g. `description`); foreign top-level keys survive.
  for (const [label, value] of Object.entries(owned)) {
    if (label !== 'hooks') result[label] = value
  }
  const currentHooks = typeof result.hooks === 'object' && result.hooks !== null && !Array.isArray(result.hooks)
    ? (result.hooks as JsonObject)
    : {}
  const ownedHooks = typeof owned.hooks === 'object' && owned.hooks !== null && !Array.isArray(owned.hooks)
    ? (owned.hooks as JsonObject)
    : {}
  const nextHooks: JsonObject = {}
  // Sweep our marker out of every existing bucket first so relaunches never accumulate duplicates
  // and a bucket we no longer own stops firing our command; foreign-only buckets are preserved.
  for (const [event, definitions] of Object.entries(currentHooks)) {
    const foreign = sweepManagedDefinitions(definitions, marker)
    if (foreign.length > 0) nextHooks[event] = foreign
  }
  // Inject the fresh managed entries after any foreign entries that share the bucket.
  for (const [event, ourDefinitions] of Object.entries(ownedHooks)) {
    const foreign = nextHooks[event]
    const preserved = Array.isArray(foreign) ? foreign : []
    nextHooks[event] = [...preserved, ...(Array.isArray(ourDefinitions) ? ourDefinitions : [])]
  }
  result.hooks = nextHooks
  return SERIALIZE(result)
}

/** True when a YAML hook definition node carries an AgentMux-managed command. */
function yamlDefinitionOwnsMarker(node: unknown, marker: string): boolean {
  if (!isMap(node)) return false
  const command = node.get('command')
  return typeof command === 'string' && command.includes(marker)
}

/**
 * Merge AgentMux command entries into a YAML `hooks:` block while preserving comments, foreign keys,
 * foreign hooks, and formatting. Edits the parsed document in place — never re-serialises from a plain
 * object — so the user's credentials-bearing `~/.hermes/config.yaml` round-trips faithfully. Pure and
 * deterministic on identical input, as the installer's unchanged-hash guard requires.
 */
function applyYamlManagedEvents(current: string | null, owned: JsonObject, marker: string): string {
  const doc = current === null || current.trim() === ''
    ? parseDocument('{}')
    : parseDocument(current)
  if (doc.errors.length > 0) {
    throw new AgentMuxError('Managed Hook target is not valid YAML; refusing to overwrite it.', 'HOOK_TARGET_UNPARSEABLE')
  }
  const root = doc.contents
  if (!isMap(root)) {
    throw new AgentMuxError('Managed Hook target is not a YAML mapping; refusing to overwrite it.', 'HOOK_TARGET_UNPARSEABLE')
  }
  // Use the Document-level get/set/delete for the root `hooks` key: they take a plain string key,
  // whereas the parsed root map's own set() demands a ParsedNode key. The isMap(root) guard above has
  // already rejected a non-mapping document, so these operate on the mapping we verified.
  const existingHooks = doc.get('hooks', true)
  let hooks: YAMLMap
  if (isMap(existingHooks)) {
    hooks = existingHooks
  } else {
    hooks = new YAMLMap()
    doc.set('hooks', hooks)
  }
  // Sweep our marker out of every existing bucket first so relaunches never accumulate duplicates and
  // a bucket we no longer own stops firing our command; foreign entries and foreign-only buckets survive.
  for (const pair of [...hooks.items]) {
    const bucket = pair.value
    if (isSeq(bucket)) {
      bucket.items = bucket.items.filter((node) => !yamlDefinitionOwnsMarker(node, marker))
      if (bucket.items.length === 0) hooks.delete(pair.key)
    }
  }
  // Inject the fresh managed entries after any foreign entries that share the bucket.
  const ownedHooks = typeof owned.hooks === 'object' && owned.hooks !== null && !Array.isArray(owned.hooks)
    ? (owned.hooks as JsonObject)
    : {}
  for (const [event, definitions] of Object.entries(ownedHooks)) {
    const existingBucket = hooks.get(event, true)
    let bucket: YAMLSeq
    if (isSeq(existingBucket)) {
      bucket = existingBucket
    } else {
      bucket = new YAMLSeq()
      hooks.set(event, bucket)
    }
    for (const definition of (Array.isArray(definitions) ? definitions : [])) {
      const entry = new YAMLMap()
      for (const [key, value] of Object.entries(definition as JsonObject)) entry.set(key, value)
      bucket.add(entry)
    }
  }
  // Leave the file free of an empty `hooks:` stub if we neither found nor added anything.
  if (hooks.items.length === 0) doc.delete('hooks')
  // lineWidth: 0 disables line-folding so a long command stays on one physical line — hermes gates on
  // an exact command-string match, and a folded scalar would still round-trip but is needlessly fragile.
  return doc.toString({ lineWidth: 0 })
}

function applyManagedApprovals(current: string | null, owned: JsonObject, marker: string): string {
  const result = parseCurrentObject(current)
  const currentApprovals = Array.isArray(result.approvals) ? result.approvals : []
  // Keep every foreign approval verbatim (timestamps and all); drop our own stale entries so a fresh
  // install neither duplicates nor leaves a moved-execPath approval behind.
  const foreign = currentApprovals.filter((entry) =>
    !(typeof entry === 'object' && entry !== null &&
      typeof (entry as JsonObject).command === 'string' &&
      ((entry as JsonObject).command as string).includes(marker)))
  const ours = Array.isArray(owned.approvals) ? owned.approvals : []
  result.approvals = [...foreign, ...ours]
  return SERIALIZE(result)
}

/**
 * Compute the next file content for a managed Hook mutation. Pure and deterministic: the installer
 * calls it during preview (to hash the result) and again during install, relying on identical output
 * for identical current content so its unchanged-hash guard still detects concurrent edits.
 */
export function renderMergedHookContent(
  current: string | null,
  ownedContent: string,
  strategy: AgentHookMergeStrategy
): string {
  const owned = parseOwnedObject(ownedContent)
  switch (strategy.kind) {
    case 'json-owned-key':
      return applyOwnedKey(current, owned, strategy.key)
    case 'json-managed-events':
      return applyManagedEvents(current, owned, strategy.marker)
    case 'yaml-managed-events':
      return applyYamlManagedEvents(current, owned, strategy.marker)
    case 'json-managed-approvals':
      return applyManagedApprovals(current, owned, strategy.marker)
  }
}
