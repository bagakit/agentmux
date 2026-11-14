// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
const ports = vi.hoisted(() => ({ readProfileTrash: vi.fn(), onProfilesChanged: vi.fn(() => () => {}), restoreProfile: vi.fn(), purgeProfile: vi.fn(), setProfileTrashRetention: vi.fn(), inspectProfilePurge: vi.fn(async () => null) }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { browser: ports } }))
vi.mock('../src/renderer/src/lib/browser-profiles', () => ({ browserProfiles: { refresh: vi.fn(async () => {}) } }))
import { BrowserProfileTrash } from '../src/renderer/src/components/settings/BrowserProfileTrash'
import { BROWSER_PROFILE_RESULT_METHODS, ipcResult, unwrapIpcResultMethods } from '../src/shared/ipc-result'

const entry = { id: 'original-archive', revision: 'archive-token', archivedAt: 1, dataOwner: 'original-partition' as const,
  profile: { id: 'original-profile', label: 'Original Profile', revision: 'profile-token', createdAt: 1, isDefault: false, source: null } }
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })
async function mount(entries = [entry]) {
  ports.readProfileTrash.mockResolvedValue({ revision: 1, sequence: 1, entries, legacyPendingDeletes: [] })
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  await act(async () => root.render(createElement(BrowserProfileTrash, { active: true, folders: [], onBack: vi.fn(), onRestored: vi.fn() })))
  const button = (label: string) => { const result = [...host.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === label); expect(result, label).toBeDefined(); return result! }
  return { host, button, close: async () => { await act(async () => root.unmount()); host.remove() } }
}
describe('retention and permanent deletion in the original Recycled Profiles component', () => {
  it('keeps existing entries indefinite and requires an exact-target confirmation before calling permanent deletion', async () => {
    const m = await mount()
    try {
      expect(m.host.textContent).toContain('Kept until you choose to delete it.')
      await act(async () => m.button('Delete permanently').click())
      expect(ports.purgeProfile).not.toHaveBeenCalled()
      expect(m.host.querySelector('[role="alertdialog"]')?.textContent).toContain('Delete Original Profile permanently?')
      expect(document.activeElement).toBe(m.button('Cancel'))
      await act(async () => m.button('Cancel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      expect(m.host.querySelector('[role="alertdialog"]')).toBeNull()
      expect(document.activeElement).toBe(m.button('Delete permanently'))
      await act(async () => m.button('Delete permanently').click())
      await act(async () => m.button('Confirm permanent deletion').click())
      expect(ports.purgeProfile).toHaveBeenCalledExactlyOnceWith(entry.id, entry.revision, expect.any(String))
      expect(ports.setProfileTrashRetention).not.toHaveBeenCalled()
    } finally { await m.close() }
  })
  it('approves one explicit future expiry while keeping Restore available', async () => {
    const m = await mount()
    try {
      const before = Date.now()
      await act(async () => m.button('Approve expiry').click())
      expect(ports.setProfileTrashRetention).not.toHaveBeenCalled()
      expect(m.button('Restore Original Profile').disabled).toBe(false)
      await act(async () => m.button('Confirm retention deadline').click())
      expect(ports.setProfileTrashRetention).toHaveBeenCalledExactlyOnceWith(entry.id, entry.revision, expect.any(String), expect.any(Number))
      expect(ports.setProfileTrashRetention.mock.calls[0]![3]).toBeGreaterThanOrEqual(before + 7 * 86_400_000)
    } finally { await m.close() }
  })
  it('checks the same original purge ID after a lost reply and never automatically repeats deletion', async () => {
    ports.purgeProfile.mockRejectedValueOnce(new Error('Original acknowledgement unavailable'))
    const m = await mount()
    try {
      await act(async () => m.button('Delete permanently').click())
      await act(async () => m.button('Confirm permanent deletion').click())
      const id = ports.purgeProfile.mock.calls[0]![2]
      expect(m.host.textContent).toContain('Original acknowledgement unavailable')
      expect([...m.host.querySelectorAll('button')].some(button => button.textContent === 'Confirm permanent deletion')).toBe(false)
      expect(m.button('Close confirmation')).toBeDefined()
      await act(async () => m.button('Check original action').click())
      expect(ports.inspectProfilePurge).toHaveBeenCalledExactlyOnceWith(id)
      expect(ports.purgeProfile).toHaveBeenCalledOnce()
    } finally { await m.close() }
  })
  it('retains the original action for inspection when another confirmed event already removed its entry after a lost reply', async () => {
    ports.purgeProfile.mockRejectedValueOnce(new Error('Original acknowledgement unavailable'))
    const m = await mount()
    try {
      await act(async () => m.button('Delete permanently').click())
      await act(async () => m.button('Confirm permanent deletion').click())
      const purgeId = ports.purgeProfile.mock.calls[0]![2]
      ports.readProfileTrash.mockResolvedValueOnce({ revision: 2, sequence: 2, entries: [], legacyPendingDeletes: [] })
      await act(async () => (ports.onProfilesChanged.mock.calls[0] as unknown as [() => void])[0]())
      expect(m.host.textContent).toContain('No recycled Profiles.')
      expect(m.host.querySelector('[role="alertdialog"]')?.textContent).toContain(purgeId)
      await act(async () => m.button('Check original action').click())
      expect(ports.inspectProfilePurge).toHaveBeenCalledExactlyOnceWith(purgeId)
      expect(ports.purgeProfile).toHaveBeenCalledOnce()
    } finally { await m.close() }
  })
  it('checks the original retained deadline after its approval reply is lost without resending approval', async () => {
    ports.setProfileTrashRetention.mockRejectedValueOnce(new Error('Deadline acknowledgement unavailable'))
    const m = await mount()
    try {
      await act(async () => m.button('Approve expiry').click())
      await act(async () => m.button('Confirm retention deadline').click())
      const [, , purgeId, deleteAfter] = ports.setProfileTrashRetention.mock.calls[0]!
      ports.readProfileTrash.mockResolvedValue({ revision: 2, sequence: 2, entries: [{ ...entry, revision: 'saved-policy-token', retention: { purgeId, deleteAfter, approvedAt: Date.now() } }], legacyPendingDeletes: [] })
      await act(async () => m.button('Check original action').click())
      expect(ports.setProfileTrashRetention).toHaveBeenCalledOnce()
      expect(ports.inspectProfilePurge).not.toHaveBeenCalled()
      expect(m.host.querySelector('[role="alertdialog"]')).toBeNull()
      expect(m.host.textContent).toContain('days remaining')
    } finally { await m.close() }
  })
  it('shows independent cleanup outcomes from the exact completed receipt instead of hiding an unknown credential result', async () => {
    ports.purgeProfile.mockResolvedValueOnce({ revision: 2, purge: { purgeId: 'exact-completed-action', status: 'deleted', credentialCleanup: 'unknown', permissionCleanup: 'confirmed' } })
    const m = await mount()
    try {
      await act(async () => m.button('Delete permanently').click())
      await act(async () => m.button('Confirm permanent deletion').click())
      expect(m.host.textContent).toContain('Profile data and saved settings removed')
      expect(m.host.textContent).toContain('Credential cleanup: unknown')
      expect(m.host.textContent).toContain('Site permission cleanup: confirmed')
      expect(m.host.textContent).toContain('exact-completed-action')
    } finally { await m.close() }
  })
  it('unwraps the real IPC result envelope for all three added methods, including null inspection and meaningful failures', async () => {
    for (const method of ['purgeProfile', 'setProfileTrashRetention', 'inspectProfilePurge']) expect(BROWSER_PROFILE_RESULT_METHODS).toContain(method)
    const api = unwrapIpcResultMethods({ purgeProfile: async () => ipcResult(async () => ({ purge: { purgeId: 'original' } })),
      setProfileTrashRetention: async () => ipcResult(async () => { throw Object.assign(new Error('Exact source unavailable'), { code: 'BROWSER_PROFILE_DATA_UNAVAILABLE' }) }),
      inspectProfilePurge: async () => ipcResult(async () => null) }, BROWSER_PROFILE_RESULT_METHODS.filter(method => ['purgeProfile', 'setProfileTrashRetention', 'inspectProfilePurge'].includes(method)) as ('purgeProfile' | 'setProfileTrashRetention' | 'inspectProfilePurge')[])
    expect(await api.purgeProfile()).toEqual({ purge: { purgeId: 'original' } })
    await expect(api.setProfileTrashRetention()).rejects.toMatchObject({ message: 'Exact source unavailable', code: 'BROWSER_PROFILE_DATA_UNAVAILABLE' })
    expect(await api.inspectProfilePurge()).toBeNull()
  })
})
