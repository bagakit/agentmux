import { AgentMuxError } from './errors.js'

/**
 * How a managed Hook mutation is combined with the file already on disk.
 *
 * A provider's Hook config is frequently *shared* — antigravity writes into the same
 * `~/.gemini/config/hooks.json` the real Gemini CLI reads, and a workspace `.codex/hooks.json`
 * may hold project-committed Codex hooks. Overwriting such a file wholesale destroys every
 * foreign entry. A merge strategy lets the installer inject only AgentMux-owned content while
 * preserving everything else, so install/uninstall are non-destructive on shared files.
 */
export type AgentHookMergeStrategy =
  | AgentHookOwnedKeyMerge
  | AgentHookManagedEventsMerge

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
  }
}
