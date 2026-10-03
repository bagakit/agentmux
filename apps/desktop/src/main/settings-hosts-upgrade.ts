import { RemoteCoreUpgradeManager, remoteCoreUpgradeTargetDigest, type RemoteCoreUpgradeExpected, type RemoteCoreUpgradeCheck, type RemoteCoreUpgradeReceipt } from '@agentmux/core'
import type { HostConfig } from '../shared/contracts.js'
import { hostSchema } from './config-store.js'
import type { ConfigOwner } from './config-owner.js'
import type { RuntimeController } from './runtime-controller.js'

/** Main owns saved Host bindings; the Core maintenance owner owns deployment. */
export class SettingsHostsUpgradeOwner {
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
    const receipt = check.latestOperation
    if (receipt?.status !== 'completed') return check
    try {
      if (captured.kind !== 'ssh' || captured.remoteCommand !== receipt.remoteCommand) throw new Error('The original update completed remotely, but its saved connection binding has not been updated.')
      await this.runtime.checkHost(captured)
      return check
    } catch (error) {
      const { expected: _expected, ...unconfirmed } = check
      return { ...unconfirmed, eligible: false, reason: 'unverified', latestOperation: { ...receipt, status: 'unknown', stage: 'verifying',
        detail: `远端 Core 已升级，连接尚未确认：${error instanceof Error ? error.message : String(error)}。复查原操作，不要重复升级。` } }
    }
  }
  async upgrade(value: unknown, expected: RemoteCoreUpgradeExpected, operationId: string): Promise<RemoteCoreUpgradeReceipt> {
    const captured = await this.saved(value)
    return await this.reconnect(await this.manager.upgrade(captured, expected, operationId), captured)
  }
  async inspect(value: unknown, operationId: string): Promise<RemoteCoreUpgradeReceipt | null> {
    const captured = this.capture(value)
    const receipt = await this.manager.inspect(captured, operationId)
    return receipt ? await this.reconnect(receipt, captured) : null
  }
  private async reconnect(receipt: RemoteCoreUpgradeReceipt, captured: HostConfig): Promise<RemoteCoreUpgradeReceipt> {
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
      return { ...receipt, detail: 'Core 已升级并重新连接；原 Runtime、Session 和运行进程保留。' }
    } catch (error) {
      return { ...receipt, status: 'unknown', stage: 'verifying', detail: `远端 Core 已升级，连接设置尚未核实：${error instanceof Error ? error.message : String(error)}。复查原操作，不要重复升级。` }
    }
  }
}
