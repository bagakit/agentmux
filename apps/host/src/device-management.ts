import { AgentMuxError, type TrustedDevice } from '@agentmux/core'
import { DeviceAuthority } from './device-authority.js'
import { createMacDeviceConfirmation, type MacDeviceConfirmation, type DeviceConfirmationIntent } from './mac-device-confirmation.js'

/** Supplied by the sole public server, never decoded from caller params. */
export type DeviceManagementContext = {
  caller?: unknown; principal?: { kind: 'user' | 'device'; id: string };
  transport?: 'unix' | 'http' | 'stdio'; signal?: AbortSignal
}
export type DeviceManagementList = {
  hostId: string; devices: readonly TrustedDevice[];
  requests: readonly { device: TrustedDevice; confirmationCode: string; expiresAt: number }[]
}
function denied(): AgentMuxError {
  return new AgentMuxError('Device management requires a local user request and actual Mac confirmation. This operation was not submitted; existing authorization and Runs are retained.', 'CONTROL_PERMISSION_DENIED')
}
function local(context: DeviceManagementContext): void {
  if (context.caller !== undefined || context.transport !== 'unix' || context.principal?.kind !== 'user'
    || !context.principal.id || context.principal.id.includes('\0')) throw denied()
  context.signal?.throwIfAborted()
}
function params(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) throw new AgentMuxError('Device management parameters are invalid. No confirmation or mutation was submitted.', 'INVALID_CONTROL_REQUEST')
  return value as Record<string, unknown>
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 160 || /[\r\n\0]/u.test(value)) throw new AgentMuxError('Device identity is invalid.', 'INVALID_CONTROL_REQUEST')
  return value
}

/** Original Host Authority adapter. This module has no RPC transport, Core lifecycle or second Store. */
export class DeviceManagement {
  constructor(private readonly authority: DeviceAuthority, private readonly confirm: MacDeviceConfirmation = createMacDeviceConfirmation()) {}

  async ls(input: Record<string, never>, context: DeviceManagementContext): Promise<DeviceManagementList> {
    local(context); params(input, [])
    return { hostId: this.authority.hostId, devices: this.authority.devices(), requests: this.authority.requests() }
  }
  private async confirmation(intent: DeviceConfirmationIntent, context: DeviceManagementContext): Promise<void> {
    const outcome = await this.confirm(intent, context.signal)
    context.signal?.throwIfAborted()
    if (outcome !== 'confirmed') throw new AgentMuxError('Mac device confirmation was cancelled. This operation was not submitted; original authorization and Sessions are retained.', 'DEVICE_CONFIRMATION_CANCELLED')
  }
  async invite(input: Record<string, never>, context: DeviceManagementContext): Promise<ReturnType<DeviceAuthority['invite']>> {
    local(context); params(input, [])
    await this.confirmation({ action: 'invite', hostId: this.authority.hostId }, context)
    return this.authority.invite()
  }
  private waiting(deviceId: string, code?: string) {
    const request = this.authority.requests().find(value => value.device.deviceId === deviceId)
    if (!request || code !== undefined && request.confirmationCode !== code) throw denied()
    return request
  }
  async approve(input: { deviceId: string; confirmationCode: string }, context: DeviceManagementContext) {
    local(context); const p = params(input, ['deviceId', 'confirmationCode']), deviceId = identifier(p.deviceId)
    if (typeof p.confirmationCode !== 'string' || !/^[0-9]{6}$/u.test(p.confirmationCode)) throw denied()
    const initial = this.waiting(deviceId, p.confirmationCode)
    await this.confirmation({ action: 'approve', hostId: this.authority.hostId, deviceId, name: initial.device.name,
      confirmationCode: initial.confirmationCode, expiresAt: initial.expiresAt }, context)
    const current = this.waiting(deviceId, initial.confirmationCode)
    if (current.expiresAt !== initial.expiresAt || current.device.createdAt !== initial.device.createdAt) throw denied()
    return { hostId: this.authority.hostId, device: await this.authority.approve(deviceId, initial.confirmationCode) }
  }
  async reject(input: { deviceId: string }, context: DeviceManagementContext) {
    local(context); const deviceId = identifier(params(input, ['deviceId']).deviceId), initial = this.waiting(deviceId)
    await this.confirmation({ action: 'reject', hostId: this.authority.hostId, deviceId, name: initial.device.name,
      confirmationCode: initial.confirmationCode, expiresAt: initial.expiresAt }, context)
    const current = this.waiting(deviceId, initial.confirmationCode)
    if (current.expiresAt !== initial.expiresAt || current.device.createdAt !== initial.device.createdAt) throw denied()
    this.authority.reject(deviceId)
    return { hostId: this.authority.hostId, deviceId, state: 'denied' as const }
  }
  async revoke(input: { deviceId: string }, context: DeviceManagementContext) {
    local(context); const deviceId = identifier(params(input, ['deviceId']).deviceId)
    const initial = this.authority.devices().find(value => value.deviceId === deviceId)
    if (!initial) throw denied()
    await this.confirmation({ action: 'revoke', hostId: this.authority.hostId, deviceId, name: initial.name, createdAt: initial.createdAt }, context)
    const current = this.authority.devices().find(value => value.deviceId === deviceId)
    if (!current || current.createdAt !== initial.createdAt || current.revokedAt !== initial.revokedAt) throw denied()
    return { hostId: this.authority.hostId, device: await this.authority.revoke(deviceId) }
  }
}
