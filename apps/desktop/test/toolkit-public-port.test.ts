import { expect, it, vi } from 'vitest'
import { desktopToolkitPublicPort } from './helpers/desktop-toolkit-public-port.js'

it.each([undefined, { captureFailure: true as const }, { includeFailureEvidence: true as const },
  { captureFailure: true as const, includeFailureEvidence: true as const }])('actual Desktop public adapter preserves %j', async options => {
  const lease = { dispose: vi.fn() }, subscribe = vi.fn(async () => lease)
  const port = desktopToolkitPublicPort({ execute: vi.fn(), subscribe })
  const onSnapshot = vi.fn(), onEnd = vi.fn(), signal = new AbortController().signal
  expect(await port.subscribe('performance', onSnapshot, onEnd, signal, options)).toBe(lease)
  expect(subscribe).toHaveBeenCalledOnce()
  const forwarded = subscribe.mock.calls[0] as unknown as unknown[]
  expect(forwarded.slice(0, 4)).toEqual(['performance', onSnapshot, onEnd, signal])
  expect(forwarded[4]).toEqual(options)
})
