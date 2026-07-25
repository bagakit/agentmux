import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  openExternal: vi.fn(async () => {})
}))

vi.mock('electron', () => ({
  clipboard: {},
  dialog: {},
  ipcMain: {},
  nativeImage: {},
  shell: { openExternal: electron.openExternal },
  WebContentsView: class {},
  BrowserWindow: class {}
}))

import { normalizeExternalUrl } from '../src/main/external-url.js'
import { openExternalFromRenderer } from '../src/main/ipc.js'

beforeEach(() => {
  electron.openExternal.mockClear()
})

describe('Main-owned external URL boundary', () => {
  it('allows only browser HTTP protocols', () => {
    expect(normalizeExternalUrl('https://example.com/docs')).toBe('https://example.com/docs')
    expect(normalizeExternalUrl('http://localhost:3000/')).toBe('http://localhost:3000/')
  })

  it.each([
    'file:///tmp/secret',
    'javascript:alert(1)',
    'data:text/html,unsafe'
  ])('rejects %s', (url) => {
    expect(() => normalizeExternalUrl(url)).toThrow('protocol is not allowed')
  })

  it('opens a validated URL only for the exact Desktop renderer', async () => {
    const renderer = { id: 7 }

    await openExternalFromRenderer(
      { sender: renderer } as never,
      renderer as never,
      'https://example.com/docs'
    )

    expect(electron.openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/docs')
  })

  it('rejects an untrusted sender before opening', async () => {
    await expect(openExternalFromRenderer(
      { sender: { id: 8 } } as never,
      { id: 7 } as never,
      'https://example.com/docs'
    )).rejects.toThrow('Untrusted external URL sender')

    expect(electron.openExternal).not.toHaveBeenCalled()
  })

  it('rejects a disallowed scheme before opening', async () => {
    const renderer = { id: 7 }

    await expect(openExternalFromRenderer(
      { sender: renderer } as never,
      renderer as never,
      'file:///tmp/secret'
    )).rejects.toThrow('protocol is not allowed')

    expect(electron.openExternal).not.toHaveBeenCalled()
  })
})
