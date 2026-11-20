import { composeAgentPrompt } from './agent-outbound-message.js'
import { AgentMuxError } from './errors.js'
import { agentSourceContextNote, type AgentTakeoverContextSource } from './agent-takeover-context.js'

/**
 * A derived action starts a new Session from one exact original Session and keeps the original.
 * `new-agent` asks any chosen Agent to read the original context; `fork` continues the Provider's
 * own conversation. Pass on experience is a fixed review flow with its own owner.
 */
export type AgentDerivedActionBase = 'new-agent' | 'fork'
export const AGENT_BUILT_IN_DERIVED_ACTIONS = [
  { id: 'take-over', label: 'Take over', base: 'new-agent', description: 'A new Agent you choose reads the original work and continues it.' },
  { id: 'fork', label: 'Fork current conversation', base: 'fork', description: 'The same Provider continues a copy of the current conversation.' },
  { id: 'pass-on-experience', label: 'Pass on experience', base: 'learning', description: 'Review what this work taught, then hand it to a Mote or Topic.' }
] as const
export type AgentBuiltInDerivedActionId = typeof AGENT_BUILT_IN_DERIVED_ACTIONS[number]['id']

/** A user-authored action. Its instruction belongs to the action, not to the composer Prompt library. */
export type AgentDerivedAction = { id: string; label: string; base: AgentDerivedActionBase; instruction: string; executorId?: string }
/** Saved preferences. Built-ins are never copied into the user list; hiding is not deleting. */
export type AgentDerivedActionsConfig = { actions?: AgentDerivedAction[]; hidden?: AgentBuiltInDerivedActionId[] }

export const AGENT_DERIVED_ACTION_LIMITS = { actions: 32, label: 80, instruction: 8000 } as const
const BUILT_IN_IDS = new Set<string>(AGENT_BUILT_IN_DERIVED_ACTIONS.map(action => action.id))
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isAgentBuiltInDerivedActionId(value: unknown): value is AgentBuiltInDerivedActionId {
  return typeof value === 'string' && BUILT_IN_IDS.has(value)
}

function invalid(message: string): never { throw new AgentMuxError(message, 'INVALID_DERIVED_ACTION') }

/** Fields of one user action, without its identity. Shared by Desktop persistence, the resource owner and the CLI. */
export function parseAgentDerivedActionFields(value: unknown): Omit<AgentDerivedAction, 'id'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('A derived action needs label, base and instruction.')
  const fields = value as Record<string, unknown>
  if (Object.keys(fields).some(key => !['label', 'base', 'instruction', 'executorId'].includes(key))) invalid('A derived action accepts only label, base, instruction and executorId.')
  const label = typeof fields.label === 'string' ? fields.label.trim() : ''
  if (!label || label.length > AGENT_DERIVED_ACTION_LIMITS.label || /[\0\r\n]/u.test(label)) invalid(`A derived action needs a one-line name of up to ${AGENT_DERIVED_ACTION_LIMITS.label} characters.`)
  if (fields.base !== 'new-agent' && fields.base !== 'fork') invalid('A derived action base is new-agent or fork.')
  const instruction = typeof fields.instruction === 'string' ? fields.instruction : ''
  if (!instruction.trim() || instruction.length > AGENT_DERIVED_ACTION_LIMITS.instruction || instruction.includes('\0')) invalid(`A derived action needs an instruction of up to ${AGENT_DERIVED_ACTION_LIMITS.instruction} characters.`)
  if (Object.hasOwn(fields, 'executorId')) {
    if (fields.base === 'fork') invalid('A fork continues the same Provider; it has no Agent choice.')
    if (typeof fields.executorId !== 'string' || !fields.executorId || fields.executorId.length > 256 || /[\0\r\n]/u.test(fields.executorId)) invalid('The default Agent must be an exact configured Executor ID.')
  }
  return { label, base: fields.base, instruction, ...(typeof fields.executorId === 'string' ? { executorId: fields.executorId } : {}) }
}

export function parseAgentDerivedActionId(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) invalid('A derived action ID uses up to 64 lowercase letters, digits or hyphens.')
  if (BUILT_IN_IDS.has(value)) throw new AgentMuxError(`“${value}” is an official derived action and is read-only.`, 'SETTING_IDENTITY_IMMUTABLE')
  return value
}

export function parseAgentDerivedActionsConfig(value: unknown): AgentDerivedActionsConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Derived actions settings are invalid.')
  const config = value as Record<string, unknown>
  if (Object.keys(config).some(key => key !== 'actions' && key !== 'hidden')) invalid('Derived actions settings accept only actions and hidden.')
  const result: AgentDerivedActionsConfig = {}
  if (Object.hasOwn(config, 'actions')) {
    if (!Array.isArray(config.actions) || config.actions.length > AGENT_DERIVED_ACTION_LIMITS.actions) invalid(`Keep up to ${AGENT_DERIVED_ACTION_LIMITS.actions} derived actions.`)
    const seen = new Set<string>()
    result.actions = config.actions.map(entry => {
      const record = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : invalid('A derived action is invalid.')
      const { id: rawId, ...fields } = record
      const id = parseAgentDerivedActionId(rawId)
      if (seen.has(id)) invalid(`Derived action “${id}” appears twice.`)
      seen.add(id)
      return { id, ...parseAgentDerivedActionFields(fields) }
    })
  }
  if (Object.hasOwn(config, 'hidden')) {
    if (!Array.isArray(config.hidden) || config.hidden.some(id => !isAgentBuiltInDerivedActionId(id)) || new Set(config.hidden).size !== config.hidden.length) invalid('Only official derived actions can be hidden, each once.')
    result.hidden = config.hidden as AgentBuiltInDerivedActionId[]
  }
  return result
}

export type AgentResolvedDerivedAction =
  | { kind: 'built-in'; id: AgentBuiltInDerivedActionId; label: string; description: string }
  | { kind: 'custom'; action: AgentDerivedAction }

/** Menus, Settings and the CLI read this one order: visible official actions, then the user's own. */
export function resolveAgentDerivedActions(config: AgentDerivedActionsConfig | undefined): AgentResolvedDerivedAction[] {
  const hidden = new Set<string>(config?.hidden ?? [])
  return [
    ...AGENT_BUILT_IN_DERIVED_ACTIONS.filter(action => !hidden.has(action.id)).map(action => ({ kind: 'built-in' as const, id: action.id, label: action.label, description: action.description })),
    ...(config?.actions ?? []).map(action => ({ kind: 'custom' as const, action }))
  ]
}

export function composeAgentDerivedAction(action: Pick<AgentDerivedAction, 'instruction'>, source: AgentTakeoverContextSource): string {
  return composeAgentPrompt(action.instruction, agentSourceContextNote(source, 'local')).text
}
