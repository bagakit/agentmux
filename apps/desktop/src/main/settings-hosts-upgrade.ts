import { readFile } from 'node:fs/promises'
import { RemoteCoreUpgradeManager, durableWriteFile, remoteCoreUpgradeTargetDigest, type RemoteCoreUpgradeExpected, type RemoteCoreUpgradeCheck, type RemoteCoreUpgradeReceipt } from '@agentmux/core'
import type { HostConfig } from '../shared/contracts.js'
import { hostSchema } from './config-store.js'
import type { ConfigOwner } from './config-owner.js'
import type { RuntimeController } from './runtime-controller.js'

type Adoption = { targetDigests: string[]; value: NonNullable<RemoteCoreUpgradeReceipt['connectionAdoption']> }
/** The file document is kept whole: entries that fail the shape check stay verbatim
 * and are named by operation ID, so a later write never erases them. */
type AdoptionLedger = { document: Record<string, unknown> & { adoptions: Record<string, unknown> }; adoptions: Map<string, Adoption>; malformed: Set<string> }
type LedgerRead = AdoptionLedger | { unreadable: string }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
function adoption(entry: unknown): entry is Adoption {
  return plain(entry) && Array.isArray(entry.targetDigests) && entry.targetDigests.every(digest => typeof digest === 'string') &&
    plain(entry.value) && ['connected', 'unconfirmed'].includes(entry.value.state as string) && Number.isSafeInteger(entry.value.readAt)
}

/** Main owns saved Host bindings and their adoption receipts; the Core maintenance
 * owner owns deployment. Adoption receipts are durable, so a restart reads the
 * recorded connected or unconfirmed fact instead of asking for another reconnect. */
export class SettingsHostsUpgradeOwner {
  private ledger: Promise<LedgerRead> | undefined
  private writes: Promise<void> = Promise.resolve()
  /** Receipts this process confirmed; true here even when the file could not take them. */
  private readonly local = new Map<string, Adoption>()
  constructor(private readonly manager: RemoteCoreUpgradeManager, private readonly config: ConfigOwner,
    private readonly runtime: Pick<RuntimeController, 'checkHost'>, private readonly adoptionPath: string) {}
  private async load(): Promise<LedgerRead> {
    let source: string | undefined
    try { source = await readFile(this.adoptionPath, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { unreadable: errorText(error) } }
    let document: unknown = { adoptions: {} }
    try { if (source !== undefined) document = JSON.parse(source) } catch (error) { return { unreadable: errorText(error) } }
    if (!plain(document) || document.adoptions !== undefined && !plain(document.adoptions)) return { unreadable: 'The file is not an adoption ledger.' }
    const raw = (document.adoptions ?? {}) as Record<string, unknown>, adoptions = new Map<string, Adoption>(), malformed = new Set<string>()
    for (const [operationId, entry] of Object.entries(raw)) if (adoption(entry)) adoptions.set(operationId, entry); else malformed.add(operationId)
    return { document: { ...document, adoptions: raw }, adoptions, malformed }
  }
  /** One read in flight at a time; a failed read is not kept, so the next call reads the file again. */
  private async adoptions(): Promise<LedgerRead> {
    const pending = this.ledger ??= this.load()
    const ledger = await pending
    if ('unreadable' in ledger && this.ledger === pending) this.ledger = undefined
    return ledger
  }
  /** Returns why the receipt was not saved for restart; it stays true for this process either way. */
  private async record(operationId: string, entry: Adoption): Promise<string | undefined> {
    this.local.set(operationId, entry)
    const ledger = await this.adoptions()
    // An unreadable file may still hold earlier receipts. Leave its bytes alone.
    if ('unreadable' in ledger) return `saved adoption receipts could not be read, so the file was left unchanged (${ledger.unreadable})`
    ledger.document.adoptions[operationId] = entry; ledger.adoptions.set(operationId, entry); ledger.malformed.delete(operationId)
    const write = this.writes.then(async () => await durableWriteFile(this.adoptionPath, JSON.stringify(ledger.document) + '\n', { requireDirectorySync: true }))
    this.writes = write.catch(() => {})
    try { await write; return undefined } catch (error) { return errorText(error) }
  }
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
    const ledger = await this.adoptions()
    const known = this.local.get(receipt.operationId) ?? ('unreadable' in ledger ? undefined : ledger.adoptions.get(receipt.operationId))
    const unread = 'unreadable' in ledger ? ` Saved adoption receipts could not be read (${ledger.unreadable}).`
      : ledger.malformed.has(receipt.operationId) && !known ? ` The saved adoption receipt for ${receipt.operationId} could not be read.` : ''
    const connectionAdoption = known && saved && known.targetDigests.includes(remoteCoreUpgradeTargetDigest(saved)) ? known.value : {
      state: 'pending-confirmation' as const, readAt: Date.now(), detail: `The Core deployment completed. Confirm reconnect to adopt and verify its saved connection.${unread}` }
    return { ...receipt, connectionAdoption }
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
      const retention = await this.record(receipt.operationId, { targetDigests: [remoteCoreUpgradeTargetDigest(next)], value: connectionAdoption })
      return { ...receipt, connectionAdoption: retention ? { ...connectionAdoption, detail: `${connectionAdoption.detail} It was not saved for restart: ${retention}.` } : connectionAdoption }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'CORE_CONNECTION_UNCONFIRMED'
      const connectionAdoption = { state: 'unconfirmed' as const, readAt: Date.now(), code, detail: 'The Core deployment completed, but its saved connection was not confirmed. Inspect this original operation before another explicit reconnect.' }
      const retention = await this.record(receipt.operationId, { targetDigests: [remoteCoreUpgradeTargetDigest(captured), remoteCoreUpgradeTargetDigest(next)], value: connectionAdoption })
      return { ...receipt, connectionAdoption: retention ? { ...connectionAdoption, detail: `${connectionAdoption.detail} It was not saved for restart: ${retention}.` } : connectionAdoption }
    }
  }
}
