import { readFile } from 'node:fs/promises'
import { durableWriteFile, RemoteCoreInstallManager, remoteCoreUpgradeTargetDigest, type RemoteCoreInstallCheck, type RemoteCoreInstallExpected, type RemoteCoreInstallReceipt } from '@agentmux/core'
import { hostSchema } from './config-store.js'
import type { ConfigOwner } from './config-owner.js'
import type { RuntimeController } from './runtime-controller.js'
import type { HostConfig } from '../shared/contracts.js'

/** Main alone adopts a completed install into the saved Host. Inspection is read-only:
 * it neither deploys nor reconnects, and newer Host configuration always wins. */
type Adoption = { targetDigests: string[]; value: NonNullable<RemoteCoreInstallReceipt['connectionAdoption']> }
export class SettingsHostsInstallOwner {
  private readonly local = new Map<string, Adoption>()
  private writes: Promise<void> = Promise.resolve()
  private async ledger(): Promise<Record<string, Adoption>> {
    if (!this.adoptionPath) return {}
    try {
      const parsed: unknown = JSON.parse(await readFile(this.adoptionPath, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid adoption document')
      return parsed as Record<string, Adoption>
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
  }
  private async record(operationId: string, value: Adoption): Promise<string | undefined> {
    this.local.set(operationId, value)
    if (!this.adoptionPath) return
    const write = this.writes.then(async () => {
      const document = await this.ledger()
      Object.defineProperty(document, operationId, { value, enumerable: true, configurable: true, writable: true })
      await durableWriteFile(this.adoptionPath!, JSON.stringify(document) + '\n', { requireDirectorySync: true })
    })
    this.writes = write.catch(() => {})
    try { await write } catch { return 'Connection adoption was confirmed for this process, but its restart record could not be saved. The original record was retained.' }
  }
  private async project(receipt: RemoteCoreInstallReceipt, host: HostConfig): Promise<RemoteCoreInstallReceipt> {
    if (receipt.status !== 'completed') return receipt
    let known = this.local.get(receipt.operationId), issue = ''
    try { const document = await this.ledger(); if (!known && Object.hasOwn(document, receipt.operationId)) known = document[receipt.operationId] }
    catch { issue = ' The saved adoption record could not be read; it was retained.' }
    if (known && Array.isArray(known.targetDigests) && known.targetDigests.includes(remoteCoreUpgradeTargetDigest(host)) &&
        known.value && ['connected', 'unconfirmed'].includes(known.value.state) && Number.isSafeInteger(known.value.readAt) && typeof known.value.detail === 'string') {
      return { ...receipt, connectionAdoption: known.value }
    }
    return { ...receipt, connectionAdoption: { state: 'pending-confirmation', readAt: Date.now(),
      detail: 'Installation completed. This read does not reconnect or confirm current connection health; use the saved Host connection.' + issue } }
  }
  constructor(private readonly manager: RemoteCoreInstallManager, private readonly config: ConfigOwner,
    private readonly runtime: Pick<RuntimeController, 'checkHost'>, private readonly adoptionPath?: string) {}
  private capture(value: unknown): HostConfig {
    const parsed = hostSchema.safeParse(value)
    if (!parsed.success) throw Object.assign(new Error('Installation requires a complete valid Host input.'), { code: 'INVALID_SETTING_VALUE' })
    return parsed.data as HostConfig
  }
  private async saved(value: unknown): Promise<HostConfig> {
    const captured = this.capture(value)
    return await this.config.inspect(current => {
      const saved = current.hosts.find(host => host.id === captured.id)
      if (!saved || remoteCoreUpgradeTargetDigest(saved) !== remoteCoreUpgradeTargetDigest(captured)) throw Object.assign(
        new Error('Save this exact Host before checking or applying an installation.'), { code: 'CONFIG_CONFLICT' })
      return structuredClone(saved)
    })
  }
  async check(value: unknown): Promise<RemoteCoreInstallCheck> {
    const host = await this.saved(value), check = await this.manager.check(host)
    return check.latestOperation ? { ...check, latestOperation: await this.project(check.latestOperation, host) } : check
  }
  async inspect(value: unknown, operationId: string): Promise<RemoteCoreInstallReceipt | null> {
    const receipt = await this.manager.inspect(this.capture(value), operationId)
    if (!receipt || receipt.status !== 'completed') return receipt
    return await this.project(receipt, this.capture(value))
  }
  async install(value: unknown, expected: RemoteCoreInstallExpected, operationId: string): Promise<RemoteCoreInstallReceipt> {
    const captured = await this.saved(value)
    if (captured.kind === 'ssh' && captured.runtimeId) throw Object.assign(new Error('A first installation cannot replace this Host’s saved Runtime identity. Use its original connection and recovery path.'), { code: 'CONFIG_CONFLICT' })
    const receipt = await this.manager.install(captured, expected, operationId)
    if (receipt.status !== 'completed' || !receipt.installed || captured.kind !== 'ssh') return receipt
    const next = { ...captured, remoteCommand: receipt.installed.remoteCommand, remoteSocketPath: receipt.installed.remoteSocketPath, runtimeId: receipt.installed.runtimeId }
    try {
      await this.config.update(current => {
        const saved = current.hosts.find(host => host.id === captured.id)
        if (!saved || ![remoteCoreUpgradeTargetDigest(captured), remoteCoreUpgradeTargetDigest(next)].includes(remoteCoreUpgradeTargetDigest(saved))) throw Object.assign(
          new Error('The Host changed while installing. Its newer configuration was preserved.'), { code: 'CONFIG_CONFLICT' })
        return { ...current, hosts: current.hosts.map(host => host.id === captured.id ? { ...next, label: host.label } : host) }
      })
      await this.runtime.checkHost(next)
      const connectionAdoption = { state: 'connected' as const, readAt: Date.now(), detail: 'The installed Core connection was saved and verified at this receipt time.' }
      const issue = await this.record(operationId, { targetDigests: [remoteCoreUpgradeTargetDigest(captured), remoteCoreUpgradeTargetDigest(next)], value: connectionAdoption })
      return { ...receipt, connectionAdoption: issue ? { ...connectionAdoption, detail: connectionAdoption.detail + ' ' + issue } : connectionAdoption }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'CORE_CONNECTION_UNCONFIRMED'
      const connectionAdoption = { state: 'unconfirmed' as const, readAt: Date.now(), code,
        detail: 'Installation completed, but saving or verifying its connection was not confirmed. The installed Core and newer Host settings are retained. Inspect the original operation and test the saved Host; do not install again.' }
      const issue = await this.record(operationId, { targetDigests: [remoteCoreUpgradeTargetDigest(captured), remoteCoreUpgradeTargetDigest(next)], value: connectionAdoption })
      return { ...receipt, connectionAdoption: issue ? { ...connectionAdoption, detail: connectionAdoption.detail + ' ' + issue } : connectionAdoption }
    }
  }
}
