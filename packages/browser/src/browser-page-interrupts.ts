import type { BrowserPageTransport } from './browser-page-transport.js'
import { BrowserLocalRecoveryFailure } from './browser-recovery-failure.js'

/**
 * The page's own JavaScript dialogs (alert, confirm, prompt, beforeunload) during one Agent run.
 *
 * While a dialog is open the page's Runtime, DOM, screenshot and accessibility calls do not return,
 * and input is acknowledged but dropped (Electron 43, probed). Without an owner a program waits out
 * its whole 30 second budget and learns nothing. This module is that owner for one run's CDP
 * session: it turns Page notifications on for the run only, keeps the one open dialog, ends a page
 * call in flight the moment a dialog opens, refuses calls that would hang, answers the dialog when
 * the program asks, and at the end dismisses a dialog the program left open so the page is usable.
 *
 * Facts come from the protocol and from this module's own state: the dialog's `type` and `message`
 * in Page.javascriptDialogOpening on the root session (iframe dialogs arrive there too), and the
 * handle reply or Page.javascriptDialogClosed. No answer is decided from CDP error text or page text.
 *
 * File choosers are the same kind of interruption: a click on a file input would open the native
 * picker over the person's screen. During a run they are intercepted instead; the newest one is held
 * as a handle the program can fill through the upload owner, and dropped when its document goes away.
 *
 * Unknown stays unknown: when Page.enable fails, nothing is refused and the run keeps today's
 * behaviour; `observing()` reports false so the caller can say so.
 */

/** The page functions that answer a dialog. They must reach the page while one is open, and are never raced by one. */
export const BROWSER_PAGE_DIALOG_ANSWERS: ReadonlySet<string> = new Set(['acceptDialog', 'dismissDialog'])

/** The raw protocol answer must reach the same owner while its native dialog is open. */
export function isBrowserPageDialogAnswer(name: string, args: readonly unknown[]): boolean {
  return BROWSER_PAGE_DIALOG_ANSWERS.has(name) || name === 'cdp' && args[0] === 'Page.handleJavaScriptDialog'
}

/**
 * Page functions that read only what Main itself holds (the page's URL, title, navigation id and any
 * held file chooser), never the document. They answer at once while a dialog is open, so they are
 * neither refused nor raced; pageInfo is also how a program reads a held file chooser.
 */
export const BROWSER_PAGE_MAIN_READS: ReadonlySet<string> = new Set(['pageInfo', 'waitForUrl', 'finishHarCapture'])

export type BrowserPageDialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload'
export type BrowserPageDialog = { type: BrowserPageDialogType; message: string; url: string }
export type BrowserPageDialogAnswer = { type: BrowserPageDialogType; accepted: boolean }

const DIALOG_TYPES = new Set<string>(['alert', 'confirm', 'prompt', 'beforeunload'])
const MESSAGE_LIMIT = 240

/** Page text, flattened to one line and capped, marked as the page's so it is never read as ours. */
function pageMessage(message: string): string {
  const oneLine = message.replace(/\p{White_Space}+/gu, ' ').trim()
  const capped = oneLine.length > MESSAGE_LIMIT ? `${oneLine.slice(0, MESSAGE_LIMIT - 1)}…` : oneLine
  return capped ? `[page-authored text] ${capped}` : '(no message)'
}

/** What a program sees when a dialog stops its page call. */
export function describeBrowserPageDialog(dialog: BrowserPageDialog): string {
  // Navigation does not get past an open dialog (probed: gotoUrl stays pending), so only an answer is offered.
  const answer = dialog.type === 'alert' ? 'dismissDialog() closes it'
    : dialog.type === 'beforeunload' ? 'dismissDialog() keeps the page; only the person can decide to leave it'
      : 'acceptDialog() or dismissDialog() answers it'
  return `The page opened a ${dialog.type} dialog: ${pageMessage(dialog.message)}. While it is open the page cannot answer; ${answer}.`
}

