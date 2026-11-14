import type { Session, WebContents } from 'electron'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createBrowserProfileProxyLoginHandler } from '../src/main/browser-profile-proxy-auth.js'

const challenge = { isProxy: true, host: '127.0.0.1', port: 41827 }
function fixture() {
  const session = {} as Session, otherSession = {} as Session
  const contents = { session } as WebContents
  const calls: string[] = []
  const event = { preventDefault: vi.fn(() => { calls.push('prevent') }) }
  const callback = vi.fn(() => { calls.push('callback') })
  const ownerAnswer = vi.fn(async (..._args: Parameters<import('../src/main/browser-profile-proxy-auth.js').BrowserProfileProxyAuth['answer']>) => true)
  const transport = vi.fn((_session: Session, _auth: typeof challenge, _callback: (username?: string, password?: string) => void) => false)
  const proxyOf = vi.fn((_profileId: string) => ({ host: challenge.host, port: challenge.port }))
  const handler = createBrowserProfileProxyLoginHandler({ profileOfSession: target => target === session ? 'original-profile' : null, proxyOf, answerProxyTransport: transport, proxyAuth: { answer: ownerAnswer } })
  const app = new EventEmitter(); app.on('login', handler)
  const dispatch = (details: { firstAuthAttempt?: boolean } = {}) => app.emit('login', event, contents, details, challenge, callback)
  return { session, otherSession, contents, calls, event, callback, ownerAnswer, transport, proxyOf, handler, app, dispatch }
}

describe('Original Profile proxy app login entrypoint', () => {
  it('leaves origin-server sign-ins, unknown Sessions and missing contents to Chromium', async () => {
    const f = fixture()
    f.app.emit('login', f.event, f.contents, {}, { ...challenge, isProxy: false }, f.callback)
    f.app.emit('login', f.event, { session: f.otherSession }, {}, challenge, f.callback)
    f.app.emit('login', f.event, null, {}, challenge, f.callback)
    await Promise.resolve()
    expect(f.event.preventDefault).not.toHaveBeenCalled()
    expect(f.transport).not.toHaveBeenCalled(); expect(f.ownerAnswer).not.toHaveBeenCalled(); expect(f.callback).not.toHaveBeenCalled()
  })

  it.each([{ ...challenge, host: 'another-proxy.invalid' }, { ...challenge, port: challenge.port + 1 }])('leaves another proxy endpoint $host:$port in the same Session to Chromium', async auth => {
    const f = fixture()
    f.app.emit('login', f.event, f.contents, {}, auth, f.callback); await Promise.resolve()
    expect(f.event.preventDefault).not.toHaveBeenCalled()
    expect(f.ownerAnswer).not.toHaveBeenCalled(); expect(f.callback).not.toHaveBeenCalled()
  })

  it('claims the exact Profile Session before its transport answers, without consulting credentials twice', async () => {
    const f = fixture()
    f.proxyOf.mockReturnValueOnce({ host: 'original-socks.invalid', port: 1080 })
    f.transport.mockImplementationOnce((target, auth, callback) => { expect(target).toBe(f.session); expect(auth).toBe(challenge); callback(); f.calls.push('transport-return'); return true })
    f.dispatch({ firstAuthAttempt: true }); await Promise.resolve()
    expect(f.calls).toEqual(['prevent', 'callback', 'transport-return'])
    expect(f.ownerAnswer).not.toHaveBeenCalled(); expect(f.callback).toHaveBeenCalledTimes(1)
  })

  it.each([true, false, undefined])('preserves firstAuthAttempt=%s and the original credential callback order', async firstAuthAttempt => {
    const f = fixture()
    f.ownerAnswer.mockImplementationOnce(async (contents, auth, callback, firstAttempt) => {
      expect(contents).toBe(f.contents); expect(auth).toBe(challenge); expect(firstAttempt).toBe(firstAuthAttempt === true)
      f.calls.push('credential'); callback(); return true
    })
    f.dispatch(firstAuthAttempt === undefined ? {} : { firstAuthAttempt }); await Promise.resolve()
    expect(f.calls).toEqual(['prevent', 'credential', 'callback'])
    expect(f.transport).toHaveBeenCalledWith(f.session, challenge, expect.any(Function))
    expect(f.callback).toHaveBeenCalledTimes(1)
  })

  it.each(['refused', 'unknown'] as const)('finishes only the admitted challenge when its credential answer is %s', async status => {
    const f = fixture()
    if (status === 'refused') f.ownerAnswer.mockResolvedValueOnce(false)
    else f.ownerAnswer.mockRejectedValueOnce(new Error('Credential read unavailable'))
    f.dispatch(); await Promise.resolve()
    expect(f.event.preventDefault).toHaveBeenCalledTimes(1)
    expect(f.callback).toHaveBeenCalledExactlyOnceWith()
    expect(f.calls).toEqual(['prevent', 'callback'])
    // An unrelated later challenge is still handled by Chromium, not the failed request's callback.
    f.app.emit('login', f.event, { session: f.otherSession }, {}, challenge, f.callback)
    await Promise.resolve(); expect(f.callback).toHaveBeenCalledTimes(1)
  })
})
