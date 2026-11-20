import { browserUploadPort } from '../src/main/browser-page-files.js'
import { describe, expect, it } from 'vitest'
import { installBrowserPageInterrupts } from '@agentmux/browser/page'
import type { BrowserPageTransport } from '@agentmux/browser/page'

/** A transport with one child frame session, recording each command with the session it went to. */
function fakeTransport() {
  const sent: { session: string; method: string; params: Record<string, unknown> }[] = []
  const listeners = new Set<(method: string, params: unknown, sessionId?: string) => void>()
  const sender = (session: string): BrowserPageTransport['sendCommand'] => async (method, params = {}) => {
    sent.push({ session, method, params })
    return {}
  }
  const session: BrowserPageTransport = {
    sendCommand: sender('page'),
    frames: new Map([['child', sender('child')]]),
    endedReason: null,
    frameDiscoveryFailure: null,
    observe: listener => { listeners.add(listener); return () => listeners.delete(listener) }
  }
  const emit = (method: string, params: unknown, sessionId?: string) => { for (const listener of [...listeners]) listener(method, params, sessionId) }
  return { session, sent, emit }
}

describe('file choosers during a run', () => {
  it('are intercepted on the page and on every child frame session, so no native picker opens', async () => {
    const t = fakeTransport()
    const interrupts = installBrowserPageInterrupts(t.session, { signal: new AbortController().signal })
    await interrupts.ready()
    const intercepted = t.sent.filter(command => command.method === 'Page.setInterceptFileChooserDialog' && command.params.enabled === true)
    expect(intercepted.map(command => command.session).sort()).toEqual(['child', 'page'])
  })

  it('hold the newest chooser as a handle, with the session it opened in; a later one replaces it', async () => {
    const t = fakeTransport()
    const interrupts = installBrowserPageInterrupts(t.session, { signal: new AbortController().signal })
    await interrupts.ready()
    expect(interrupts.pendingChooser()).toBeNull()
    t.emit('Page.fileChooserOpened', { backendNodeId: 7, mode: 'selectSingle' })
    const first = interrupts.pendingChooser()!
    expect(first).toEqual({ handle: expect.stringMatching(/^chooser-/), mode: 'single' })
    expect(interrupts.chooser(first.handle)).toMatchObject({ backendNodeId: 7 })
    expect(interrupts.chooser(first.handle)).not.toHaveProperty('sessionId')

    t.emit('Page.fileChooserOpened', { backendNodeId: 3, mode: 'selectMultiple' }, 'child')
    const second = interrupts.pendingChooser()!
    expect(second.mode).toBe('multiple')
    expect(interrupts.chooser(first.handle), 'a replaced chooser is no longer offered').toBeNull()
    expect(interrupts.chooser(second.handle)).toMatchObject({ backendNodeId: 3, sessionId: 'child' })

    interrupts.consumeChooser(second.handle)
    expect(interrupts.pendingChooser(), 'a filled chooser is no longer offered').toBeNull()
  })

  it('drop a held chooser when the page navigates, since its node id now names nothing; a child frame navigating keeps it', async () => {
    const t = fakeTransport()
    const interrupts = installBrowserPageInterrupts(t.session, { signal: new AbortController().signal })
    await interrupts.ready()
    t.emit('Page.fileChooserOpened', { backendNodeId: 7, mode: 'selectSingle' })
    t.emit('Page.frameNavigated', { frame: { id: 'sub', parentId: 'main' } })
    t.emit('Page.frameNavigated', { frame: { id: 'x' } }, 'child')
    expect(interrupts.pendingChooser()).not.toBeNull()
    t.emit('Page.frameNavigated', { frame: { id: 'main' } })
    expect(interrupts.pendingChooser()).toBeNull()
  })

  it('give the picker back when the run ends or a person takes control', async () => {
    const ended = fakeTransport()
    const run = installBrowserPageInterrupts(ended.session, { signal: new AbortController().signal })
    await run.ready()
    await run.dispose()
    const released = ended.sent.filter(command => command.method === 'Page.setInterceptFileChooserDialog' && command.params.enabled === false)
    expect(released.map(command => command.session).sort()).toEqual(['child', 'page'])

    const taken = fakeTransport()
    const control = new AbortController()
    const owner = installBrowserPageInterrupts(taken.session, { signal: control.signal })
    await owner.ready()
    control.abort()
    expect(taken.sent.some(command => command.session === 'page' && command.method === 'Page.setInterceptFileChooserDialog' && command.params.enabled === false))
      .toBe(true)
  })
})

