import type { ConnectionHostingTarget } from './contracts.js'

/** A retained hosting route is independent of the Agent's execution route. */
export function readConnectionHostingTarget(value: unknown): ConnectionHostingTarget | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => key !== 'hostId' && key !== 'runtimeId') ||
    [row.hostId, row.runtimeId].some(id => typeof id !== 'string' || !id.trim() || /[\0\r\n]/u.test(id))) return
  return { hostId: row.hostId as string, runtimeId: row.runtimeId as string }
}
