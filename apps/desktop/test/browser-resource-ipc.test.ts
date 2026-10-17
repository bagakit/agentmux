import { expect, it, vi } from 'vitest'
import { registerBrowserResourceIpc } from '../src/main/browser-resource-ipc.js'

it('registers exact-source release and original-identity restore with the ordinary Main handle', async () => {
  const handlers = new Map<string, (...args: any[]) => any>()
  const receipt = { browserId: 'browser', navigationId: 'document', status: 'unknown' as const, reasons: ['close-unconfirmed' as const] }
  const release = vi.fn(async () => receipt), restore = vi.fn(async () => ({ id: 'browser' } as never))
  const workspace = vi.fn(value => { expect(value).toBe('workspace'); return 'workspace' })
  registerBrowserResourceIpc({handle: (channel, listener) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, listener) },
    browsers: {release, restore}, workspace})
  expect([...handlers.keys()]).toEqual(['browser:release', 'browser:restore'])
  expect(await handlers.get('browser:release')!('browser', 'document')).toBe(receipt)
  expect(release).toHaveBeenCalledExactlyOnceWith('browser', 'document')
  const input = {workspaceId: 'workspace', profileId: 'profile', mode: 'normal', viewport: 'tablet'}
  await handlers.get('browser:restore')!('browser', input)
  expect(restore).toHaveBeenCalledExactlyOnceWith('browser', input)
})
