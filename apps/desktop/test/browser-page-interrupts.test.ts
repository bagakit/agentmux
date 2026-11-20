import { describe, expect, it } from 'vitest'
import { installBrowserPageInterrupts } from '@agentmux/browser/page'
import type { BrowserPageTransport } from '@agentmux/browser/page'
import type { BrowserLocalRecoveryFailure } from '../src/main/browser-local-recovery.js'

/** A transport that records commands and lets the test emit protocol events on the root session. */
function fakeTransport(options: { pageEnable?: 'ok' | 'fail' | 'held'; heldHousekeeping?: boolean } = {}) {
  const sent: { method: string; params: Record<string, unknown> }[] = []
  const listeners = new Set<(method: string, params: unknown) => void>()
  // An open dialog holds these replies in Chromium; 'held' models a reply that never comes.
  const never = new Promise<never>(() => {})
  const session: BrowserPageTransport = {
    sendCommand: async (method, params = {}) => {
      sent.push({ method, params })
      if (method === 'Page.enable' && options.pageEnable === 'fail') throw new Error('Page.enable failed')
      if (method === 'Page.enable' && options.pageEnable === 'held') return await never
      if (options.heldHousekeeping && (method === 'Page.disable' || method === 'Page.setInterceptFileChooserDialog' || method === 'Page.handleJavaScriptDialog')) return await never
      return {}
    },
    frames: new Map(),
    endedReason: null,
    frameDiscoveryFailure: null,
    observe: listener => { listeners.add(listener); return () => listeners.delete(listener) }
  }
  const emit = (method: string, params: unknown) => { for (const listener of [...listeners]) listener(method, params) }
  return { session, sent, emit, listeners }
}

const opening = (type: string, message = 'Are you sure?') => ({ type, message, url: 'https://example.test/' })

