// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserProfileCookieFiles } from '../src/renderer/src/components/settings/BrowserProfileCookieFiles'
import type { BrowserProfileSummary } from '../src/shared/contracts'
import type { BrowserProfileCookieFileReceipt as Receipt, BrowserProfileCookieScope as Scope } from '@agentmux/core/control'
const ports = vi.hoisted(() => Object.fromEntries(['prepareProfileCookieImport','importProfileCookies','exportProfileCookies','inspectProfileCookieFiles','discardProfileCookieImport','revealProfileCookieFile','listProfileSites','chooseFiles','chooseDirectory'].map(name => [name, vi.fn()])))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { browser: ports, ui: ports } }))
const profile = { id: 'profile-a', label: 'Personal', createdAt: 1 } as BrowserProfileSummary
const counts = { total: 3, applied: 1, skipped: 1, rejected: 1, unknown: 0, notAttempted: 0 }
const receipt = (operationId: string, kind: Receipt['kind'] = 'import', extra: Partial<Receipt> = {}): Receipt => ({ operationId, profileId: profile.id, kind, scope: { kind: 'profile' }, status: 'partial', counts, ...(kind === 'export' ? { fileOutcome: 'written' as const } : {}), ...extra })
const inspection = (extra = {}) => ({ profileId: profile.id, pending: [], recent: [], items: [], offset: 0, nextOffset: null, ...extra })
beforeEach(() => {
  vi.resetAllMocks(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ports.inspectProfileCookieFiles.mockResolvedValue(inspection())
  ports.listProfileSites.mockResolvedValue([{ site: 'example.test', cookies: 2 }, { site: 'reference.test', cookies: 1 }])
  ports.chooseFiles.mockResolvedValue(['/private/sensitive-source.json']); ports.chooseDirectory.mockResolvedValue('/private/export-folder')
  ports.prepareProfileCookieImport.mockImplementation(async (profileId, operationId, _source, scope) => ({ reviewId: operationId, profileId, scope, total: 3, valid: 2, skipped: 1, sites: ['example.test'], sourceKind: 'local' }))
  ports.importProfileCookies.mockImplementation(async (_p, id) => receipt(id))
  ports.exportProfileCookies.mockImplementation(async (_p, id, _destination, scope) => receipt(id, 'export', { scope }))
  ports.discardProfileCookieImport.mockImplementation(async (profileId, reviewId) => ({ profileId, reviewId, discarded: true }))
  ports.revealProfileCookieFile.mockImplementation(async (profileId, operationId) => ({ profileId, operationId, revealed: true }))
})
afterEach(() => { document.body.innerHTML = '' })
async function mount(active = true) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const render = async (nextProfile = profile, nextActive = true) => { await act(async () => root.render(createElement(BrowserProfileCookieFiles, { profile: nextProfile, active: nextActive }))) }
  await render(profile, active)
  const button = (label: string) => { const b = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === label); expect(b, label).toBeDefined(); return b! }
  const click = async (label: string) => { await act(async () => button(label).click()) }
  const select = async (value: Scope['kind']) => { await act(async () => { const field = host.querySelector<HTMLSelectElement>('select')!; field.value = value; field.dispatchEvent(new Event('change', { bubbles: true })) }) }
  const input = async (value: string) => { await act(async () => { const field = host.querySelector<HTMLInputElement>('[aria-label="Cookie export file name"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) }) }
  return { host, root, render, button, click, select, input, open: () => click('› Cookie file exchange'), close: async () => { await act(async () => root.unmount()); host.remove() } }
}
describe('production Profile Cookie file consumer', () => {
  it('reads only while expanded and active and retains explicit scope choices across hiding', async () => {
    const m = await mount(false)
    try { await m.open(); expect(ports.inspectProfileCookieFiles).not.toHaveBeenCalled(); await m.render(profile, true); expect(ports.inspectProfileCookieFiles).toHaveBeenCalledWith(profile.id, undefined, undefined, undefined)
      await m.click('Import…'); expect(m.button('Choose file and review…').disabled).toBe(true); expect(document.activeElement).toBe(m.button('Cancel')); await m.select('profile'); await m.render(profile, false); const n = ports.inspectProfileCookieFiles.mock.calls.length; await m.render(profile, false); expect(ports.inspectProfileCookieFiles).toHaveBeenCalledTimes(n); await m.render(profile, true); expect(m.host.querySelector('select')!.value).toBe('profile')
    } finally { await m.close() }
  })
  it('prepares safe facts then imports only by original review ID through native owner confirmation', async () => {
    const m = await mount()
    try { await m.open(); await m.click('Import…'); await m.select('sites'); const checkbox = m.host.querySelector<HTMLInputElement>('input[type=checkbox]')!; await act(async () => checkbox.click()); await m.click('Choose file and review…')
      const [id, operationId, source, scope] = ports.prepareProfileCookieImport.mock.calls[0]!
      expect([id, source, scope]).toEqual([profile.id, { kind: 'local', path: '/private/sensitive-source.json' }, { kind: 'sites', sites: ['example.test'] }]); expect(ports.importProfileCookies).not.toHaveBeenCalled(); expect(m.host.textContent).toContain('2 eligible · 1 skipped'); expect(m.host.textContent).not.toContain('sensitive-source'); ports.importProfileCookies.mockResolvedValueOnce(receipt(operationId, 'import', { scope }))
      await m.click('Continue to native confirmation…'); expect(ports.importProfileCookies).toHaveBeenCalledWith(profile.id, operationId); expect(m.host.textContent).toContain('Partially completed'); expect(m.host.textContent).toContain('1 applied'); expect(m.host.textContent).not.toContain('authenticated')
    } finally { await m.close() }
  })
  it('keeps the exact original ID locked after lost ACK or ALREADY_ADMITTED and checks without reissuing', async () => {
    const m = await mount()
    try {
      await m.open(); await m.click('Export…')
      const name = m.host.querySelector<HTMLInputElement>('[aria-label="Cookie export file name"]')!
      await act(async () => name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })))
      expect(m.host.querySelector('[aria-label="Cookie export file name"]')).toBe(name)
      await m.select('profile'); await m.click('Choose destination folder…'); ports.exportProfileCookies.mockRejectedValueOnce(Object.assign(new Error('lost acknowledgement'), { code: 'BROWSER_PROFILE_COOKIE_FILE_ALREADY_ADMITTED' })); await m.click('Continue to native confirmation…')
      const id = ports.exportProfileCookies.mock.calls[0]![1]; expect(m.host.textContent).toContain(id); expect(m.button('Continue to native confirmation…').disabled).toBe(true); expect(m.host.querySelector('form [role=alert]')).not.toBeNull(); expect(m.host.textContent).not.toContain('/private/export-folder'); await m.click('Continue to native confirmation…'); expect(ports.exportProfileCookies).toHaveBeenCalledTimes(1)
      ports.inspectProfileCookieFiles.mockResolvedValueOnce(inspection({ receipt: null })); await m.click('Check original operation'); expect(ports.inspectProfileCookieFiles).toHaveBeenLastCalledWith(profile.id, id, 0, 24); expect(m.button('Continue to native confirmation…').disabled).toBe(true)
      ports.inspectProfileCookieFiles.mockResolvedValueOnce(inspection({ receipt: receipt(id, 'export', { scope: { kind: 'sites', sites: ['wrong.test'] } }) })); await m.click('Check original operation'); expect(m.host.textContent).not.toContain('wrong.test'); expect(m.button('Continue to native confirmation…').disabled).toBe(true)
      ports.inspectProfileCookieFiles.mockResolvedValueOnce(inspection({ receipt: receipt(id, 'export') })); await m.click('Check original operation'); expect(m.host.querySelector('form')).toBeNull(); expect(m.host.textContent).toContain('Export file written.'); expect(ports.exportProfileCookies).toHaveBeenCalledTimes(1)
    } finally { await m.close() }
  })
  it('keeps a returned pending operation visible by the form after a successful read still cannot find its receipt', async () => {
    ports.exportProfileCookies.mockImplementationOnce(async (_p, id) => receipt(id, 'export', { status: 'pending', fileOutcome: 'unknown', counts: { total: 3, applied: 0, skipped: 0, rejected: 0, unknown: 3, notAttempted: 0 } })); const m = await mount()
    try { await m.open(); await m.click('Export…'); await m.select('profile'); await m.click('Choose destination folder…'); await m.click('Continue to native confirmation…'); expect(m.host.querySelector('form [role=alert]')!.textContent).toContain('No action is repeated automatically'); ports.inspectProfileCookieFiles.mockResolvedValueOnce(inspection({ receipt: null })); await m.click('Check original operation'); expect(m.host.querySelector('form [role=alert]')!.textContent).toContain('No action is repeated automatically'); expect(ports.exportProfileCookies).toHaveBeenCalledTimes(1) } finally { await m.close() }
  })
  it('keeps only a definite pre-admission refusal editable and mints a replacement ID on explicit corrected submission', async () => {
    const m = await mount()
    try { await m.open(); await m.click('Export…'); await m.select('profile'); await m.click('Choose destination folder…'); ports.exportProfileCookies.mockRejectedValueOnce(Object.assign(new Error('safe refusal'), { code: 'BROWSER_PROFILE_COOKIE_FILE_REFUSED' })); await m.click('Continue to native confirmation…'); const id = ports.exportProfileCookies.mock.calls[0]![1]
      expect(m.host.textContent).toContain('Operation not submitted'); expect(m.button('Continue to native confirmation…').disabled).toBe(false); expect(m.host.querySelector('select')!.value).toBe('profile'); await m.input('corrected.json'); await m.click('Continue to native confirmation…'); expect(ports.exportProfileCookies).toHaveBeenCalledTimes(2); expect(ports.exportProfileCookies.mock.calls[1]![1]).not.toBe(id); expect(ports.exportProfileCookies.mock.calls[1]![2]).toEqual({ kind: 'local', path: '/private/export-folder/corrected.json' })
    } finally { await m.close() }
  })
  it('discovers pending and recent owner receipts, paginates safe source indexes and reveals the original export', async () => {
    const pending = receipt('durable-original', 'export', { status: 'pending', fileOutcome: 'unknown', counts: { total: 3, applied: 0, skipped: 0, rejected: 0, unknown: 3, notAttempted: 0 } }); ports.inspectProfileCookieFiles.mockResolvedValue(inspection({ pending: [pending], recent: [receipt('older-done')] }))
    const m = await mount()
    try { await m.open(); expect(m.host.textContent).toContain('durable-original'); expect(m.host.textContent).toContain('older-done'); ports.inspectProfileCookieFiles.mockResolvedValueOnce(inspection({ receipt: pending, items: [{ index: 0, status: 'unknown', reason: 'native-unconfirmed' }], nextOffset: 1 })); await act(async () => m.host.querySelector<HTMLButtonElement>('[data-cookie-check="durable-original"]')!.click()); expect(m.host.textContent).toContain('Entry 1: unknown'); ports.inspectProfileCookieFiles.mockResolvedValueOnce(inspection({ receipt: pending, offset: 1, items: [{ index: 1, status: 'skipped', reason: 'expired' }], nextOffset: null })); await m.click('Read more entry outcomes'); expect(ports.inspectProfileCookieFiles).toHaveBeenLastCalledWith(profile.id, 'durable-original', 1, 24); expect(m.host.textContent).toContain('Entry 1: unknown'); expect(m.host.textContent).toContain('Entry 2: skipped'); await m.click('Reveal original export location'); expect(ports.revealProfileCookieFile).toHaveBeenCalledWith(profile.id, 'durable-original'); expect(ports.exportProfileCookies).not.toHaveBeenCalled()
    } finally { await m.close() }
  })
  it('a general owner refresh replaces an earlier refusal when that same original ID later has an authoritative receipt', async () => {
    const m=await mount()
    try{await m.open();await m.click('Export…');await m.select('profile');await m.click('Choose destination folder…');ports.exportProfileCookies.mockRejectedValueOnce(Object.assign(new Error('safe refusal'),{code:'BROWSER_PROFILE_COOKIE_FILE_REFUSED'}));await m.click('Continue to native confirmation…');const id=ports.exportProfileCookies.mock.calls[0]![1];expect(m.host.textContent).toContain('Operation not submitted');await m.click('Cancel');ports.inspectProfileCookieFiles.mockResolvedValueOnce(inspection({recent:[receipt(id,'export')]}));await m.click('Read receipts');expect(m.host.textContent).not.toContain('Operation not submitted');expect(m.host.textContent).toContain('Partially completed');expect(m.host.textContent).toContain('Export file written.');expect(ports.exportProfileCookies).toHaveBeenCalledTimes(1)}finally{await m.close()}
  })
  it('retains full Profile capability when site discovery fails and discards only a prepared import on Escape', async () => {
    ports.listProfileSites.mockRejectedValue(new Error('observation unavailable')); const m = await mount()
    try { await m.open(); await m.click('Import…'); await m.select('sites'); expect(m.host.textContent).toContain('Site names could not be read'); await m.select('profile'); await m.click('Choose file and review…'); const id = ports.prepareProfileCookieImport.mock.calls[0]![1]; await act(async () => m.button('Cancel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); expect(ports.discardProfileCookieImport).toHaveBeenCalledWith(profile.id, id); expect(ports.importProfileCookies).not.toHaveBeenCalled(); expect(m.host.querySelector('form')).toBeNull()
    } finally { await m.close() }
  })
  it('rejects wrong Profile or scope facts and keeps the original operation available', async () => {
    const m = await mount()
    try { await m.open(); await m.click('Export…'); await m.select('profile'); await m.click('Choose destination folder…'); ports.exportProfileCookies.mockImplementationOnce(async (_p, id) => receipt(id, 'export', { profileId: 'wrong-profile' })); await m.click('Continue to native confirmation…'); expect(m.host.textContent).toContain('Original operation unconfirmed'); expect(m.host.textContent).not.toContain('Cookie export completed'); expect(m.button('Continue to native confirmation…').disabled).toBe(true)
    } finally { await m.close() }
  })
  it('keeps a mismatched import scope unconfirmed against the captured review scope', async () => {
    const m = await mount()
    try { await m.open(); await m.click('Import…'); await m.select('profile'); await m.click('Choose file and review…'); ports.importProfileCookies.mockImplementationOnce(async (_p, id) => receipt(id, 'import', { scope: { kind: 'sites', sites: ['other.test'] } })); await m.click('Continue to native confirmation…'); expect(m.host.textContent).toContain('Original operation unconfirmed'); expect(m.button('Continue to native confirmation…').disabled).toBe(true); expect(m.host.textContent).not.toContain('other.test') } finally { await m.close() }
  })
  it.each([
    { status: 'completed', fileOutcome: undefined },
    { status: 'completed', fileOutcome: 'unknown' },
    { status: 'completed', fileOutcome: 'written' },
    { status: 'partial', fileOutcome: 'not-written' },
    { status: 'partial', fileOutcome: 'written', counts: {total:3,applied:1,skipped:1,rejected:0,unknown:1,notAttempted:0} },
    { status: 'cancelled', fileOutcome: 'not-written' }
  ] as const)('keeps contradictory export DTO %j unconfirmed without presenting completion', async extra => {
    ports.exportProfileCookies.mockImplementationOnce(async (_p, id) => receipt(id, 'export', extra)); const m = await mount()
    try { await m.open(); await m.click('Export…'); await m.select('profile'); await m.click('Choose destination folder…'); await m.click('Continue to native confirmation…'); expect(m.host.textContent).toContain('Original operation unconfirmed'); expect(m.host.textContent).not.toContain('Cookie export completed'); expect(m.host.textContent).not.toContain('Export file written.'); expect(m.button('Continue to native confirmation…').disabled).toBe(true) } finally { await m.close() }
  })
  it('never applies a late dialog or operation result to a different Profile generation', async () => {
    let resolveDialog!: (paths: string[]) => void; ports.chooseFiles.mockImplementationOnce(() => new Promise(resolve => { resolveDialog = resolve })); const m = await mount()
    try { await m.open(); await m.click('Import…'); await m.select('profile'); await m.click('Choose file and review…'); await m.render({ ...profile, id: 'profile-b', label: 'Work' }); await act(async () => resolveDialog(['/private/old.json'])); expect(ports.prepareProfileCookieImport).not.toHaveBeenCalled(); expect(m.host.textContent).not.toContain('Personal'); expect(m.host.querySelector('form')).toBeNull()
      let resolveExport!: (value: Receipt) => void; ports.inspectProfileCookieFiles.mockResolvedValue(inspection({ profileId: 'profile-b' })); await m.click('Export…'); await m.select('profile'); await m.click('Choose destination folder…'); ports.exportProfileCookies.mockImplementationOnce(() => new Promise(resolve => { resolveExport = resolve })); await m.click('Continue to native confirmation…'); const oldId = ports.exportProfileCookies.mock.calls[0]![1]; await m.render({ ...profile, id: 'profile-c', label: 'Third' }); await act(async () => resolveExport(receipt(oldId, 'export', { profileId: 'profile-b' }))); expect(m.host.textContent).not.toContain(oldId); expect(m.host.textContent).not.toContain('Export file written.')
    } finally { await m.close() }
  })
  it('reports a failed export with a written empty file honestly and keeps safe native counts', async () => {
    ports.exportProfileCookies.mockImplementationOnce(async (_p, id) => receipt(id, 'export', { status: 'failed', fileOutcome: 'written', counts: { total: 1, applied: 0, skipped: 0, rejected: 1, unknown: 0, notAttempted: 0 } })); const m = await mount()
    try { await m.open(); await m.click('Export…'); await m.select('profile'); await m.click('Choose destination folder…'); await m.click('Continue to native confirmation…'); expect(m.host.textContent).toContain('Operation failed'); expect(m.host.textContent).toContain('Export file written.'); expect(m.host.textContent).toContain('1 rejected'); expect(m.host.textContent).not.toContain('not written') } finally { await m.close() }
  })
})
