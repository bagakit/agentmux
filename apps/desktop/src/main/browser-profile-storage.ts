import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError, parseBrowserProfileStoragePayload, parseBrowserProfileStorageReceipt,
  type BrowserProfileStorageClearInput, type BrowserProfileStorageInspect, type BrowserProfileStorageReceipt, type BrowserProfileStorageSnapshot } from '@agentmux/core/control'
import { inspectBrowserProfileStorage } from './browser-profile-storage-inventory.js'

export type BrowserProfileStoragePorts = {
  read(profileId: string): Promise<{ revision: string; receipts: BrowserProfileStorageReceipt[] }>
  root(profileId: string): string
  save(profileId: string, receipt: BrowserProfileStorageReceipt, create?: boolean): Promise<void>
  change<T>(profileId: string, action: () => Promise<T>): Promise<T>
  native(profileId: string): Promise<{ clear(storageKey: string): Promise<void>; dispose(): void }>
}
const unfinished = (receipt: BrowserProfileStorageReceipt) => ['awaiting-confirmation', 'pending', 'partial', 'unknown'].includes(receipt.status)
const liveKey = (receipt: Pick<BrowserProfileStorageReceipt, 'profileId' | 'operationId'>) => JSON.stringify([receipt.profileId, receipt.operationId])
const refused = (message: string): never => { throw new AgentMuxError(message, 'BROWSER_PROFILE_STORAGE_REFUSED') }
function original(receipt: BrowserProfileStorageReceipt): BrowserProfileStorageClearInput {
  const { profileId, expectedRevision, operationId, sites } = receipt
  return { profileId, expectedRevision, operationId, sites }
}

/** Operation records stay in the Profile Store. This owner holds only live dispatch facts. */
export class BrowserProfileStorage {
  private readonly active = new Set<string>()
  private confirmation?: (request: BrowserProfileStorageClearInput) => Promise<boolean>
  constructor(private readonly ports: BrowserProfileStoragePorts) {}
  setConfirmationHandler(handler: (request: BrowserProfileStorageClearInput) => Promise<boolean>): void { this.confirmation = handler }

  private observed(receipt: BrowserProfileStorageReceipt): BrowserProfileStorageReceipt {
    const value = structuredClone(receipt)
    if (!this.active.has(liveKey(value)) && ['awaiting-confirmation', 'pending'].includes(value.status)) {
      value.status = 'unknown'
      value.issues.push('This process has no live confirmation or dispatch observation for the original operation. Its saved phase is retained; it was not replayed.')
    }
    return value
  }
  private snapshot(profileId: string, revision: string): Promise<BrowserProfileStorageSnapshot> {
    try { return inspectBrowserProfileStorage(this.ports.root(profileId), profileId, revision) }
    catch { return Promise.resolve({ profileId, profileRevision: revision, observedAt: Date.now(), sites: [], usage: { logicalBytes: 0, allocatedBytes: null, complete: false }, unattributed: { logicalBytes: 0, allocatedBytes: null, complete: false }, issues: ['The original Profile storage binding could not be observed. Existing data and Browser work are kept.'] }) }
  }
  async inspect(profileId: string, operationId?: string): Promise<BrowserProfileStorageInspect> {
    parseBrowserProfileStoragePayload({ operation: 'browser.profile.storage.inspect', profileId, ...(operationId === undefined ? {} : { operationId }) })
    const current = await this.ports.read(profileId)
    return { snapshot: await this.snapshot(profileId, current.revision), receipt: operationId === undefined ? null : current.receipts.find(receipt => receipt.operationId === operationId) ? this.observed(current.receipts.find(receipt => receipt.operationId === operationId)!) : null,
      pending: current.receipts.filter(unfinished).map(receipt => this.observed(receipt)) }
  }

