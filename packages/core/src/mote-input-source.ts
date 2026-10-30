import { AgentMuxError } from './errors.js'

/** A client-selected original workface. This is a locator, never an observer or authority. */
export type AgentInputMoteSource = {
  spaceId: string
  zoneId: string
  tabId: string
  regionId: string
}

export function parseAgentInputMoteSource(value: unknown): AgentInputMoteSource {
  const fields = ['spaceId', 'zoneId', 'tabId', 'regionId'] as const
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key as (typeof fields)[number])) ||
    fields.some(
      (key) =>
        typeof (value as Record<string, unknown>)[key] !== 'string' ||
        !(value as Record<string, string>)[key]!.trim() ||
        /[\0\r\n]/u.test((value as Record<string, string>)[key]!)
    )
  )
    throw new AgentMuxError('The original Mote input source is invalid.', 'INVALID_CONTROL_REQUEST')
  return Object.fromEntries(fields.map((key) => [key, (value as AgentInputMoteSource)[key]])) as AgentInputMoteSource
}

/** Discovery on an original human Mote prompt, frozen with that input; never role or permission authority. */
export const MOTE_INPUT_GUIDANCE = 'Mote collaboration: identity consistency and task consistency are base operating principles. Use the current Mote guide (amux mote --skill; reuse it if already read) for environment understanding and continuity across main-Agent handover, tasks/threads, context changes and actually arranged heartbeats. Preserve goals, constraints, confirmed decisions, unfinished commitments and original input/permission, evidence and handoff sources. Inspect the original MOTE.md binding and your whoami identity to distinguish the current main Agent from a member. This workface source does not assign a role, grant permission, prove an online Agent or arrange a heartbeat. Preserve the original human request and existing work.'
