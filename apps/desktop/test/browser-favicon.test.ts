import { fixtureFileUrl as _hygiene_fixtureFileUrl } from "../scripts/lib/fixture-values.mjs"
import { expect, it, vi } from 'vitest'
import { BROWSER_FAVICON_MAX_BYTES, BROWSER_FAVICON_TIMEOUT_MS, readBrowserFavicon } from '../src/main/browser-favicon.js'

it('bounds optional artwork by image type, status and streamed bytes without rejecting the page', async () => {
  for (const response of [new Response('<html/>', { headers: { 'content-type': 'text/html' } }), new Response('', { status: 404, headers: { 'content-type': 'image/png' } }), new Response(new Uint8Array(BROWSER_FAVICON_MAX_BYTES + 1), { headers: { 'content-type': 'image/png' } })]) {
    const fetch = vi.fn().mockResolvedValue(response)
    expect(await readBrowserFavicon({ fetch }, 'https://page.example/icon', new AbortController().signal)).toBeUndefined()
  }
  const fetch = vi.fn()
  expect(await readBrowserFavicon({ fetch }, _hygiene_fixtureFileUrl("private/data"), new AbortController().signal)).toBeUndefined()
  expect(fetch).not.toHaveBeenCalled()
})

it('ends slow optional artwork observation and aborts its original session request', async () => {
  vi.useFakeTimers()
  try {
    const fetch = vi.fn().mockReturnValue(new Promise(() => {}))
    const result = readBrowserFavicon({ fetch }, 'https://page.example/slow', new AbortController().signal)
    await vi.advanceTimersByTimeAsync(BROWSER_FAVICON_TIMEOUT_MS)
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true)
    expect(await result).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
