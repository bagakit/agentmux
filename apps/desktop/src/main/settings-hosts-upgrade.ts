import { RemoteCoreUpgradeManager, remoteCoreUpgradeTargetDigest, type RemoteCoreUpgradeExpected, type RemoteCoreUpgradeCheck, type RemoteCoreUpgradeReceipt } from '@agentmux/core'
import type { HostConfig } from '../shared/contracts.js'
import { hostSchema } from './config-store.js'
import type { ConfigOwner } from './config-owner.js'
import type { RuntimeController } from './runtime-controller.js'

/** Main owns saved Host bindings; the Core maintenance owner owns deployment. */
export class SettingsHostsUpgradeOwner {
  private readonly adoptions = new Map<string, { targetDigests: string[]; value: NonNullable<RemoteCoreUpgradeReceipt['connectionAdoption']> }>()
  constructor(private readonly manager: RemoteCoreUpgradeManager, private readonly config: ConfigOwner,
    private readonly runtime: Pick<RuntimeController, 'checkHost'>) {}
  private capture(value: unknown): HostConfig {
    const parsed = hostSchema.safeParse(value)
    if (!parsed.success) throw Object.assign(new Error('Upgrade requires a complete valid Host input.'), { code: 'INVALID_SETTING_VALUE' })
    return parsed.data as HostConfig
  }
  private async saved(value: unknown): Promise<HostConfig> {
    const captured = this.capture(value)
    return await this.config.inspect(current => {
      const saved = current.hosts.find(host => host.id === captured.id)
      if (!saved || remoteCoreUpgradeTargetDigest(saved) !== remoteCoreUpgradeTargetDigest(captured)) throw Object.assign(
        new Error('Save this exact Host configuration before upgrading it.'), { code: 'CONFIG_CONFLICT' })
      return structuredClone(saved)
    })
  }
  async check(value: unknown): Promise<RemoteCoreUpgradeCheck> {
    const captured = this.capture(value), check = await this.manager.check(captured)
    return check.latestOperation ? { ...check, latestOperation: await this.project(check.latestOperation) } : check
  }
  async upgrade(value: unknown, expected: RemoteCoreUpgradeExpected, operationId: string): Promise<RemoteCoreUpgradeReceipt> {
    const captured = await this.saved(value)
    return await this.adopt(await this.manager.upgrade(captured, expected, operationId), captured)
  }
  async inspect(value: unknown, operationId: string): Promise<RemoteCoreUpgradeReceipt | null> {
    const captured = this.capture(value)
    const receipt = await this.manager.inspect(captured, operationId)
    return receipt ? await this.project(receipt) : null
  }
  /** Explicit confirmation of this original operation; never starts a deployment. */
  async reconnect(value: unknown, operationId: string): Promise<RemoteCoreUpgradeReceipt | null> {
    const captured = await this.saved(value)
    const receipt = await this.manager.inspect(captured, operationId)
    return receipt ? await this.adopt(receipt, captured) : null
  }
  private async project(receipt: RemoteCoreUpgradeReceipt): Promise<RemoteCoreUpgradeReceipt> {
    if (receipt.status !== 'completed' || !receipt.remoteCommand || receipt.input.kind !== 'ssh') return receipt
    const saved = await this.config.inspect(current => current.hosts.find(host => host.id === receipt.input.id))
    const known = this.adoptions.get(receipt.operationId)
    const adoption = known && saved && known.targetDigests.includes(remoteCoreUpgradeTargetDigest(saved)) ? known.value : {
      state: 'pending-confirmation' as const, readAt: Date.now(), detail: 'The Core deployment completed. Confirm reconnect to adopt and verify its saved connection.' }
    return { ...receipt, connectionAdoption: adoption }
  }
  private async adopt(receipt: RemoteCoreUpgradeReceipt, captured: HostConfig): Promise<RemoteCoreUpgradeReceipt> {
    if (receipt.status !== 'completed' || !receipt.remoteCommand || captured.kind !== 'ssh') return receipt
    const next = { ...captured, remoteCommand: receipt.remoteCommand }
    try {
      await this.config.update(current => {
        const saved = current.hosts.find(host => host.id === captured.id)
        if (!saved || ![remoteCoreUpgradeTargetDigest(captured), remoteCoreUpgradeTargetDigest(next)].includes(remoteCoreUpgradeTargetDigest(saved))) {
          throw Object.assign(new Error('The saved Host changed during the update. Its newer configuration was preserved.'), { code: 'CONFIG_CONFLICT' })
        }
        return { ...current, hosts: current.hosts.map(host => host.id === captured.id ? { ...next, label: host.label } : host) }
      })
      await this.runtime.checkHost(next)
      const connectionAdoption = { state: 'connected' as const, readAt: Date.now(), detail: 'The saved Core connection was adopted and verified at this receipt time. This is not a continuous connection-health observation.' }
      this.adoptions.set(receipt.operationId, { targetDigests: [remoteCoreUpgradeTargetDigest(next)], value: connectionAdoption })
      return { ...receipt, connectionAdoption }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'CORE_CONNECTION_UNCONFIRMED'
      const connectionAdoption = { state: 'unconfirmed' as const, readAt: Date.now(), code, detail: 'The Core deployment completed, but its saved connection was not confirmed. Inspect this original operation before another explicit reconnect.' }
      this.adoptions.set(receipt.operationId, { targetDigests: [remoteCoreUpgradeTargetDigest(captured), remoteCoreUpgradeTargetDigest(next)], value: connectionAdoption })
      return { ...receipt, connectionAdoption }
    }
  }
}