  async clear(raw: BrowserProfileStorageClearInput): Promise<BrowserProfileStorageReceipt> {
    const { operation: _operation, ...input } = parseBrowserProfileStoragePayload({ ...raw, operation: 'browser.profile.storage.clear' }) as BrowserProfileStorageClearInput & { operation: 'browser.profile.storage.clear' }
    return this.ports.change(input.profileId, async () => {
      const current = await this.ports.read(input.profileId)
      const prior = current.receipts.find(receipt => receipt.operationId === input.operationId)
      if (prior) {
        if (!isDeepStrictEqual(original(prior), input)) refused('This original offline cache operation belongs to different parameters. Inspect its original receipt; it was not dispatched again.')
        return this.observed(prior)
      }
      if (current.revision !== input.expectedRevision) refused('The original Profile configuration changed. Read that Profile and choose its current revision before another cache action.')
      if (!this.confirmation) refused('Human offline cache confirmation is unavailable in this host. Existing Profile data and Browser work remain available.')
      const before = await this.snapshot(input.profileId, current.revision)
      this.validateSelection(input, before)
      const keys = input.sites.flatMap(site => site.storageKeys)
      let receipt: BrowserProfileStorageReceipt = { ...structuredClone(input), status: 'awaiting-confirmation', requestedAt: Date.now(), finishedAt: null,
        results: keys.map(storageKey => ({ storageKey, status: 'not-dispatched' })), before, after: null, issues: [] }
      // Durable original identity is mandatory for this exact destructive action, not for browsing.
      await this.ports.save(input.profileId, receipt, true)
      this.active.add(liveKey(input))
      let native: Awaited<ReturnType<BrowserProfileStoragePorts['native']>> | undefined
      let durable = true
      try {
        if (!await this.confirmation!(structuredClone(input))) {
          receipt.status = 'cancelled'; receipt.finishedAt = Date.now()
          await this.ports.save(input.profileId, receipt)
          return structuredClone(receipt)
        }
        const latest = await this.ports.read(input.profileId)
        if (latest.revision !== input.expectedRevision) refused('The Profile changed during human confirmation. No cache clear was sent; inspect the original operation and read this Profile again.')
        this.validateSelection(input, await this.snapshot(input.profileId, latest.revision))
        native = await this.ports.native(input.profileId)
        for (let index = 0; index < receipt.results.length; index++) {
          receipt.status = 'pending'
          receipt.results[index]!.status = 'unknown'
          // Save the exact key as possibly dispatched before crossing native's irreversible boundary.
          await this.ports.save(input.profileId, receipt)
          try {
            await native.clear(keys[index]!)
            receipt.results[index]!.status = 'acknowledged'
          } catch {
            receipt.issues.push('A native cache command did not return a confirmed acknowledgement. Its effect is unknown; it was not replayed.')
          }
          try { await this.ports.save(input.profileId, receipt) }
          catch { durable = false; receipt.issues.push('The original native result could not be confirmed durably saved. Inspect this operation before another action.'); break }
          // A failed native call may have applied. Keep the remaining key set undispatched.
          if (receipt.results[index]!.status !== 'acknowledged') break
        }
        receipt.after = await this.snapshot(input.profileId, input.expectedRevision)
        const acknowledged = receipt.results.filter(result => result.status === 'acknowledged').length
        receipt.status = !durable ? 'unknown' : acknowledged === receipt.results.length ? 'completed' : acknowledged ? 'partial' : 'unknown'
        receipt.issues.push('Native acknowledgement reports command completion, not guaranteed bytes removed. Current disk observations can include new website writes.')
        receipt.finishedAt = Date.now()
        await this.ports.save(input.profileId, receipt)
        return structuredClone(receipt)
      } catch (error) {
        const attempted = receipt.results.some(result => result.status !== 'not-dispatched')
        receipt.status = attempted ? 'unknown' : 'failed'
        receipt.finishedAt = Date.now()
        receipt.issues.push(attempted ? 'The original action or its durable result is unconfirmed. It was not automatically repeated.' : 'No native cache clear was dispatched. Restore the original target or confirmation and use a new operation.')
        if (error instanceof AgentMuxError) receipt.issues.push(error.message)
        try { await this.ports.save(input.profileId, receipt) }
        catch { receipt.status = 'unknown'; receipt.issues.push('The saved operation remains unconfirmed. Inspect its original identity; no automatic replay will occur.') }
        return parseBrowserProfileStorageReceipt(receipt)
      } finally { native?.dispose(); this.active.delete(liveKey(input)) }
    })
  }
  private validateSelection(input: BrowserProfileStorageClearInput, snapshot: BrowserProfileStorageSnapshot): void {
    for (const selected of input.sites) {
      const site = snapshot.sites.find(site => site.origin === selected.origin)
      if (!site || selected.storageKeys.some(key => !site.storageKeys.includes(key))) refused('One or more selected original storage keys are no longer confirmed for this Profile and origin. Refresh its storage observation; nothing was cleared.')
    }
  }
}
