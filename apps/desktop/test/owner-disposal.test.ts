import { describe, expect, it, vi } from 'vitest'
import { runOwnerDisposals } from '../src/main/owner-disposal.js'

describe('runOwnerDisposals', () => {
  it('runs every owner in order and reports failures after later async cleanup settles', async () => {
    const calls: string[] = []
    let release!: () => void
    const laterCleanup = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve
    }))

    let settled = false
    const disposal = runOwnerDisposals([
      { owner: 'focus', dispose: () => {
        calls.push('focus')
        throw new Error('focus cleanup failed')
      } },
      { owner: 'files', dispose: async () => {
        calls.push('files')
        await laterCleanup()
      } },
      { owner: 'handlers', dispose: () => {
        calls.push('handlers')
      } }
    ], 'Desktop cleanup failed').finally(() => {
      settled = true
    })

    await vi.waitFor(() => expect(laterCleanup).toHaveBeenCalledTimes(1))
    expect(settled).toBe(false)
    release()

    await expect(disposal).rejects.toMatchObject({
      message: 'Desktop cleanup failed',
      errors: [expect.objectContaining({ message: 'Owner focus disposal failed', cause: expect.objectContaining({ message: 'focus cleanup failed' }) })]
    })
    expect(calls).toEqual(['focus', 'files', 'handlers'])
  })
})
