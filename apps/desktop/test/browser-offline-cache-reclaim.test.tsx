// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { BrowserOfflineCache } from '../src/renderer/src/components/performance/BrowserOfflineCache'
import { api } from '../src/renderer/src/lib/api'
import { offlineProfiles, offlineSnapshot, offlineReceipt } from '../scripts/fixtures/performance-reclaim/offline-data'
import { composerDOM } from './helpers/composer-dom-fixture'
import type { BrowserProfileStorageInspect } from '@agentmux/core/control'
const dom = composerDOM(), first = offlineProfiles[0]!.id, second = offlineProfiles[1]!.id
const observation = (id = first): BrowserProfileStorageInspect => ({ snapshot: offlineSnapshot(id), receipt: null, pending: [] })
const node = <T extends HTMLElement = HTMLElement>(selector: string): T => { const value = document.querySelector<T>(selector); expect(value, selector).not.toBeNull(); return value! }
const click = (selector: string) => act(async () => node<HTMLButtonElement>(selector).click())
const choose = (id: string) => act(async () => { const select = node<HTMLSelectElement>('select'); select.value = id; select.dispatchEvent(new Event('change', { bubbles: true })) })
const render = (active = true) => dom.render(<BrowserOfflineCache active={active} />)
beforeEach(() => {
  vi.spyOn(api.browser, 'listProfiles').mockResolvedValue(structuredClone(offlineProfiles))
  vi.spyOn(api.browser, 'inspectProfileStorage').mockImplementation(async id => observation(id))
  vi.spyOn(api.browser, 'clearProfileStorage').mockImplementation(async input => offlineReceipt(input))
  vi.spyOn(api.performance, 'reclaimCache')
})

it('reads only the visible original Profile, once per entry, and never cleans on entry or refresh', async () => {
  await render(false); expect(api.browser.listProfiles).not.toHaveBeenCalled(); expect(api.browser.inspectProfileStorage).not.toHaveBeenCalled()
  await render(); expect(api.browser.inspectProfileStorage).toHaveBeenCalledExactlyOnceWith(first, undefined)
  expect(node('[data-offline-size]').textContent).toBe('5.6 GiB')
  await render(); expect(api.browser.inspectProfileStorage).toHaveBeenCalledTimes(1)
  await click('[aria-label="Refresh offline cache"]'); expect(api.browser.inspectProfileStorage).toHaveBeenCalledTimes(2)
  await render(false); await render(); expect(api.browser.inspectProfileStorage).toHaveBeenCalledTimes(3)
  expect(api.browser.clearProfileStorage).not.toHaveBeenCalled(); expect(api.performance.reclaimCache).not.toHaveBeenCalled()
})

it('sends one frozen full-key site or every identified site in one operation through the actual API consumer', async () => {
  await render()
  const snapshot = offlineSnapshot(), selected = snapshot.sites[0]!
  await click('[data-offline-site] button')
  const input = vi.mocked(api.browser.clearProfileStorage).mock.calls[0]![0]
  expect(input).toMatchObject({ profileId: first, expectedRevision: snapshot.profileRevision, sites: [{ origin: selected.origin, storageKeys: selected.storageKeys }] })
  expect(input.operationId).toBeTruthy(); expect(input.sites[0]!.storageKeys).toHaveLength(2)
  await click('[data-offline-clear-all]')
  const all = vi.mocked(api.browser.clearProfileStorage).mock.calls[1]![0]
  expect(all.sites).toEqual(snapshot.sites.map(({ origin, storageKeys }) => ({ origin, storageKeys })))
  expect(all.operationId).not.toBe(input.operationId)
  expect(api.browser.clearProfileStorage).toHaveBeenCalledTimes(2)
  expect(node('[data-offline-result]').textContent).toContain('Request completed')
  expect(node('[data-offline-change]').textContent).toBe('Unchanged')
})

it('keeps a late former Profile read from erasing the newly selected Profile', async () => {
  let resolve!: (value: BrowserProfileStorageInspect) => void
  vi.mocked(api.browser.inspectProfileStorage).mockImplementation(id => id === first ? new Promise(done => { resolve = done }) : Promise.resolve(observation(id)))
  await render(); await choose(second)
  const next = node('[data-offline-size]').textContent
  await act(async () => { const old = observation(); old.snapshot.observedAt++; old.snapshot.usage.logicalBytes = old.snapshot.usage.allocatedBytes = 999; resolve(old) })
  expect(node('[data-offline-size]').textContent).toBe(next)
  await click('[data-offline-clear-all]')
  expect(vi.mocked(api.browser.clearProfileStorage).mock.calls[0]![0].profileId).toBe(second)
})

it('retains an unknown original cleanup across refresh and entry, checking its exact identity without replay', async () => {
  vi.mocked(api.browser.clearProfileStorage).mockRejectedValueOnce(new Error('Original reply lost'))
  await render(); await click('[data-offline-clear-all]')
  const original = vi.mocked(api.browser.clearProfileStorage).mock.calls[0]![0]
  await click('[aria-label="Refresh offline cache"]'); await render(false); await render()
  expect(node('[data-offline-result]').dataset.offlineResult).toBe('unknown')
  expect(node('[data-offline-result]').textContent).toContain('Original reply lost')
  vi.mocked(api.browser.inspectProfileStorage).mockResolvedValueOnce({ ...observation(), receipt: offlineReceipt(original) })
  await click('[data-offline-check-original]')
  expect(api.browser.inspectProfileStorage).toHaveBeenLastCalledWith(first, original.operationId)
  expect(node('[data-offline-result]').dataset.offlineResult).toBe('completed')
  expect(api.browser.clearProfileStorage).toHaveBeenCalledTimes(1)
})

