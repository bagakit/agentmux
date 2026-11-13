import { describe, expect, it, vi } from 'vitest'
import { createBrowserProfileUsage } from '../src/main/browser-profile-usage.js'

const approval = { kind: 'user-confirmed', operation: 'delete-profile', scope: 'profile', profileId: 'profile-work' } as const

describe('Browser Profile deletion approval', () => {
  it('rechecks current open usage on every attempt and forwards the exact target approval only when unused', async () => {
    const open = vi.fn((_profileId: string) => [{ browserId: 'b-open', workspaceId: null, title: 'Board', url: 'https://example.test/' }])
    const deleteProfile = vi.fn(async () => {})
    const usage = createBrowserProfileUsage({ open, readSaved: async () => null, deleteProfile, clearPreviews: async () => ({ status: 'removed' }) })
    await expect(usage.deleteProfile('profile-work', approval)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_IN_USE' })
    expect(open).toHaveBeenCalledWith('profile-work')
    expect(deleteProfile).not.toHaveBeenCalled()
    open.mockReturnValue([])
    await usage.deleteProfile('profile-work', approval)
    expect(deleteProfile).toHaveBeenCalledExactlyOnceWith('profile-work', approval)
  })

  it('passes the approval through unchanged so the manager remains the one that validates it', async () => {
    const forged = { ...approval, profileId: 'profile-other' }
    const deleteProfile = vi.fn(async () => {})
    const usage = createBrowserProfileUsage({ open: () => [], readSaved: async () => null, deleteProfile, clearPreviews: async () => ({ status: 'removed' }) })
    await usage.deleteProfile('profile-work', forged)
    expect(deleteProfile).toHaveBeenCalledExactlyOnceWith('profile-work', forged)
  })
})
