import { describe, expect, it, vi } from 'vitest'
import type { BrowserNetworkSession } from '../../../packages/browser/src/browser-page-transport.js'
import { openBrowserHarCapture } from '../../../packages/browser/src/browser-har-capture.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => { resolve = finish })
  return { promise, resolve }
}
function network() {
  const releaseObserver = vi.fn()
  const native = { sendCommand: vi.fn(async () => ({})), observe: vi.fn(() => releaseObserver),
    endedReason: null, close: vi.fn(async () => {}) } satisfies BrowserNetworkSession
  return { native, releaseObserver }
}

describe('the original HAR recording lease', () => {
  it('closes a late attach without enabling native network events', async () => {
    const opening = deferred<BrowserNetworkSession>(), signal = new AbortController()
    const { native, releaseObserver } = network()
    const started = openBrowserHarCapture(() => opening.promise, signal.signal)
    signal.abort()
    opening.resolve(native)
    await expect(started).rejects.toMatchObject({ name: 'AbortError' })
    expect(native.sendCommand).not.toHaveBeenCalled()
    expect(releaseObserver).toHaveBeenCalledOnce()
    expect(native.close).toHaveBeenCalledOnce()
  })

  it('releases the lease while the original enable acknowledgement is pending', async () => {
    const acknowledgement = deferred<object>(), signal = new AbortController()
    const { native, releaseObserver } = network()
    native.sendCommand.mockReturnValueOnce(acknowledgement.promise)
    const started = openBrowserHarCapture(async () => native, signal.signal)
    await vi.waitFor(() => expect(native.sendCommand).toHaveBeenCalledWith('Network.enable'))
    signal.abort()
    expect(releaseObserver).toHaveBeenCalledOnce()
    expect(native.close).toHaveBeenCalledOnce()
    acknowledgement.resolve({})
    await expect(started).rejects.toMatchObject({ name: 'AbortError' })
    expect(native.close).toHaveBeenCalledOnce()
  })
})