it('discovers original unresolved operations after remount, without claiming complete disk accounting', async () => {
  const value = observation(), input = { profileId: first, expectedRevision: value.snapshot.profileRevision, operationId: 'original-after-restart', sites: value.snapshot.sites.map(({ origin, storageKeys }) => ({ origin, storageKeys })) }
  value.pending = [offlineReceipt(input, 'unknown')]
  value.snapshot.usage = { logicalBytes: 0, allocatedBytes: null, complete: false }
  value.snapshot.unattributed = { logicalBytes: 0, allocatedBytes: null, complete: false }
  value.snapshot.issues = ['The original storage binding is unavailable.']
  vi.mocked(api.browser.inspectProfileStorage).mockResolvedValue(value)
  await render()
  expect(node('[data-offline-size]').textContent).toBe('Unknown')
  expect(node('[data-offline-unattributed]').textContent).toContain('Unknown')
  expect(node('[data-offline-result]').dataset.offlineResult).toBe('unknown')
  await click('[data-offline-check-original]')
  expect(api.browser.inspectProfileStorage).toHaveBeenLastCalledWith(first, 'original-after-restart')
  expect(node('[data-offline-result]').dataset.offlineResult).toBe('unknown')
  expect(api.browser.clearProfileStorage).not.toHaveBeenCalled()
})

it('never uses another Profile receipt to settle this action and keeps late cleanup results with their original Profile', async () => {
  vi.mocked(api.browser.clearProfileStorage).mockImplementationOnce(async input => ({ ...offlineReceipt(input), profileId: second, before: null, after: null }))
  await render(); await click('[data-offline-clear-all]')
  expect(node('[data-offline-result]').dataset.offlineResult).toBe('unknown')
  let resolve!: (value: ReturnType<typeof offlineReceipt>) => void
  vi.mocked(api.browser.clearProfileStorage).mockImplementationOnce(input => new Promise(done => { resolve = value => done(value); input.sites.forEach(site => expect(site.storageKeys.length).toBeGreaterThan(0)) }))
  await click('[data-offline-clear-all]'); const input = vi.mocked(api.browser.clearProfileStorage).mock.calls[1]![0]
  await choose(second)
  await act(async () => resolve(offlineReceipt(input, 'cancelled')))
  expect(document.querySelector('[data-offline-result]')).toBeNull()
  await choose(first); expect(node('[data-offline-result]').dataset.offlineResult).toBe('cancelled')
})

it('keeps every local unresolved original operation when a newer cleanup starts and an older check returns late', async () => {
  vi.mocked(api.browser.clearProfileStorage).mockRejectedValue(new Error('Original response unknown'))
  await render(); await click('[data-offline-clear-all]')
  const firstInput = vi.mocked(api.browser.clearProfileStorage).mock.calls[0]![0]
  let resolve!: (value: BrowserProfileStorageInspect) => void
  vi.mocked(api.browser.inspectProfileStorage).mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await click('[data-offline-check-original]')
  await click('[data-offline-clear-all]')
  const latest = vi.mocked(api.browser.clearProfileStorage).mock.calls[1]![0]
  expect(node('[data-offline-result]').textContent).toContain(latest.operationId)
  expect(node(`[data-offline-earlier="${firstInput.operationId}"]`).textContent).toContain('Unconfirmed')
  await act(async () => resolve({ ...observation(), receipt: offlineReceipt(firstInput) }))
  expect(node('[data-offline-result]').dataset.offlineResult).toBe('unknown')
  expect(node('[data-offline-result]').textContent).toContain(latest.operationId)
  expect(node(`[data-offline-earlier="${firstInput.operationId}"]`).textContent).toContain('Request completed')
  expect(api.browser.clearProfileStorage).toHaveBeenCalledTimes(2)
})

it('keeps a confirmed terminal receipt when an older in-flight check of that same operation returns late', async () => {
  let finish!: (value: ReturnType<typeof offlineReceipt>) => void, inspect!: (value: BrowserProfileStorageInspect) => void
  vi.mocked(api.browser.clearProfileStorage).mockImplementationOnce(() => new Promise(done => { finish = done }))
  await render(); await click('[data-offline-clear-all]')
  const input = vi.mocked(api.browser.clearProfileStorage).mock.calls[0]![0]
  vi.mocked(api.browser.inspectProfileStorage).mockImplementationOnce(() => new Promise(done => { inspect = done }))
  await click('[data-offline-check-original]')
  await act(async () => finish(offlineReceipt(input)))
  await act(async () => inspect({ ...observation(), receipt: offlineReceipt(input, 'pending') }))
  expect(node('[data-offline-result]').dataset.offlineResult).toBe('completed')
  expect(api.browser.clearProfileStorage).toHaveBeenCalledTimes(1)
})
