import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { ChevronDown, ChevronUp, ExternalLink, LoaderCircle, Search, X } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RuntimeEvent, SessionSnapshot, TerminalThemeId } from '../../../shared/contracts'
import { api } from '../lib/api'
import type { OpenHttpLinkOrigin } from '../lib/open-destination'
import { useAppStore } from '../store'
import { installTerminalColorQueryReplyHandlers } from '../lib/terminal-capability-replies'
import {
  isTerminalLinkClick,
  terminalLinkModifierOpensSystemBrowser,
  terminalLinkPreviewAnchor
} from '../lib/terminal-link-gesture'
import { terminalOptions, terminalTheme } from '../lib/terminal-theme'
import { isTerminalAppShortcut } from '../lib/terminal-shortcuts'
import { finishTerminalReplayRecovery, hydrateTerminalReplay } from '../lib/terminal-replay'
import { acquireTerminalResourceOwners } from '../lib/terminal-resource-owners'
import { LatestTerminalOutputAcknowledger } from '../lib/terminal-output-ack'
import { TerminalViewportSynchronizer } from '../lib/terminal-viewport-sync'
import { terminalStartupPhase } from '../lib/terminal-startup'
import { agentProviderLabel } from './AgentProviderIcon'
import {
  OpenDestinationMenu,
  type OpenDestinationMenuRequest
} from './OpenDestinationMenu'
import { TerminalContextMenu } from './TerminalContextMenu'
import { TerminalReplayGapNotice } from './TerminalReplayGapNotice'

