import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { ChevronDown, ChevronUp, LoaderCircle, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { RuntimeEvent, SessionSnapshot, TerminalThemeId } from '../../../shared/contracts'
import { api } from '../lib/api'
import { installTerminalColorQueryReplyHandlers } from '../lib/terminal-capability-replies'
import { terminalOptions, terminalTheme } from '../lib/terminal-theme'
import { isTerminalAppShortcut } from '../lib/terminal-shortcuts'
import { hydrateTerminalReplay } from '../lib/terminal-replay'
import { TerminalViewportSynchronizer } from '../lib/terminal-viewport-sync'
import { TerminalContextMenu } from './TerminalContextMenu'

function terminalWrite(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

const MAX_PENDING_OUTPUT_EVENTS = 256
const MAX_PENDING_OUTPUT_BYTES = 512 * 1024

function outputForSession(event: RuntimeEvent, session: SessionSnapshot) {
  const core = event.event
  if (
    event.hostId !== session.hostId ||
    core.type !== 'terminal-output' ||
    core.run.runId !== session.control.run.runId
  ) return null
  const byteRange = core.evidence.outputByteRange
  return byteRange ? { ...core, ...byteRange } : null
}

export function TerminalView({ session, themeId }: { session: SessionSnapshot; themeId: TerminalThemeId }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [hasSelection, setHasSelection] = useState(false)
  const [hydrating, setHydrating] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  useEffect(() => {
    if (!rootRef.current) return
    setHydrating(true)
    const canControlRun = session.processState === 'running'
    const isMac = navigator.userAgent.includes('Mac')
    const terminal = new Terminal({
      ...terminalOptions(themeId),
      scrollback: 5_000
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    const webLinks = new WebLinksAddon((_event, uri) => {
      if (!/^https?:\/\//i.test(uri)) return
      void api.ui.openExternal(uri).catch((error) => {
        console.warn('[terminal] failed to open external link', error)
      })
    })
    terminal.loadAddon(fit)
    terminal.loadAddon(search)
    terminal.loadAddon(webLinks)
    terminal.open(rootRef.current)
    terminalRef.current = terminal
    searchAddonRef.current = search

    let webgl: WebglAddon | null = null
    let webglContextLoss: { dispose(): void } | null = null
    try {
      webgl = new WebglAddon()
      terminal.loadAddon(webgl)
      webglContextLoss = webgl.onContextLoss(() => {
        webgl?.dispose()
        webgl = null
      })
    } catch (error) {
      webgl?.dispose()
      webgl = null
      console.warn('[terminal] WebGL unavailable; xterm DOM renderer remains active', error)
    }

    let disposed = false
    let attachmentId: string | null = null
    let readyForLiveOutput = false
    let cursor = 0
    let outputTail = Promise.resolve()
    let acknowledgeTail = Promise.resolve()
    const pending: RuntimeEvent[] = []
    let pendingBytes = 0
    let droppedPendingThrough = 0
    let renderReady: { dispose(): void } | null = null
    const viewport = new TerminalViewportSynchronizer({
      proposeGrid: () => fit.proposeDimensions() ?? null,
      fit: () => fit.fit(),
      readGrid: () => ({ cols: terminal.cols, rows: terminal.rows }),
      resize: async ({ cols, rows }) => await api.sessions.resize(session.control, cols, rows),
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (frameId) => cancelAnimationFrame(frameId),
      onResizeError: (error) => console.warn('[terminal] failed to synchronize PTY viewport', error)
    })
    renderReady = terminal.onRender(() => {
      renderReady?.dispose()
      renderReady = null
      viewport.observeViewport()
    })

    const queueAcknowledge = (control: SessionSnapshot['control'], sequence: number): void => {
      acknowledgeTail = acknowledgeTail
        .catch(() => {})
        .then(async () => await api.sessions.acknowledge(control, sequence))
        .catch(() => {})
    }

    const accept = (event: RuntimeEvent): void => {
      const output = outputForSession(event, session)
      if (!output) return
      if (!readyForLiveOutput) {
        pending.push(event)
        pendingBytes += output.endByte - output.startByte
        while (
          pending.length > MAX_PENDING_OUTPUT_EVENTS ||
          pendingBytes > MAX_PENDING_OUTPUT_BYTES
        ) {
          const dropped = pending.shift()
          if (!dropped) break
          const droppedOutput = outputForSession(dropped, session)
          if (!droppedOutput) continue
          pendingBytes -= droppedOutput.endByte - droppedOutput.startByte
          droppedPendingThrough = Math.max(droppedPendingThrough, droppedOutput.endByte)
        }
        return
      }
      outputTail = outputTail.then(async () => {
        if (disposed || output.endByte <= cursor) return
        if (output.startByte !== cursor) {
          await terminalWrite(terminal, '\r\n\u001b[33m[Output sequence gap; earlier bytes are unavailable]\u001b[0m\r\n')
        }
        await terminalWrite(terminal, output.data)
        cursor = output.endByte
        queueAcknowledge(session.control, cursor)
      })
    }
    const disposeEvents = api.sessions.onEvent(accept)
    const resize = new ResizeObserver(() => viewport.observeViewport())
    resize.observe(rootRef.current)
    const input = terminal.onData((data) => {
      if (canControlRun && readyForLiveOutput) void api.sessions.write(session.control, data)
    })
    const selection = terminal.onSelectionChange(() => setHasSelection(terminal.hasSelection()))
    const colorQuerySuppression = installTerminalColorQueryReplyHandlers(terminal, {
      isReplaying: () => !readyForLiveOutput,
      respondFromRenderer: session.kind === 'terminal',
      sendInput: (data) => {
        if (canControlRun && readyForLiveOutput) void api.sessions.write(session.control, data)
      }
    })
    terminal.attachCustomKeyEventHandler((event) => {
      if (isTerminalAppShortcut(event, 'f', isMac)) {
        if (event.type === 'keydown') setSearchOpen(true)
        return false
      }
      if (isTerminalAppShortcut(event, 'c', isMac) && terminal.hasSelection()) {
        if (event.type === 'keydown') void api.ui.writeClipboardText(terminal.getSelection())
        return false
      }
      if (isTerminalAppShortcut(event, 'v', isMac)) {
        if (event.type === 'keydown') {
          void api.ui.readClipboardText().then((text) => {
            if (!disposed && text) terminal.paste(text)
          })
        }
        return false
      }
      if (isTerminalAppShortcut(event, 'k', isMac)) {
        if (event.type === 'keydown') terminal.clear()
        return false
      }
      return true
    })

    void (async () => {
      try {
        const result = await api.sessions.attach(session.control, 0)
        if (disposed) {
          await api.sessions.detach(result.attachmentId)
          return
        }
        attachmentId = result.attachmentId
        if (result.gap) {
          await terminalWrite(
            terminal,
            '\u001b[33m[Earlier terminal output fell outside the bounded replay window]\u001b[0m\r\n'
          )
          cursor = result.gap.firstAvailableByte
        }
        cursor = await hydrateTerminalReplay(
          result.replay,
          async (data) => await terminalWrite(terminal, data)
        ) ?? cursor
        if (droppedPendingThrough > cursor) {
          await terminalWrite(
            terminal,
            '\r\n\u001b[33m[Live output exceeded the pane startup buffer; omitted bytes were acknowledged]\u001b[0m\r\n'
          )
          cursor = droppedPendingThrough
        }
        if (canControlRun) await viewport.startLiveSynchronization()
        readyForLiveOutput = true
        if (cursor > 0) queueAcknowledge(result.session.control, cursor)
        for (const event of pending.splice(0)) accept(event)
        await outputTail
        if (disposed) return
        setHydrating(false)
        terminal.focus()
      } catch (error) {
        if (!disposed) {
          const detail = (error instanceof Error ? error.message : String(error))
            .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
          await terminalWrite(
            terminal,
            `\r\n\u001b[31m[Attach failed: ${detail}]\u001b[0m\r\n`
          )
          setHydrating(false)
        }
      }
    })()

    viewport.observeViewport()
    requestAnimationFrame(() => terminal.focus())
    return () => {
      disposed = true
      if (terminalRef.current === terminal) terminalRef.current = null
      if (searchAddonRef.current === search) searchAddonRef.current = null
      viewport.dispose()
      renderReady?.dispose()
      webglContextLoss?.dispose()
      webgl?.dispose()
      colorQuerySuppression.dispose()
      selection.dispose()
      disposeEvents()
      input.dispose()
      resize.disconnect()
      if (attachmentId !== null) void api.sessions.detach(attachmentId)
      terminal.dispose()
    }
  }, [session.control.run.runId, session.id, session.processState, themeId])

  function copySelection(): void {
    const terminal = terminalRef.current
    if (terminal?.hasSelection()) void api.ui.writeClipboardText(terminal.getSelection())
  }

  function pasteClipboard(): void {
    const terminal = terminalRef.current
    if (!terminal) return
    void api.ui.readClipboardText().then((text) => {
      if (terminalRef.current === terminal && text) terminal.paste(text)
    })
  }

  function closeSearch(): void {
    searchAddonRef.current?.clearDecorations()
    setSearchOpen(false)
    terminalRef.current?.focus()
  }

  function searchTerminal(query: string, previous = false): void {
    if (!query) {
      searchAddonRef.current?.clearDecorations()
      return
    }
    if (previous) searchAddonRef.current?.findPrevious(query)
    else searchAddonRef.current?.findNext(query, { incremental: true })
  }

  return (
    <TerminalContextMenu
      hasSelection={hasSelection}
      onCopy={copySelection}
      onPaste={pasteClipboard}
      onSelectAll={() => terminalRef.current?.selectAll()}
      onSearch={() => setSearchOpen(true)}
      onScrollToBottom={() => terminalRef.current?.scrollToBottom()}
      onClear={() => terminalRef.current?.clear()}
    >
      <div
        className="terminal-view"
        style={{ backgroundColor: terminalTheme(themeId).background }}
      >
        <div
          className={`terminal-view__xterm ${hydrating ? 'terminal-view__xterm--hydrating' : ''}`}
          ref={rootRef}
          onPointerDown={() => terminalRef.current?.focus()}
        />
        {hydrating ? (
          <div className="terminal-hydration" role="status" aria-live="polite">
            <LoaderCircle className="spin" size={13} /> Restoring terminal…
          </div>
        ) : null}
        {searchOpen ? (
          <div className="terminal-search" role="search">
            <Search size={13} />
            <input
              ref={searchInputRef}
              value={searchQuery}
              placeholder="Find"
              aria-label="Find in terminal"
              onChange={(event) => {
                setSearchQuery(event.target.value)
                searchTerminal(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') searchTerminal(searchQuery, event.shiftKey)
                if (event.key === 'Escape') closeSearch()
              }}
            />
            <button type="button" title="Previous match" onClick={() => searchTerminal(searchQuery, true)}><ChevronUp size={13} /></button>
            <button type="button" title="Next match" onClick={() => searchTerminal(searchQuery)}><ChevronDown size={13} /></button>
            <button type="button" title="Close find" onClick={closeSearch}><X size={13} /></button>
          </div>
        ) : null}
      </div>
    </TerminalContextMenu>
  )
}
