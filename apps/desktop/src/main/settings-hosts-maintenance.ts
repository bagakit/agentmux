import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { durableWriteFile, hostMaintenanceRequestDigest, parseHostMaintenanceRecord, parseHostMaintenanceParams, sameHostMaintenanceActor,
  type HostMaintenanceActor, type HostMaintenanceAdministration, type HostMaintenanceRecord, type HostMaintenanceRequest, type HostMaintenanceReview } from '@agentmux/core'
import { configValuesEqual } from '../shared/config-edit.js'
import { hostSchema } from './config-store.js'
import type { ConfigOwner } from './config-owner.js'
import type { SettingsHostsInstallOwner } from './settings-hosts-install.js'
import type { SettingsHostsUpgradeOwner } from './settings-hosts-upgrade.js'

const fail = (message: string, code: string): never => { throw Object.assign(new Error(message), { code }) }
// The exact SID and source route are already authenticated by Core. Missing live
// Runtime observation cannot revoke access to that retained identity's request.
/** The original authenticated operator reviews one exact request before execution. */
export class SettingsHostsMaintenanceOwner implements HostMaintenanceAdministration {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly directory: string, private readonly config: ConfigOwner,
    private readonly installs: Pick<SettingsHostsInstallOwner, 'install' | 'inspect'>,
    private readonly upgrades: Pick<SettingsHostsUpgradeOwner, 'upgrade' | 'inspect'>) {}
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(work)
    this.tail = pending.then(() => {}, () => {})
    return pending
  }
  private path(operationId: string): string {
    return join(this.directory, createHash('sha256').update(operationId).digest('hex') + '.json')
  }
  private async read(operationId: string): Promise<HostMaintenanceRecord | null> {
    let bytes: string
    try { bytes = await readFile(this.path(operationId), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    try {
      const record = parseHostMaintenanceRecord(JSON.parse(bytes))
      if (record.request.operationId !== operationId) throw new Error('Another operation occupies this record.')
      return record
    } catch { return fail('The original maintenance request could not be read. Its bytes were retained; no request or maintenance was replayed.', 'HOST_MAINTENANCE_RECORD_UNREADABLE') }
  }
  private async write(record: HostMaintenanceRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    // Confirm the new request directory's entry as well as the file inside it.
    const parent = await open(dirname(this.directory), 'r')
    try { await parent.sync() } finally { await parent.close() }
    await durableWriteFile(this.path(record.request.operationId), JSON.stringify(record) + '\n', { requireDirectorySync: true })
  }
  private authorize(record: HostMaintenanceRecord, actor: HostMaintenanceActor): void {
    if (actor.kind === 'agent' && !sameHostMaintenanceActor(record.requester, actor)) fail('A managed Agent may operate only its original maintenance requests.', 'CONTROL_PERMISSION_DENIED')
  }
  private async saved(input: HostMaintenanceRequest): Promise<void> {
    const parsed = hostSchema.safeParse(input.host)
    if (!parsed.success) fail('Maintenance requires a complete valid saved Host configuration.', 'INVALID_SETTING_VALUE')
    await this.config.inspect(current => {
      const saved = current.hosts.find(host => host.id === input.id)
      if (!saved || !configValuesEqual(saved, input.host)) fail('The saved Host changed. Keep this request and check the exact current Host before preparing a new request.', 'CONFIG_CONFLICT')
    })
  }
  async request(value: HostMaintenanceRequest, actor: HostMaintenanceActor, assertCurrent: () => Promise<void>): Promise<HostMaintenanceRecord> {
    const input = parseHostMaintenanceParams('settings.hosts.maintenance-request', value)
    return await this.enqueue(async () => {
      await assertCurrent()
      const existing = await this.read(input.operationId)
      if (existing) {
        if (!sameHostMaintenanceActor(existing.requester, actor) || !configValuesEqual(existing.request, input)) fail('This operation ID already identifies another original request. Inspect that operation; do not replay it.', 'HOST_MAINTENANCE_REQUEST_CONFLICT')
        return existing
      }
      await this.saved(input)
      const original = { request: structuredClone(input), requester: structuredClone(actor), createdAt: Date.now() }
      const record: HostMaintenanceRecord = { ...original, requestDigest: hostMaintenanceRequestDigest(original), state: 'pending' }
      await this.write(record)
      return record
    })
  }
  async inspect(operationId: string, actor: HostMaintenanceActor): Promise<HostMaintenanceRecord | null> {
    parseHostMaintenanceParams('settings.hosts.maintenance-inspect', { operationId })
    const record = await this.read(operationId)
    if (!record) return null
    this.authorize(record, actor)
    if (record.state === 'pending' || record.state === 'rejected' ||
        record.state === 'finished' && record.result && ['completed', 'failed'].includes(record.result.status)) return record
    // After a crash or lost reply, query only the original maintenance operation.
    // A missing receipt never proves that executing the action again is safe.
    try {
      const result = record.request.action === 'install'
        ? await this.installs.inspect(record.request.host, operationId)
        : await this.upgrades.inspect(record.request.host, operationId)
      const { issue: _previousIssue, ...original } = record
      return result ? { ...original, state: 'finished', result } : { ...record, state: 'unconfirmed',
        issue: { code: 'HOST_MAINTENANCE_EXECUTION_UNCONFIRMED', message: 'No original maintenance receipt is confirmed. The approved request is retained and will not be executed again.' } }
    } catch (error) {
      return { ...record, state: 'unconfirmed', issue: { code: 'HOST_MAINTENANCE_INSPECT_UNAVAILABLE',
        message: 'The original maintenance result could not be read: ' + (error instanceof Error ? error.message : String(error)) } }
    }
  }
  async review(value: HostMaintenanceReview, actor: HostMaintenanceActor, assertCurrent: () => Promise<void>): Promise<HostMaintenanceRecord> {
    const input = parseHostMaintenanceParams('settings.hosts.maintenance-review', value)
    const claimed = await this.enqueue(async () => {
      await assertCurrent()
      const record = await this.read(input.operationId)
      if (!record) return fail('The original maintenance request was not found.', 'HOST_MAINTENANCE_REQUEST_NOT_FOUND')
      this.authorize(record, actor)
      if (record.requestDigest !== input.requestDigest) fail('Review the original exact maintenance request digest before deciding.', 'CONFIG_CONFLICT')
      if (record.state !== 'pending') {
        if (record.review?.decision !== input.decision) fail('This original request already has a different decision. Its execution will not be changed or replayed.', 'HOST_MAINTENANCE_REQUEST_CONFLICT')
        return { record, execute: false }
      }
      if (input.decision === 'approve') await this.saved(record.request)
      const next: HostMaintenanceRecord = { ...record, state: input.decision === 'approve' ? 'executing' : 'rejected',
        review: { actor: structuredClone(actor), decision: input.decision, reviewedAt: Date.now() } }
      // A failed persistence ACK never admits a remote write. The record may have
      // been replaced already, so callers must inspect this same operation.
      await this.write(next)
      return { record: next, execute: input.decision === 'approve' }
    })
    if (!claimed.execute) return (await this.inspect(input.operationId, actor))!
    let result: HostMaintenanceRecord
    try {
      await assertCurrent()
      const request = claimed.record.request
      const receipt = request.action === 'install'
        ? await this.installs.install(request.host, request.expected, request.operationId)
        : await this.upgrades.upgrade(request.host, request.expected, request.operationId)
      result = { ...claimed.record, state: 'finished', result: receipt }
    } catch (error) {
      result = { ...claimed.record, state: 'unconfirmed', issue: { code: 'HOST_MAINTENANCE_EXECUTION_UNCONFIRMED',
        message: 'Inspect the original maintenance operation before another action: ' + (error instanceof Error ? error.message : String(error)) } }
    }
    try { await this.enqueue(async () => await this.write(result)); return result }
    catch { return { ...result, issue: { code: 'HOST_MAINTENANCE_RECEIPT_NOT_SAVED', message: 'This execution result is available, but its restart record was not confirmed. Inspect the original operation; do not execute it again.' } } }
  }
}