function terminalWrite(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

const MAX_PENDING_OUTPUT_EVENTS = 256
const MAX_PENDING_OUTPUT_BYTES = 512 * 1024

type TerminalLinkRequest = OpenDestinationMenuRequest & { terminalGeneration: number }

export function parseTerminalHttpLink(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

export function dismissTerminalLinkRequest<T extends OpenDestinationMenuRequest>(
  current: T | null,
  requestId: number
): T | null {
  return current?.id === requestId ? null : current
}

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

export function TerminalView({
  session,
  themeId,
  interactiveResize,
  autoFocus = true,
  linkOrigin
}: {
  session: SessionSnapshot
  themeId: TerminalThemeId
  interactiveResize: boolean
  // The reusable terminal on the create page must not steal focus from the prompt.
  autoFocus?: boolean
  linkOrigin: OpenHttpLinkOrigin
}) {
  const autoFocusRef = useRef(autoFocus)
  autoFocusRef.current = autoFocus
  const rootRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const viewportRef = useRef<TerminalViewportSynchronizer | null>(null)
  const terminalGenerationRef = useRef(0)
  const nextLinkRequestIdRef = useRef(0)
  const linkRequestRef = useRef<TerminalLinkRequest | null>(null)
  /** linkOrigin is a prop; the attach effect only re-runs on runId/session/theme, so read it fresh
   * through a ref when the modifier fast-path opens a link from inside the effect closure. */
  const linkOriginRef = useRef(linkOrigin)
  linkOriginRef.current = linkOrigin
  /** Where the current press began, so a drag that ends over a link is not mistaken for a click. */
  const linkPressRef = useRef<{ x: number; y: number } | null>(null)
  const interactiveResizeRef = useRef(interactiveResize)
  interactiveResizeRef.current = interactiveResize
  // canControlRun 随 processState 翻转，但 attach effect 不能依赖它——否则同 runId 的
  // 状态跳变（exit/interrupt/recovery）会整块拆/重建 xterm 并回放 scrollback，造成卡顿闪屏。
  // 用 ref 让输入 guard / resize gate 跨状态保持响应，同时不触发 effect 重挂。
  const canControlRun = session.processState === 'running'
  const canControlRunRef = useRef(canControlRun)
  canControlRunRef.current = canControlRun
  const acceptsInput = session.kind !== 'agent' || session.pendingInteraction === undefined
  const acceptsInputRef = useRef(acceptsInput)
  acceptsInputRef.current = acceptsInput
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [hasSelection, setHasSelection] = useState(false)
  const [hydrating, setHydrating] = useState(true)
  const [attachFailed, setAttachFailed] = useState(false)
  const [hasOutput, setHasOutput] = useState(false)
  const [replayGap, setReplayGap] = useState(false)
  const [redrawing, setRedrawing] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [linkRequest, setLinkRequest] = useState<TerminalLinkRequest | null>(null)
  const [linkPreview, setLinkPreview] = useState<{
    url: string
    left: number
    top: number
    placement: 'above' | 'below'
    fastPath: boolean
  } | null>(null)
  const openHttpLink = useAppStore((state) => state.openHttpLink)
  const reportError = useAppStore((state) => state.reportError)
  const isMac = navigator.userAgent.includes('Mac')

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  useLayoutEffect(() => {
    viewportRef.current?.setInteractiveResize(interactiveResize)
  }, [interactiveResize])

  // 变为 running 时启动 live 视口同步。attach effect 不再随 processState 重挂，
  // 所以这条独立小 effect 覆盖"attach 时非 running、随后恢复运行"的场景。
  // startLiveSynchronization 幂等（this.live 卫），重复调用无副作用。
  useEffect(() => {
    if (canControlRun) void viewportRef.current?.startLiveSynchronization().catch(() => {})
  }, [canControlRun])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const terminalGeneration = ++terminalGenerationRef.current
    setHydrating(true)
    setAttachFailed(false)
    setHasOutput(false)
    setReplayGap(false)
    setRedrawing(false)
    const terminal = new Terminal({
      ...terminalOptions(themeId),
      scrollback: 5_000
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    const webLinks = new WebLinksAddon((event, uri) => {
      const url = parseTerminalHttpLink(uri)
      if (!url) return
      // The addon activates on any mouse-up over a URL, so a drag that selects text across a link
      // would otherwise raise the open menu instead of selecting. Only a gesture that stayed put and
      // left no selection is a click on the link.
      const origin = linkPressRef.current
      linkPressRef.current = null
      if (!isTerminalLinkClick({
        origin,
        release: { x: event.clientX, y: event.clientY },
        hasSelection: terminal.hasSelection()
      })) return
      // Cmd (macOS) / Ctrl (elsewhere) + click opens the system browser immediately, skipping the
      // destination menu. A plain click keeps the menu.
      if (terminalLinkModifierOpensSystemBrowser(event, isMac)) {
        setLinkPreview(null)
        void openHttpLink(linkOriginRef.current, url, 'system').catch(reportError)
        return
      }
      const request = {
        id: ++nextLinkRequestIdRef.current,
        url,
        x: event.clientX,
        y: event.clientY,
        terminalGeneration
      }
      linkRequestRef.current = request
      setLinkRequest(request)
      setLinkPreview(null)
    }, {
      hover: (event, text) => {
        const url = parseTerminalHttpLink(text)
        if (!url) return
        const rect = root.getBoundingClientRect()
        // Cell height in CSS px, so the preview clears the whole link row whatever the pointer's
        // vertical offset within the hovered cell. Derived from the grid to avoid a private xterm API.
        const cellHeight = terminal.rows > 0 ? rect.height / terminal.rows : 0
        const anchor = terminalLinkPreviewAnchor({
          pointer: { x: event.clientX, y: event.clientY },
          cellHeight,
          viewport: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
        })
        setLinkPreview({
          url,
          left: anchor.left,
          top: anchor.top,
          placement: anchor.placement,
          fastPath: terminalLinkModifierOpensSystemBrowser(event, isMac)
        })
      },
      leave: () => setLinkPreview(null)
    })
    terminal.loadAddon(fit)
    terminal.loadAddon(search)
    terminal.loadAddon(webLinks)
    terminal.open(root)
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
    const releaseResourceOwners = acquireTerminalResourceOwners({
      addons: webgl ? 4 : 3,
      listeners: 6
    })

    let disposed = false
    let observedOutput = false
    let attachmentId: string | null = null
    let readyForLiveOutput = false
    let cursor = 0
    let outputTail = Promise.resolve()
    const pending: RuntimeEvent[] = []
    let pendingBytes = 0
    let droppedPendingThrough = 0
    let renderReady: { dispose(): void } | null = null
    const viewport = new TerminalViewportSynchronizer({
      proposeGrid: () => fit.proposeDimensions() ?? null,
      fit: () => fit.fit(),
      readGrid: () => ({ cols: terminal.cols, rows: terminal.rows }),
      resize: async ({ cols, rows }) => {
        // 进程已死时不向 PTY 发 resize（effect 不再随 processState 重挂，
        // ResizeObserver 仍可能在 exit 后触发）。
        if (!canControlRunRef.current || attachmentId === null) return
        await api.sessions.resize(attachmentId, cols, rows)
      },
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (frameId) => cancelAnimationFrame(frameId),
      // 容器 CSS 像素：仅当像素真的变化时才 fit，滤掉 WebGL/DOM cell-metric 抖动
      // 造成的一列 grid 摆动（否则 reflow→弹回会把 Codex 等 TUI 画花，见 viewport-sync）。
      measureViewport: () => {
        const rect = root.getBoundingClientRect()
        return { width: rect.width, height: rect.height }
      },
      onResizeError: (error) => console.warn('[terminal] failed to synchronize PTY viewport', error)
    })
    viewport.setInteractiveResize(interactiveResizeRef.current)
    viewportRef.current = viewport
    renderReady = terminal.onRender(() => {
      renderReady?.dispose()
      renderReady = null
      viewport.observeViewport()
    })

    const acknowledger = new LatestTerminalOutputAcknowledger(
      async (throughByte) => await api.sessions.acknowledge(session.control, throughByte)
    )

    const observeOutput = (): void => {
      if (disposed || observedOutput) return
      observedOutput = true
      setHasOutput(true)
    }

    const accept = (event: RuntimeEvent): void => {
      const output = outputForSession(event, session)
      if (!output) return
      if (output.data.length > 0) observeOutput()
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
        acknowledger.queue(cursor)
      })
    }
    const disposeEvents = api.sessions.onEvent(accept)
    const resize = new ResizeObserver(() => viewport.observeViewport())
    resize.observe(root)
    const input = terminal.onData((data) => {
      if (canControlRunRef.current && acceptsInputRef.current && readyForLiveOutput) {
        void api.sessions.write(session.control, data)
      }
    })
    const selection = terminal.onSelectionChange(() => setHasSelection(terminal.hasSelection()))
    const colorQuerySuppression = installTerminalColorQueryReplyHandlers(terminal, {
      isReplaying: () => !readyForLiveOutput,
      respondFromRenderer: session.kind === 'terminal',
      sendInput: (data) => {
        if (canControlRunRef.current && acceptsInputRef.current && readyForLiveOutput) {
          void api.sessions.write(session.control, data)
        }
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
      // Paste is intentionally NOT claimed here. Returning false from this handler does not
      // preventDefault (xterm's _keyDown returns before cancel()), so the native paste path
      // (Electron's Edit→Paste role → xterm's textarea paste listener) still fires. Handling
      // Cmd/Ctrl+V here as well applied the same clipboard text twice. The native path is the
      // single owner of paste; right-click paste is served by pasteClipboard().
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
          setReplayGap(true)
          cursor = result.gap.firstAvailableByte
        }
        if (result.replay.some((chunk) => chunk.data.length > 0)) observeOutput()
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
        await finishTerminalReplayRecovery({
          gap: Boolean(result.gap),
          canControlRun: canControlRunRef.current,
          startLiveSynchronization: async () => await viewport.startLiveSynchronization(),
          releaseLiveOutput: async () => {
            readyForLiveOutput = true
            if (cursor > 0) acknowledger.queue(cursor)
            for (const event of pending.splice(0)) accept(event)
            await outputTail
          },
          redrawCurrentScreen: async () => {
            const redrawn = await viewport.requestContentRedraw()
            await outputTail
            return redrawn
          },
          onRedrawError: (error) => console.warn('[terminal] failed to redraw after replay gap', error)
        })
        if (disposed) return
        setHydrating(false)
        if (autoFocusRef.current) terminal.focus()
      } catch (error) {
        if (!disposed) {
          setAttachFailed(true)
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
    if (autoFocusRef.current) requestAnimationFrame(() => terminal.focus())
    return () => {
      disposed = true
      setLinkPreview(null)
      setLinkRequest((current) => {
        const next = current?.terminalGeneration === terminalGeneration ? null : current
        linkRequestRef.current = next
        return next
      })
      acknowledger.dispose()
      if (terminalRef.current === terminal) terminalRef.current = null
      if (viewportRef.current === viewport) viewportRef.current = null
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
      if (attachmentId !== null) {
        void api.sessions.detach(attachmentId).catch((error) => {
          console.warn('[terminal] Attachment release was not acknowledged', error)
        })
      }
      terminal.dispose()
      releaseResourceOwners()
    }
  }, [session.control.run.runId, session.id, themeId])

  async function redrawCurrentScreen(): Promise<void> {
    if (!canControlRunRef.current || redrawing) return
    const viewport = viewportRef.current
    if (!viewport) return
    setRedrawing(true)
    try {
      await viewport.requestContentRedraw()
    } catch (error) {
      console.warn('[terminal] failed to redraw current screen', error)
    } finally {
      setRedrawing(false)
      terminalRef.current?.focus()
    }
  }

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

  const startupPhase = terminalStartupPhase({
    hydrating,
    attachFailed,
    agent: session.kind === 'agent',
    running: canControlRun,
    hasOutput
  })

  return (
    <Fragment>
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
            onPointerDown={(event) => {
              linkPressRef.current = { x: event.clientX, y: event.clientY }
              terminalRef.current?.focus()
            }}
          />
          {linkPreview ? (
            <div
              className="terminal-link-preview"
              data-placement={linkPreview.placement}
              role="tooltip"
              style={{ left: linkPreview.left, top: linkPreview.top }}
            >
              <ExternalLink size={13} />
              <span className="terminal-link-preview__url" title={linkPreview.url}>
                {linkPreview.url}
              </span>
              <kbd className="terminal-link-preview__hint">
                {linkPreview.fastPath
                  ? 'Open in browser'
                  : `${isMac ? '⌘' : 'Ctrl'}+click to open · click to choose`}
              </kbd>
            </div>
          ) : null}
          {startupPhase === 'restoring' ? (
            <div className="terminal-hydration" role="status" aria-live="polite">
              <LoaderCircle className="spin" size={13} /> Restoring terminal…
            </div>
          ) : null}
          {startupPhase === 'starting-agent' && session.kind === 'agent' ? (
            <div className="terminal-agent-startup" role="status" aria-live="polite">
              <div className="terminal-agent-startup__content">
                <LoaderCircle className="spin" size={14} />
                <strong>Starting {agentProviderLabel(session.providerId)}…</strong>
                <span>Waiting for its first terminal output.</span>
              </div>
            </div>
          ) : null}
          {!hydrating && replayGap ? (
            <TerminalReplayGapNotice
              canRedraw={canControlRun}
              redrawing={redrawing}
              onRedraw={() => void redrawCurrentScreen()}
            />
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
      <OpenDestinationMenu
        request={linkRequest}
        canSplit={Boolean(linkOrigin.tabId && linkOrigin.regionId)}
        onDismiss={(requestId) => {
          setLinkRequest((current) => {
            const next = dismissTerminalLinkRequest(current, requestId)
            if (linkRequestRef.current?.id === requestId) linkRequestRef.current = next
            return next
          })
        }}
        onSelect={(destination) => {
          const request = linkRequest
          if (!request || linkRequestRef.current?.id !== request.id) return
          linkRequestRef.current = null
          setLinkRequest((current) => dismissTerminalLinkRequest(current, request.id))
          void openHttpLink(linkOrigin, request.url, destination).catch(reportError)
        }}
      />
    </Fragment>
  )
}
