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