import { createBrowserPageDispatch } from '@agentmux/browser/page'
import type { BrowserUploads } from '../src/main/browser-uploads.js'

describe('uploadFiles(handle) fills a chooser through the existing upload owner', () => {
  function chooserDispatch() {
    const t = fakeTransport()
    const interrupts = installBrowserPageInterrupts(t.session, { signal: new AbortController().signal })
    const uploads: { objectId: string; via: unknown; paths: unknown }[] = []
    const store = { upload: async (context: { target: { objectId: string; sendCommand: unknown } }, paths: unknown) => {
      uploads.push({ objectId: context.target.objectId, via: context.target.sendCommand, paths })
      return { kind: 'browser-upload-files' }
    } } as unknown as BrowserUploads
    // DOM.resolveNode answers with an object id that names the session it was resolved on.
    for (const [name, send] of [['page', t.session.sendCommand], ['child', t.session.frames.get('child')!]] as const) {
      const record = send
      const answering: BrowserPageTransport['sendCommand'] = async (method, params) => {
        await record(method, params)
        return method === 'DOM.resolveNode' ? { object: { objectId: `${name}:${String((params as { backendNodeId: number }).backendNodeId)}` } } : {}
      }
      if (name === 'page') (t.session as { sendCommand: BrowserPageTransport['sendCommand'] }).sendCommand = answering
      else t.session.frames.set('child', answering)
    }
    const dispatch = createBrowserPageDispatch({
      session: t.session, interrupts,
      pageInfo: () => ({ url: 'https://example.test/', title: 't', navigationId: 'nav-1' }),
      gotoUrl: async () => {}, captureScreenshot: async () => ({}), readLedger: async () => null, writeLedger: async () => {}, note: () => {},
      uploads: browserUploadPort({ store, context: () => ({ workspaceId: 'w', browserId: 'b', operationId: 'o', navigationId: 'nav-1', documentSurvivesClient: false, currentNavigationId: () => 'nav-1' }) })
    })
    return { t, interrupts, dispatch, uploads }
  }

  it('resolves the chooser’s input on the session it opened in, uploads, and stops offering it', async () => {
    const { t, interrupts, dispatch, uploads } = chooserDispatch()
    await interrupts.ready()
    t.emit('Page.fileChooserOpened', { backendNodeId: 3, mode: 'selectSingle' }, 'child')
    const info = await dispatch('pageInfo', []) as { fileChooser?: { handle: string; mode: string } }
    expect(info.fileChooser).toEqual({ handle: expect.stringMatching(/^chooser-/), mode: 'single' })
    await expect(dispatch('uploadFiles', [info.fileChooser!.handle, ['report.pdf']])).resolves.toEqual({ kind: 'browser-upload-files' })
    expect(uploads).toEqual([{ objectId: 'child:3', via: t.session.frames.get('child'), paths: ['report.pdf'] }])
    expect((await dispatch('pageInfo', []) as { fileChooser?: unknown }).fileChooser, 'a filled chooser is not offered again').toBeUndefined()
  })

  it('refuses a handle that is no longer open, before resolving or uploading anything', async () => {
    const { t, interrupts, dispatch, uploads } = chooserDispatch()
    await interrupts.ready()
    t.emit('Page.fileChooserOpened', { backendNodeId: 3, mode: 'selectSingle' })
    const handle = interrupts.pendingChooser()!.handle
    t.emit('Page.frameNavigated', { frame: { id: 'main' } })
    const failure = await dispatch('uploadFiles', [handle, ['a.txt']]).catch((error: unknown) => error) as { fact?: unknown; message?: string }
    expect(failure.fact).toEqual({ kind: 'locator-changed', effects: 'not-dispatched' })
    expect(failure.message).toContain('is not an open file chooser')
    expect(uploads).toEqual([])
    expect(t.sent.filter(command => command.method === 'DOM.resolveNode')).toEqual([])
  })
})