describe('one owner for a run’s page dialogs', () => {
  it('raw answers reuse the original dialog kind and keep cancellation available when observation is unknown', async () => {
    const t=fakeTransport(), owner=installBrowserPageInterrupts(t.session,{signal:new AbortController().signal})
    await owner.ready()
    t.emit('Page.javascriptDialogOpening',opening('confirm'))
    await expect(owner.answerRaw(true)).resolves.toEqual({})
    t.emit('Page.javascriptDialogOpening',opening('beforeunload',''))
    const before=t.sent.length
    await expect(owner.answerRaw(true)).rejects.toMatchObject({fact:{effects:'not-dispatched'}})
    expect(t.sent.slice(before)).toEqual([])
    await owner.answerRaw(false)
    expect(owner.current()).toBeNull()
    await owner.dispose()
    const unknown=fakeTransport({pageEnable:'fail'}), pending=installBrowserPageInterrupts(unknown.session,{signal:new AbortController().signal})
    await pending.ready()
    await expect(pending.answerRaw(true)).rejects.toThrow('kind is unknown')
    await expect(unknown.session.sendCommand('DOM.getDocument')).resolves.toEqual({})
    await pending.answerRaw(false)
    expect(unknown.sent.at(-1)).toEqual({method:'Page.handleJavaScriptDialog',params:{accept:false}})
    await pending.dispose()
  })

  it('ends a page call the moment a dialog opens, with effects from Main’s own input receipt', async () => {
    const t = fakeTransport()
    const interrupts = installBrowserPageInterrupts(t.session, { signal: new AbortController().signal })
    await interrupts.ready()
    // The click's input went out and the page answered with a dialog; the call itself never settles.
    const clicked = interrupts.race(() => new Promise(() => {}), () => true)
    t.emit('Page.javascriptDialogOpening', opening('confirm', 'Delete\nthis item?'))
    const failure = await clicked.catch((error: unknown) => error) as BrowserLocalRecoveryFailure
    expect(failure.fact).toEqual({ kind: 'page-dialog', effects: 'unknown' })
    // The page's message is marked as the page's and kept on one line.
    expect(failure.message).toContain('confirm dialog: [page-authored text] Delete this item?')
    expect(failure.message).toContain('acceptDialog() or dismissDialog()')
    // Navigation does not get past an open dialog, so it is not offered as a way out.
    expect(failure.message).not.toContain('gotoUrl')

    // A call that sent no input before the dialog opened did nothing to the page.
    await interrupts.answer(false)
    const read = interrupts.race(() => new Promise(() => {}), () => false)
    t.emit('Page.javascriptDialogOpening', opening('alert'))
    expect((await read.catch((error: unknown) => error) as BrowserLocalRecoveryFailure).fact).toEqual({ kind: 'page-dialog', effects: 'not-dispatched' })
  })

  it('refuses a call that would hang while a dialog is open, before sending anything; clears once answered', async () => {
    const t = fakeTransport()
    const interrupts = installBrowserPageInterrupts(t.session, { signal: new AbortController().signal })
    await interrupts.ready()
    expect(() => interrupts.assertNoDialog('snapshot')).not.toThrow()
    t.emit('Page.javascriptDialogOpening', opening('alert', 'Saved'))
    let refused: unknown
    try { interrupts.assertNoDialog('snapshot') } catch (error) { refused = error }
    expect((refused as BrowserLocalRecoveryFailure).fact).toEqual({ kind: 'page-dialog', effects: 'not-dispatched' })
    expect((refused as Error).message).toMatch(/^snapshot\(\) was not sent\. The page opened a alert dialog: \[page-authored text\] Saved\. .*dismissDialog\(\) closes it/)
    await expect(interrupts.answer(false)).resolves.toEqual({ type: 'alert', accepted: false })
    expect(t.sent.at(-1)).toEqual({ method: 'Page.handleJavaScriptDialog', params: { accept: false } })
    // Cleared on the reply, not only on the Closed event.
    expect(interrupts.current()).toBeNull()
    expect(() => interrupts.assertNoDialog('snapshot')).not.toThrow()
  })

  it('answers only an open dialog, decided from its own state, and sends prompt text only to a prompt', async () => {
    const t = fakeTransport()
    const interrupts = installBrowserPageInterrupts(t.session, { signal: new AbortController().signal })
    await interrupts.ready()
    const none = await interrupts.answer(true).catch((error: unknown) => error) as BrowserLocalRecoveryFailure
    expect(none.fact).toEqual({ kind: 'page-dialog', effects: 'not-dispatched' })
    expect(t.sent.filter(command => command.method === 'Page.handleJavaScriptDialog')).toEqual([])

    t.emit('Page.javascriptDialogOpening', opening('confirm'))
    const text = await interrupts.answer(true, 'yes').catch((error: unknown) => error) as BrowserLocalRecoveryFailure
    expect(text.message).toContain('confirm, which takes no text')
    await expect(interrupts.answer(true)).resolves.toEqual({ type: 'confirm', accepted: true })

    t.emit('Page.javascriptDialogOpening', opening('prompt'))
    await interrupts.answer(true, 'Ada')
    expect(t.sent.at(-1)).toEqual({ method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'Ada' } })
  })

  it('never agrees to leave a page that asks to stay open; dismissing keeps the page', async () => {
    const t = fakeTransport()
    const interrupts = installBrowserPageInterrupts(t.session, { signal: new AbortController().signal })
    await interrupts.ready()
    t.emit('Page.javascriptDialogOpening', opening('beforeunload', ''))
    const leave = await interrupts.answer(true).catch((error: unknown) => error) as BrowserLocalRecoveryFailure
    expect(leave.fact).toEqual({ kind: 'page-dialog', effects: 'not-dispatched' })
    expect(leave.message).toContain('only the person decides')
    expect(t.sent.filter(command => command.method === 'Page.handleJavaScriptDialog')).toEqual([])
    await expect(interrupts.answer(false)).resolves.toEqual({ type: 'beforeunload', accepted: false })
  })

  it('dismisses a dialog the program left open when the run ends, and reports it', async () => {
    const t = fakeTransport()
    const interrupts = installBrowserPageInterrupts(t.session, { signal: new AbortController().signal })
    await interrupts.ready()
    t.emit('Page.javascriptDialogOpening', opening('alert', 'Left behind'))
    await interrupts.dispose()
    expect(interrupts.leftOpenAtEnd()).toMatchObject({ type: 'alert', message: 'Left behind' })
    // The dialog is dismissed with Cancel before Page notifications go off.
    const dialogCommands = t.sent.map(command => command.method).filter(method => method === 'Page.handleJavaScriptDialog' || method === 'Page.disable')
    expect(dialogCommands).toEqual(['Page.handleJavaScriptDialog', 'Page.disable'])
    expect(t.sent.find(command => command.method === 'Page.handleJavaScriptDialog')?.params).toEqual({ accept: false })
    expect(t.listeners.size, 'the owner stops listening once disposed').toBe(0)
  })

  it('a dialog the program answered leaves nothing to report at the end', async () => {
    const t = fakeTransport()
    const interrupts = installBrowserPageInterrupts(t.session, { signal: new AbortController().signal })
    await interrupts.ready()
    t.emit('Page.javascriptDialogOpening', opening('alert'))
    await interrupts.answer(false)
    t.emit('Page.javascriptDialogClosed', { result: false })
    await interrupts.dispose()
    expect(interrupts.leftOpenAtEnd()).toBeNull()
  })

  it('a person taking control ends Agent answers: no answer, no dismissal at the end', async () => {
    const t = fakeTransport()
    const control = new AbortController()
    const interrupts = installBrowserPageInterrupts(t.session, { signal: control.signal })
    await interrupts.ready()
    t.emit('Page.javascriptDialogOpening', opening('confirm'))
    control.abort()
    expect(() => interrupts.assertNoDialog('snapshot'), 'refusals are the run’s, not the person’s').not.toThrow()
    const answered = await interrupts.answer(true).catch((error: unknown) => error) as BrowserLocalRecoveryFailure
    expect(answered.fact?.effects).toBe('not-dispatched')
    await interrupts.dispose()
    expect(t.sent.filter(command => command.method === 'Page.handleJavaScriptDialog'), 'the person answers their own dialog').toEqual([])
  })

  it('never waits behind a dialog that holds its own housekeeping replies: start, Stop and end all return', async () => {
    // A dialog already open when the run starts holds Page.enable: the run goes on unobserved instead of hanging.
    const held = fakeTransport({ pageEnable: 'held' })
    const started = installBrowserPageInterrupts(held.session, { signal: new AbortController().signal })
    const begun = performance.now()
    await started.ready()
    expect(performance.now() - begun).toBeLessThan(3_000)
    expect(started.observing()).toBe(false)
    // A dialog open at Stop or at the end holds every reply: dispose still returns.
    const stuck = fakeTransport({ heldHousekeeping: true })
    const control = new AbortController()
    const owner = installBrowserPageInterrupts(stuck.session, { signal: control.signal })
    await owner.ready()
    stuck.emit('Page.javascriptDialogOpening', opening('confirm'))
    const ended = performance.now()
    await owner.dispose()
    expect(performance.now() - ended, 'dispose must not wait behind a held reply').toBeLessThan(6_000)
  }, 15_000)

  it('a call raced after a dialog has already opened fails at once instead of waiting for an event that already came', async () => {
    const t = fakeTransport()
    const interrupts = installBrowserPageInterrupts(t.session, { signal: new AbortController().signal })
    await interrupts.ready()
    t.emit('Page.javascriptDialogOpening', opening('alert', 'Saved'))
    const failure = await interrupts.race(() => new Promise(() => {}), () => false).catch((error: unknown) => error) as BrowserLocalRecoveryFailure
    expect(failure.fact).toEqual({ kind: 'page-dialog', effects: 'not-dispatched' })
  })

  it('when Page notifications cannot be turned on, nothing is refused and the run behaves as before', async () => {
    const t = fakeTransport({ pageEnable: 'fail' })
    const interrupts = installBrowserPageInterrupts(t.session, { signal: new AbortController().signal })
    await interrupts.ready()
    expect(interrupts.observing()).toBe(false)
    await expect(interrupts.race(async () => 7, () => false)).resolves.toBe(7)
    await interrupts.dispose()
    expect(t.sent.map(command => command.method), 'nothing more after a Page.enable that failed').toEqual(['Page.enable'])
  })
})