/** A chooser the page opened during the run, held so a program can fill it. */
export type BrowserPageFileChooser = { handle: string; mode: 'single' | 'multiple'; backendNodeId: number; sessionId?: string }

export type BrowserPageInterrupts = ReturnType<typeof installBrowserPageInterrupts>

/**
 * How long the owner waits on its own housekeeping commands. While a page dialog is open, Chromium
 * holds the reply to Page.enable, Page.disable and Page.setInterceptFileChooserDialog until the dialog
 * is answered (Electron 43, probed). Awaiting them unbounded would hang a run, and its Stop, behind a
 * dialog. These replies are bookkeeping, not page actions, so a missing one is given up on.
 */
const HOUSEKEEPING_MS = 1_500

/** Wait for a housekeeping reply, or give up after a bound; a late reply is ignored. */
function bounded(command: Promise<unknown>): Promise<'ok' | 'timeout' | 'failed'> {
  return Promise.race([
    command.then(() => 'ok' as const, () => 'failed' as const),
    new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), HOUSEKEEPING_MS))
  ])
}

/**
 * Install the owner on one run's transport. Call `dispose()` before the session detaches; it removes
 * the listener, dismisses a dialog left open and turns Page notifications off.
 */
export function installBrowserPageInterrupts(session: BrowserPageTransport, options: { signal: AbortSignal }) {
  let open: BrowserPageDialog | null = null
  let observing = false
  let disposed = false
  let leftOpen: BrowserPageDialog | null = null
  // Every page call in flight races this; a new dialog rejects all of them at once.
  const waiters = new Set<(dialog: BrowserPageDialog) => void>()
  // The newest chooser the page opened; a later one replaces it, as it does for a person.
  let chooser: BrowserPageFileChooser | null = null
  let chooserCount = 0

  const stop = session.observe((method, params, sessionId) => {
    if (disposed) return
    if (method === 'Page.fileChooserOpened') {
      const event = params as { backendNodeId?: number; mode?: string }
      if (!Number.isInteger(event.backendNodeId)) return
      chooser = { handle: `chooser-${++chooserCount}`, mode: event.mode === 'selectMultiple' ? 'multiple' : 'single',
        backendNodeId: event.backendNodeId!, ...(sessionId ? { sessionId } : {}) }
      return
    }
    // A new document voids every backend node id, so a held chooser points at nothing.
    if (method === 'Page.frameNavigated' && !sessionId && !(params as { frame?: { parentId?: string } }).frame?.parentId) chooser = null
    if (method === 'Page.javascriptDialogOpening') {
      const event = params as { type?: string; message?: string; url?: string }
      if (!event.type || !DIALOG_TYPES.has(event.type)) return
      open = { type: event.type as BrowserPageDialogType, message: String(event.message ?? ''), url: String(event.url ?? '') }
      for (const reject of [...waiters]) reject(open)
      return
    }
    if (method === 'Page.javascriptDialogClosed') open = null
  })

  // File choosers are intercepted, so no native picker opens over the person's screen during a run.
  // A cross-site frame's chooser arrives on its own session, which needs its own interception.
  const intercept = (send: BrowserPageTransport['sendCommand']) =>
    bounded(send('Page.enable', {}).then(() => send('Page.setInterceptFileChooserDialog', { enabled: true })))
  // A dialog already open when the run starts holds Page.enable's reply; the run then goes on unobserved
  // rather than waiting behind it, and its calls end on their own budget as before.
  const ready = bounded(session.sendCommand('Page.enable', {})).then(async state => {
    observing = state === 'ok'
    if (!observing) return
    await bounded(session.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true }))
    await Promise.all([...session.frames.values()].map(intercept))
  })

  // A person taking control ends Agent answers: the owner stops listening and never answers again.
  const onAbort = () => {
    disposed = true
    stop()
    // The person now owns the page: their clicks open the native picker again. Not awaited, since a
    // dialog the page holds open can delay the reply.
    if (observing) void session.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {})
  }
  options.signal.addEventListener('abort', onAbort, { once: true })

  async function answer(accept: boolean, promptText?: string): Promise<BrowserPageDialogAnswer> {
      const dialog = open
      if (!dialog || disposed) {
        throw new BrowserLocalRecoveryFailure('No page dialog is open, so there is nothing to answer. Nothing was sent.', 'page-dialog', 'not-dispatched')
      }
      if (promptText !== undefined && dialog.type !== 'prompt') {
        throw new BrowserLocalRecoveryFailure(`The open dialog is a ${dialog.type}, which takes no text. Nothing was sent; answer it without text.`, 'page-dialog', 'not-dispatched')
      }
      if (dialog.type === 'beforeunload' && accept) {
        throw new BrowserLocalRecoveryFailure('Leaving a page that asks to stay open could lose what a person entered there, so only the person decides. Nothing was sent; dismissDialog() keeps the page.',
          'page-dialog', 'not-dispatched')
      }
      await session.sendCommand('Page.handleJavaScriptDialog', { accept, ...(promptText !== undefined ? { promptText } : {}) })
      // The reply closes it; do not wait for the Closed event, which may come after the next call starts.
      if (open === dialog) open = null
      return { type: dialog.type, accepted: accept }
    }

  return {
    /** Resolves once Page notifications are on, or known to be unavailable. */
    ready: () => ready,
    /** False when Page notifications could not be turned on; dialogs then go unobserved, as before. */
    observing: () => observing,
    /** The dialog open now, if any. */
    current: (): BrowserPageDialog | null => open,
    /** The chooser the page opened and has not been filled, as a program sees it. */
    pendingChooser: (): { handle: string; mode: 'single' | 'multiple' } | null => chooser && { handle: chooser.handle, mode: chooser.mode },
    /** The chooser behind a handle a program was given; null once filled, replaced or its document is gone. */
    chooser: (handle: string): BrowserPageFileChooser | null => chooser?.handle === handle ? chooser : null,
    /** A chooser was filled; it is no longer offered. */
    consumeChooser(handle: string): void { if (chooser?.handle === handle) chooser = null },

    /**
     * Run one page call; if a dialog opens before it settles, it fails at once with a typed fact.
     * `mayHaveActed` says whether the call can change the page; such a call's effect is unknown when it
     * is cut short, and only a read-only one can say nothing was dispatched.
     */
    async race<T>(call: () => Promise<T>, mayHaveActed: () => boolean): Promise<T> {
      if (disposed) return await call()
      // The dialog may have opened between the caller's check and here; it would never announce again.
      if (open) throw new BrowserLocalRecoveryFailure(describeBrowserPageDialog(open), 'page-dialog', 'not-dispatched')
      let reject!: (dialog: BrowserPageDialog) => void
      const interrupted = new Promise<never>((_resolve, fail) => {
        reject = dialog => fail(new BrowserLocalRecoveryFailure(describeBrowserPageDialog(dialog), 'page-dialog', mayHaveActed() ? 'unknown' : 'not-dispatched'))
      })
      waiters.add(reject)
      const pending = call()
      // The call may still settle after the dialog; its late result or error is no longer anyone's.
      pending.catch(() => {})
      try { return await Promise.race([pending, interrupted]) } finally { waiters.delete(reject) }
    },

    /** Refuse a call that would hang on the open dialog, before anything is sent. */
    assertNoDialog(name: string): void {
      if (!open || disposed) return
      throw new BrowserLocalRecoveryFailure(`${name}() was not sent. ${describeBrowserPageDialog(open)}`, 'page-dialog', 'not-dispatched')
    },

    /** A reviewed task click and its declared answer share this original dialog scope. */
    async triggerAndAnswer<T>(trigger: () => Promise<T>, decision: {
      type: BrowserPageDialogType; accept: boolean; promptText?: string
    }, scope: { beforeAnswer(dialog?: BrowserPageDialog): void; remainingMillis(): number }): Promise<{ trigger: T; dialog: BrowserPageDialogAnswer }> {
      if (disposed || options.signal.aborted || open || !observing) throw new BrowserLocalRecoveryFailure(
        'The expected dialog cannot be observed for this click. Nothing was sent; inspect the original Browser or use its normal controls.', 'page-dialog', 'not-dispatched')
      let active = true
      let receive!: (dialog: BrowserPageDialog) => void
      const opened = new Promise<BrowserPageDialog>(resolve => { receive = resolve })
      let reject!: (error: Error) => void
      const cancelled = new Promise<never>((_resolve, fail) => { reject = fail })
      const unknown = () => new BrowserLocalRecoveryFailure('The click or its dialog answer is unconfirmed. Inspect the original page; neither action was replayed.', 'page-dialog', 'unknown')
      const abort = () => reject(unknown())
      const timer = setTimeout(abort, Math.max(1, scope.remainingMillis()))
      waiters.add(receive)
      options.signal.addEventListener('abort', abort, { once: true })
      const complete = async () => {
        scope.beforeAnswer()
        const pending = trigger()
        pending.catch(() => {})
        // A successful click can open a dialog asynchronously. Its original program budget
        // bounds the observation; a failed click never licenses a later unrelated answer.
        const failed = pending.then(() => new Promise<never>(() => {}))
        const dialog = await Promise.race([opened, failed])
        if (!active || disposed || options.signal.aborted || open !== dialog || dialog.type !== decision.type) throw unknown()
        scope.beforeAnswer(dialog)
        let answered: BrowserPageDialogAnswer
        try { answered = await answer(decision.accept, decision.promptText) } catch { throw unknown() }
        return { trigger: await pending, dialog: answered }
      }
      try { return await Promise.race([complete(), cancelled]) }
      finally {
        active = false
        clearTimeout(timer)
        waiters.delete(receive)
        options.signal.removeEventListener('abort', abort)
      }
    },

    answer,
    /** Raw CDP answers share this exact original dialog fact. Unknown accepts are not approvals. */
    async answerRaw(accept: boolean, promptText?: string): Promise<unknown> {
      if (disposed) throw new BrowserLocalRecoveryFailure('This original dialog operation ended. Nothing was sent; inspect the Browser.', 'page-dialog', 'not-dispatched')
      if (!accept && !open) return await session.sendCommand('Page.handleJavaScriptDialog', { accept: false, ...(promptText === undefined ? {} : { promptText }) })
      if (accept && !open && !observing) throw new BrowserLocalRecoveryFailure('The current page dialog kind is unknown, so approval was not sent. Other Browser calls remain available; cdp("Page.handleJavaScriptDialog", {accept:false}) can cancel the original dialog, or reobserve it.', 'page-dialog', 'not-dispatched')
      await answer(accept, promptText)
      return {}
    },

    /** The dialog the run ended with, dismissed by dispose; null when the program left none open. */
    leftOpenAtEnd: (): BrowserPageDialog | null => leftOpen,

    /** Stop observing. A dialog still open is dismissed so the next run and the person find a usable page. */
    async dispose(): Promise<void> {
      if (disposed && !open) { stop(); return }
      options.signal.removeEventListener('abort', onAbort)
      disposed = true
      stop()
      const dialog = open
      if (dialog && !options.signal.aborted) {
        leftOpen = dialog
        await bounded(session.sendCommand('Page.handleJavaScriptDialog', { accept: false }))
        open = null
      }
      if (observing) {
        // Without this a person's later click on a file input would open nothing. Each reply is bounded:
        // dismissing one dialog can open the next, which would hold these replies.
        await bounded(session.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }))
        await Promise.all([...session.frames.values()].map(send => bounded(send('Page.setInterceptFileChooserDialog', { enabled: false }))))
        await bounded(session.sendCommand('Page.disable', {}))
      }
    }
  }
}
