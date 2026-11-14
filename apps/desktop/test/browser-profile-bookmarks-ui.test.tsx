// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserProfileBookmarkList, BrowserProfileBookmarkReceipt } from '@agentmux/core/control'
const ports = vi.hoisted(() => ({ listProfileBookmarks: vi.fn(), editProfileBookmark: vi.fn(), importProfileBookmarks: vi.fn(), exportProfileBookmarks: vi.fn(), openProfileBookmark: vi.fn(), listTargets: vi.fn(), onTargetsChanged: vi.fn(() => vi.fn()), chooseFiles: vi.fn(), chooseDirectory: vi.fn() }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { browser: ports, ui: ports } }))
import { BrowserProfileBookmarks } from '../src/renderer/src/components/settings/BrowserProfileBookmarks'
const profile = { id: 'exact-profile', label: 'Original Profile', revision: 'profile-r1', createdAt: 1, isDefault: false, source: null }
const exactUrl = 'https://reader.example.test/view?edition=2&chapter=4#original-heading'
const base: BrowserProfileBookmarkList = { profileId: profile.id, revision: 'library-r1', folderId: null, ancestors: [], folders: [{ id: 'folder-a', parentId: null, label: 'Research', revision: 'folder-r1' }], bookmarks: [{ id: 'bookmark-a', folderId: null, title: 'Original reading', url: exactUrl, revision: 'entry-r1' }], pending: [] }
const receipt = (operationId: string, kind: BrowserProfileBookmarkReceipt['kind'] = 'edit', extra = {}): BrowserProfileBookmarkReceipt => ({ operationId, kind, status: 'completed', expectedRevision: 'library-r1', createdIds: [], conflicts: [], ...extra })
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
beforeEach(() => {
  ports.listProfileBookmarks.mockImplementation(async (_p, folderId, operationId) => ({ ...base, folderId, ...(folderId ? { ancestors: base.folders, folders: [], bookmarks: [] } : {}), ...(operationId ? { receipt: null } : {}) }))
  ports.listTargets.mockResolvedValue({ coverage: 'complete', targets: [{ id: 'wrong-browser', title: 'Same label', profile: { id: 'other-profile' } }, { id: 'exact-browser', title: 'Same label', profile: { id: profile.id } }] })
  ports.editProfileBookmark.mockImplementation(async (profileId, _r, id, change) => ({ profileId, revision: 'library-r2', receipt: receipt(id, 'edit', { entryId: change.id ?? 'new-entry' }) }))
  ports.openProfileBookmark.mockImplementation(async (profileId, entryId, browserId, _r, id) => ({ profileId, revision: 'library-r1', receipt: receipt(id, 'open', { entryId, browserId, entryRevision: 'entry-r1' }) }))
  ports.chooseFiles.mockResolvedValue(['/private/bookmarks.html']); ports.chooseDirectory.mockResolvedValue('/private/export')
  ports.importProfileBookmarks.mockImplementation(async (profileId, folderId, _r, id) => ({ profileId, revision: 'library-r2', receipt: receipt(id, 'import', { folderId, createdIds: ['imported-a'], conflicts: [{ index: 2, reason: 'duplicate' }] }) }))
  ports.exportProfileBookmarks.mockImplementation(async (profileId, folderId, _r, id) => ({ profileId, revision: 'library-r1', receipt: receipt(id, 'export', { folderId }) }))
})
afterEach(() => { vi.clearAllMocks(); document.body.innerHTML = '' })
async function mount(active = true) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const render = async (nextActive: boolean) => { await act(async () => root.render(createElement(BrowserProfileBookmarks, { profile, active: nextActive }))) }
  await render(active)
  const button = (label: string) => { const b = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === label); expect(b, label).toBeDefined(); return b! }
  const click = async (label: string) => { await act(async () => button(label).click()) }
  const input = async (selector: string, value: string) => { await act(async () => { const field = host.querySelector<HTMLInputElement>(selector)!; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; setter.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })) }) }
  const select = async (value: string) => { await act(async () => { const field = host.querySelector<HTMLSelectElement>('select')!; field.value = value; field.dispatchEvent(new Event('change', { bubbles: true })) }) }
  return { host, root, render, button, click, input, select, close: async () => { await act(async () => root.unmount()); host.remove() } }
}
describe('original Profile bookmark Renderer consumer', () => {
  it('reads only expanded active sections and keeps the original draft across collapse and activation', async () => {
    const m = await mount(false)
    try {
      await m.click('› Bookmarks'); expect(ports.listProfileBookmarks).not.toHaveBeenCalled()
      await m.render(true); expect(ports.listProfileBookmarks).toHaveBeenCalledWith(profile.id, null, undefined)
      await m.click('New bookmark'); await m.input('form input', 'Keep my title')
      const calls = ports.listProfileBookmarks.mock.calls.length
      await m.render(false); expect(ports.onTargetsChanged.mock.results.at(-1)!.value).toHaveBeenCalledOnce()
      expect(ports.listProfileBookmarks).toHaveBeenCalledTimes(calls)
      await m.render(true); expect((m.host.querySelector('form input') as HTMLInputElement).value).toBe('Keep my title')
    } finally { await m.close() }
  })
  it('preserves the full query/hash address while updating an exact original entry with a frozen revision', async () => {
    const m = await mount()
    try {
      await m.click('› Bookmarks'); expect(m.host.textContent).toContain(exactUrl)
      await m.click('Edit')
      const address = m.host.querySelector<HTMLInputElement>('[aria-label="Bookmark address"]')!
      expect(address.value).toBe(exactUrl)
      await act(async () => address.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })))
      expect(m.host.querySelector('[aria-label="Bookmark address"]')).toBe(address)
      await m.input('form input', 'Revised reading')
      ports.listProfileBookmarks.mockResolvedValueOnce({ ...base, revision: 'library-later' })
      await m.click('Refresh library'); await m.click('Save')
      expect(ports.editProfileBookmark).toHaveBeenCalledWith(profile.id, 'library-r1', expect.any(String), { kind: 'save', id: 'bookmark-a', folderId: null, title: 'Revised reading' })
    } finally { await m.close() }
  })
  it('creates a bookmark with its complete entered address and exact folder', async () => {
    const m = await mount()
    try { await m.click('› Bookmarks'); await m.click('▸ResearchFolder'); await m.click('New bookmark'); await m.input('form input', 'Fresh reading'); await m.input('[aria-label="Bookmark address"]', exactUrl); await m.click('Save')
      expect(ports.editProfileBookmark).toHaveBeenCalledWith(profile.id, 'library-r1', expect.any(String), { kind: 'save', folderId: 'folder-a', title: 'Fresh reading', url: exactUrl })
    } finally { await m.close() }
  })
  it('keeps an unknown save’s original ID, blocks repeating that form and checks without a second mutation', async () => {
    ports.listProfileBookmarks.mockResolvedValue({ ...base, pending: [receipt('older-pending-id', 'open', { status: 'pending', entryId: 'older-entry', browserId: 'older-browser' })] })
    const m = await mount()
    try {
      await m.click('› Bookmarks'); await m.click('Edit'); ports.editProfileBookmark.mockRejectedValueOnce(new Error('ACK lost')); await m.click('Save')
      const id = ports.editProfileBookmark.mock.calls[0]![2]
      expect(m.host.textContent).toContain(id); expect(m.host.querySelector('.profile-bookmarks__receipt code')!.textContent).toBe(id); expect(m.host.querySelector('[role=alert]')!.compareDocumentPosition(m.host.querySelector('.profile-bookmarks__receipt')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); expect(m.button('Save').disabled).toBe(true)
      await m.click('Save'); expect(ports.editProfileBookmark).toHaveBeenCalledTimes(1)
      ports.listProfileBookmarks.mockResolvedValueOnce({ ...base, receipt: receipt(id, 'edit', { entryId: 'bookmark-a' }) }); await m.click('Check original operation')
      expect(ports.listProfileBookmarks).toHaveBeenLastCalledWith(profile.id, null, id)
      expect(ports.editProfileBookmark).toHaveBeenCalledTimes(1); expect(m.host.querySelector('form')).toBeNull()
    } finally { await m.close() }
  })
  it('keeps a known pre-dispatch refusal editable with a new ID only after an explicit corrected Save', async () => {
    const m = await mount()
    try { await m.click('› Bookmarks'); await m.click('Edit'); await m.input('[aria-label="Bookmark address"]', 'not a url')
      ports.editProfileBookmark.mockRejectedValueOnce(Object.assign(new Error('The address is invalid; no action was submitted.'), { code: 'BROWSER_PROFILE_BOOKMARK_REFUSED' }))
      await m.click('Save'); const id = ports.editProfileBookmark.mock.calls[0]![2]
      expect(m.host.textContent).toContain('Operation not submitted'); expect(m.host.querySelector('.profile-bookmarks__receipt code')!.textContent).toBe(id); expect(m.host.textContent).toContain(id)
      expect(m.button('Save').disabled).toBe(false); expect((m.host.querySelector('[aria-label="Bookmark address"]') as HTMLInputElement).value).toBe('not a url')
      expect(ports.editProfileBookmark).toHaveBeenCalledTimes(1)
      await m.input('[aria-label="Bookmark address"]', exactUrl); await m.click('Save')
      expect(ports.editProfileBookmark).toHaveBeenCalledTimes(2); expect(ports.editProfileBookmark.mock.calls[1]![2]).not.toBe(id)
    } finally { await m.close() }
  })
  it('rebases a refused revision only by explicit choice while retaining the person’s draft', async () => {
    const m = await mount()
    try { await m.click('› Bookmarks'); await m.click('Edit'); await m.input('form input', 'My revised title')
      ports.editProfileBookmark.mockRejectedValueOnce(Object.assign(new Error('The library revision changed.'), { code: 'BROWSER_PROFILE_BOOKMARK_REFUSED' })); await m.click('Save')
      ports.listProfileBookmarks.mockResolvedValueOnce({ ...base, revision: 'library-r3' }); await m.click('Refresh library')
      expect((m.host.querySelector('form input') as HTMLInputElement).value).toBe('My revised title')
      await m.click('Use current library revision'); await m.click('Save')
      expect(ports.editProfileBookmark).toHaveBeenLastCalledWith(profile.id, 'library-r3', expect.any(String), { kind: 'save', id: 'bookmark-a', folderId: null, title: 'My revised title' })
    } finally { await m.close() }
  })
  it('discovers original durable pending IDs on a fresh mount and keeps an absent receipt unknown', async () => {
    ports.listProfileBookmarks.mockResolvedValue({ ...base, pending: [receipt('saved-original-id', 'open', { status: 'pending', entryId: 'bookmark-a', browserId: 'exact-browser' })], receipt: null })
    const m = await mount()
    try { await m.click('› Bookmarks'); expect(m.host.textContent).toContain('saved-original-id'); await m.click('Check original operation'); expect(ports.listProfileBookmarks).toHaveBeenLastCalledWith(profile.id, null, 'saved-original-id'); expect(m.host.textContent).toContain('Original operation unconfirmed'); expect(ports.openProfileBookmark).not.toHaveBeenCalled() } finally { await m.close() }
  })
  it('opens only the explicitly chosen exact same-Profile Browser and reports request ACK separately from loading', async () => {
    const m = await mount()
    try {
      await m.click('› Bookmarks'); expect(m.host.querySelector('option[value="wrong-browser"]')).toBeNull()
      await m.click(`Original reading${exactUrl}`); expect(ports.openProfileBookmark).not.toHaveBeenCalled()
      await m.select('exact-browser'); await m.click(`Original reading${exactUrl}`)
      expect(ports.openProfileBookmark).toHaveBeenCalledWith(profile.id, 'bookmark-a', 'exact-browser', 'library-r1', expect.any(String))
      expect(m.host.textContent).toContain('Open request sent'); expect(m.host.textContent).not.toContain('Page loaded')
    } finally { await m.close() }
  })
  it('keeps a previously selected Browser visible when discovery no longer lists it and lets Main recheck the exact ID', async () => {
    const m = await mount()
    try { await m.click('› Bookmarks'); await m.select('exact-browser')
      ports.listTargets.mockResolvedValueOnce({ coverage: 'complete', targets: [] }); await m.click('Refresh Browsers')
      const selected = m.host.querySelector<HTMLSelectElement>('select')!
      expect(selected.value).toBe('exact-browser'); expect(selected.selectedOptions[0]!.textContent).toContain('Previously selected')
      await m.click(`Original reading${exactUrl}`); expect(ports.openProfileBookmark).toHaveBeenCalledWith(profile.id, 'bookmark-a', 'exact-browser', 'library-r1', expect.any(String))
    } finally { await m.close() }
  })
  it('rejects mismatched owner replies and keeps the old library and original operation available', async () => {
    const m = await mount()
    try { await m.click('› Bookmarks'); await m.click('Edit'); ports.editProfileBookmark.mockImplementationOnce(async (_p, _r, id) => ({ profileId: 'other-profile', revision: 'other', receipt: receipt(id) })); await m.click('Save'); expect(m.host.textContent).toContain('Original operation unconfirmed'); expect(m.host.textContent).toContain(exactUrl); expect(m.button('Save').disabled).toBe(true) } finally { await m.close() }
  })
  it('moves an entry by exact ID with the original revision and omits the address to preserve it', async () => {
    const m = await mount()
    try { await m.click('› Bookmarks'); const move = m.host.querySelectorAll<HTMLButtonElement>('.profile-bookmarks__list li')[1]!.querySelectorAll('button')[2]!; await act(async () => move.click()); await m.click('▸ResearchFolder'); await m.click('Move here'); expect(ports.editProfileBookmark).toHaveBeenCalledWith(profile.id, 'library-r1', expect.any(String), { kind: 'save', id: 'bookmark-a', folderId: 'folder-a', title: 'Original reading' }) } finally { await m.close() }
  })
  it('imports to the captured folder/revision, reports duplicate conflicts and exports a new explicit path', async () => {
    const m = await mount()
    try { await m.click('› Bookmarks'); await m.click('Import…'); expect(ports.importProfileBookmarks).toHaveBeenCalledWith(profile.id, null, 'library-r1', expect.any(String), '/private/bookmarks.html'); expect(m.host.textContent).toContain('Import entry 3: duplicate. Existing entries kept.'); await m.click('Export…'); await m.click('Choose destination folder…'); await m.click('Export new file'); expect(ports.exportProfileBookmarks).toHaveBeenCalledWith(profile.id, null, 'library-r1', expect.any(String), '/private/export/bookmarks.html'); expect(m.host.textContent).not.toContain('/private/export') } finally { await m.close() }
  })
  it('keeps an older pending export queryable while allowing an explicit new export in another folder', async () => {
    const pending = receipt('original-export-id', 'export', { status: 'pending', folderId: null })
    ports.listProfileBookmarks.mockImplementation(async (_p, folderId) => ({ ...base, folderId, pending: [pending], ...(folderId ? { ancestors: base.folders, folders: [], bookmarks: [] } : {}) }))
    const m = await mount()
    try { await m.click('› Bookmarks'); await m.click('▸ResearchFolder'); expect(m.button('Export…').disabled).toBe(false)
      await m.click('Export…'); await m.click('Choose destination folder…'); await m.click('Export new file')
      expect(ports.exportProfileBookmarks).toHaveBeenCalledWith(profile.id, 'folder-a', 'library-r1', expect.not.stringMatching(/^original-export-id$/), '/private/export/bookmarks.html')
      expect(m.host.textContent).toContain('original-export-id'); expect(m.host.textContent).toContain('Check original operation')
    } finally { await m.close() }
  })
  it('keeps a mismatched folder receipt unknown instead of accepting another export target', async () => {
    const m = await mount()
    try { await m.click('› Bookmarks'); await m.click('Export…'); await m.click('Choose destination folder…')
      ports.exportProfileBookmarks.mockImplementationOnce(async (profileId, _f, _r, operationId) => ({ profileId, revision: 'library-r1', receipt: receipt(operationId, 'export', { folderId: 'different-folder' }) }))
      await m.click('Export new file'); expect(m.host.textContent).toContain('Original operation unconfirmed'); expect(m.button('Export new file').disabled).toBe(true)
    } finally { await m.close() }
  })
  it('requires a visible exact-entry confirmation before removing and supports list keyboard movement', async () => {
    const m = await mount()
    try { await m.click('› Bookmarks'); const first = m.host.querySelector<HTMLButtonElement>('[data-bookmark-entry]')!; first.focus(); await act(async () => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))); expect(document.activeElement?.textContent).toContain('Original reading'); await m.click('Remove'); expect(ports.editProfileBookmark).not.toHaveBeenCalled(); expect(m.host.textContent).toContain('Remove “Original reading”?'); expect(document.activeElement).toBe(m.button('Cancel')); await act(async () => m.button('Cancel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); expect(m.host.querySelector('form')).toBeNull(); expect(ports.editProfileBookmark).not.toHaveBeenCalled(); await m.click('Remove'); await m.click('Remove bookmark'); expect(ports.editProfileBookmark).toHaveBeenCalledWith(profile.id, 'library-r1', expect.any(String), { kind: 'remove', id: 'bookmark-a' }) } finally { await m.close() }
  })
})
