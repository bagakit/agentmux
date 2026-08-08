import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { ChevronDown, ChevronUp, ExternalLink, FileCode, LoaderCircle, Search, X } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RuntimeEvent, SessionSnapshot, TerminalThemeId } from '../../../shared/contracts'
import { api } from '../lib/api'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import {
  dismissOpenDestinationRequest,
  parseHttpLinkUrl,
  type OpenHttpLinkOrigin
} from '../lib/open-destination'
import { useAppStore } from '../store'
import { installTerminalOscHandlers } from '../lib/terminal-capability-replies'
import {
  isTerminalLinkClick,
  terminalLinkModifierOpensSystemBrowser,
  terminalLinkPreviewAnchor
} from '../lib/terminal-link-gesture'
import { detectTerminalPathLinks } from '../lib/terminal-path-link'
import { installTerminalPasteSanitizer, pasteIntoTerminal } from '../lib/terminal-paste'
import { TERMINAL_HTTP_URL_REGEX } from '../lib/terminal-http-link'
import { terminalOptions, terminalTheme, activateTerminalUnicodeWidth, UNICODE_WIDTH_VERSION } from '../lib/terminal-theme'
import {
  terminalKeyEventHandler,
  terminalSelectionForCopy
} from '../lib/terminal-shortcuts'
import { matchShortcut } from '../lib/shortcut-registry'
import {
  initialKittyKeyboardState,
  isKittyKeyboardActive,
  readKittyKeyboardOutput
} from '../lib/terminal-kitty-keyboard'
import {
  DEFAULT_TERMINAL_SEARCH_TOGGLES,
  searchTerminalFromSurface,
  toggleTerminalSearch,
  type TerminalSearchToggles
} from '../lib/terminal-search'
import {
  TERMINAL_SEARCH_HIGHLIGHT_LIMIT,
  subscribeTerminalSearchCount
} from '../lib/terminal-search-count'
import { finishTerminalReplayRecovery, hydrateTerminalReplay, yieldTerminalWork } from '../lib/terminal-replay'
import { acquireTerminalResourceOwners } from '../lib/terminal-resource-owners'
import { LatestTerminalOutputAcknowledger } from '../lib/terminal-output-ack'
import { TerminalViewportSynchronizer } from '../lib/terminal-viewport-sync'
import {
  rememberTerminalViewport,
  restoreTerminalViewport,
  type TerminalViewportMemory
} from '../lib/terminal-viewport-memory'
import {
  admitTerminalLiveOutput,
  composeTerminalLiveOutputWrite,
  takeTerminalLiveOutputBatch,
  type TerminalLiveOutputChunk
} from '../lib/terminal-live-output'
import { terminalStartupPhase } from '../lib/terminal-startup'
import {
  TERMINAL_REVEAL_DEADLINE_MS,
  subscribeTerminalInput,
  terminalAcceptsInput,
  terminalInputSender,
  terminalRevealDecision,
  terminalRevealServiceOutcome
} from '../lib/terminal-reveal'
import { classifyServiceNotice, serviceNoticeToRender } from '../lib/service-window-notice'
import { agentProviderLabel } from './AgentProviderIcon'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import {
  OpenDestinationPopover,
  type OpenDestinationRequest
} from './OpenDestinationBar'
import { TerminalContextMenu } from './TerminalContextMenu'
import { TerminalReplayGapNotice } from './TerminalReplayGapNotice'
import type { MouseTrackingMode } from '../lib/terminal-selection-mode'
import { regionCaretFocusTargets } from '../lib/region-focus'
import { isMacPlatform } from '../lib/host-platform'

function terminalWrite(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

const MAX_PENDING_OUTPUT_EVENTS = 256
const MAX_PENDING_OUTPUT_BYTES = 512 * 1024

/**
 * 搜索的三个开关。字形沿用终端搜索的通用惯例（Aa 大小写、.* 正则、ab| 全词），
 * 让认得其他编辑器的人不用学。`label` 同时作 title 与 aria-label——鼠标和读屏看到同一句话。
 */
const SEARCH_TOGGLES: ReadonlyArray<{
  key: keyof TerminalSearchToggles
  label: string
  glyph: string
}> = Object.freeze([
  { key: 'caseSensitive', label: 'Match case', glyph: 'Aa' },
  { key: 'regex', label: 'Use regular expression', glyph: '.*' },
  { key: 'wholeWord', label: 'Match whole word', glyph: 'ab|' }
])

type TerminalLinkRequest = OpenDestinationRequest & { terminalGeneration: number }

// 终端与对话正文都要判「哪些 scheme 点了能打开」，那必须是同一个判据，而不是各抄一份。判据本体
// 住在 lib/open-destination.ts——对话渲染器不能在模块加载期拖进 xterm，所以共用出口只能放在那边。
// 这里不再包一层同义的别名：同一个概念留两个名字，日后就会有人只改其中一处。

export function dismissTerminalLinkRequest<T extends OpenDestinationRequest>(
  current: T | null,
  requestId: number
): T | null {
  return dismissOpenDestinationRequest(current, requestId)
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
  visible = true,
  autoFocus = true,
  linkOrigin
}: {
  session: SessionSnapshot
  themeId: TerminalThemeId
  interactiveResize: boolean
  // 这一格看不看得见。隐藏的 Tab 仍留在 DOM 里保住 xterm 实例（切回才不必重放），
  // 但它必须停工：不 fit、不 resize、不渲染。默认 true 供创建页等单格场景。
  visible?: boolean
  // The reusable terminal on the create page must not steal focus from the prompt.
  autoFocus?: boolean
  linkOrigin: OpenHttpLinkOrigin
}) {
  const autoFocusRef = useRef(autoFocus)
  autoFocusRef.current = autoFocus
  const rootRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const viewportRef = useRef<TerminalViewportSynchronizer | null>(null)
  const viewportMemoryRef = useRef<TerminalViewportMemory>({ kind: 'latest' })
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
  const visibleRef = useRef(visible)
  visibleRef.current = visible
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
  const rememberedSelectionRef = useRef('')
  const [hasSelection, setHasSelection] = useState(false)
  /**
   * 右键那一刻 xterm 的鼠标上报模式——复制三合一失效的**根因取值**。
   *
   * 为什么是 state 而不是每次渲染读 `terminal.modes.mouseTrackingMode`：那是个 getter，PTY 里的 TUI
   * 随时切换（DECSET ?1000/?1002/?1003），xterm 不为它发 React 能订阅的事件。渲染期读到的值与用户
   * 右键那一刻的值可以不同，于是提示会说错话。这里在**右键手势本身**里采样——那正是菜单即将打开的
   * 时刻，也是同一个 handler 已经在抢救选区快照的地方（两件事同因同时，别拆成两处）。
   *
   * 初值 'none'（不压制、不提示）：还没右键过就没有可信的模式，不猜。
   */
  const [mouseTrackingMode, setMouseTrackingMode] = useState<MouseTrackingMode>('none')
  const [hydrating, setHydrating] = useState(true)
  /**
   * 揭示是被我们自己的步骤逼出来的，而不是走通了（`lib/terminal-reveal.ts`）。
   *
   * 独立于 `hydrating`：揭示之后 `hydrating` 就是假，无从区分"正常走完"与"到点硬揭示"，
   * 而后者必须留下一条告示——只揭示不说话就是静默降级（AGENTS.md 原则 11 的两条边界之一）。
   */
  const [revealOverdue, setRevealOverdue] = useState(false)
  const [liveOutputReady, setLiveOutputReady] = useState(false)
  const [attachFailed, setAttachFailed] = useState(false)
  const [hasOutput, setHasOutput] = useState(false)
  const [replayGap, setReplayGap] = useState(false)
  const [redrawing, setRedrawing] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchToggles, setSearchToggles] = useState<TerminalSearchToggles>(DEFAULT_TERMINAL_SEARCH_TOGGLES)
  // 「为什么这次没搜」——只在用户需要知道时有值（正则还没打完）。空查询不给理由。
  const [searchNotice, setSearchNotice] = useState<string | undefined>(undefined)
  // 「第 3 个 / 共 47 个」。与 notice 分开两格：notice 说的是这次**没搜**，计数说的是搜到了什么，
  // 两者可以同时有话说（上一轮搜到 47 条、这一轮正则还没打完），挤在一格里会互相盖掉。
  const [searchCount, setSearchCount] = useState<string | undefined>(undefined)
  const [linkRequest, setLinkRequest] = useState<TerminalLinkRequest | null>(null)
  const [linkPreview, setLinkPreview] = useState<
    | { kind: 'http'; url: string; left: number; top: number; placement: 'above' | 'below'; fastPath: boolean }
    | { kind: 'file'; label: string; left: number; top: number; placement: 'above' | 'below' }
    | null
  >(null)
  const openHttpLink = useAppStore((state) => state.openHttpLink)
  const openFile = useAppStore((state) => state.openFile)
  const reportError = useAppStore((state) => state.reportError)
  const regionCaretFocus = useAppStore((state) =>
    regionCaretFocusTargets(state.regionCaretFocus, linkOrigin.regionId) ? state.regionCaretFocus : null)
  const clearRegionCaretFocus = useAppStore((state) => state.clearRegionCaretFocus)
  // The active workspace's on-disk root — the base main resolves openFile against. Read from the
  // WorkspaceRecord (NOT session.workspacePath) so worktree/scratch terminals still relativize
  // absolute paths against the base main actually uses. A ref keeps it fresh for the attach-effect
  // closure, which does not re-run on config change.
  const activeWorkspaceRoot = useAppStore((state) =>
    state.config?.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId)?.path ?? ''
  )
  const activeWorkspaceRootRef = useRef(activeWorkspaceRoot)
  activeWorkspaceRootRef.current = activeWorkspaceRoot
  const isMac = isMacPlatform()

  function restoreRememberedViewport(terminal: Terminal): void {
    const target = restoreTerminalViewport(
      viewportMemoryRef.current,
      terminal.buffer.active.baseY
    )
    if (target.kind === 'latest') terminal.scrollToBottom()
    else terminal.scrollToLine(target.line)
  }

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  function consumeCaretFocus(): void {
    const request = useAppStore.getState().regionCaretFocus
    if (!regionCaretFocusTargets(request, linkOriginRef.current.regionId)) return
    if (!visibleRef.current) {
      clearRegionCaretFocus(request.nonce)
      return
    }
    const target = searchInputRef.current ?? terminalRef.current
    if (!target) return
    target.focus()
    clearRegionCaretFocus(request.nonce)
  }

  useEffect(() => {
    consumeCaretFocus()
  }, [regionCaretFocus, visible, searchOpen])

  useLayoutEffect(() => {
    viewportRef.current?.setInteractiveResize(interactiveResize)
  }, [interactiveResize])

  useLayoutEffect(() => {
    const terminal = terminalRef.current
    if (!visible && terminal) {
      const buffer = terminal.buffer.active
      viewportMemoryRef.current = rememberTerminalViewport(buffer.viewportY, buffer.baseY)
    }
    viewportRef.current?.setVisible(visible)
    if (!visible || !terminal) return
    // Restore after the synchronizer's first visibility frame as well: fit/resize can otherwise
    // move xterm's DOM viewport before the user sees the reactivated Region.
    const restore = () => {
      if (!visibleRef.current || terminalRef.current !== terminal) return
      restoreRememberedViewport(terminal)
    }
    restore()
    const frame = requestAnimationFrame(restore)
    return () => cancelAnimationFrame(frame)
  }, [visible])

  // 变为 running 时启动 live 视口同步。attach effect 不再随 processState 重挂，
  // 所以这条独立小 effect 覆盖"attach 时非 running、随后恢复运行"的场景。
  // startLiveSynchronization 幂等（this.live 卫），重复调用无副作用。
  useEffect(() => {
    if (canControlRun) void viewportRef.current?.startLiveSynchronization().catch(() => {})
  }, [canControlRun])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    // A const the closures below can capture without TypeScript re-widening it to null.
    const terminalRoot = root
    const terminalGeneration = ++terminalGenerationRef.current
    viewportMemoryRef.current = { kind: 'latest' }
    setHydrating(true)
    setRevealOverdue(false)
    // A Region can keep this component mounted while its Run changes (for example after a
    // continuity recovery).  The previous Run may already have completed the replay-to-live
    // handoff; reset the presentation bit before the new attachment starts so a stalled handoff
    // cannot be reported as ready or accidentally invite input.
    setLiveOutputReady(false)
    setAttachFailed(false)
    setHasOutput(false)
    setReplayGap(false)
    setRedrawing(false)
    rememberedSelectionRef.current = ''
    const terminal = new Terminal({
      ...terminalOptions(themeId),
      scrollback: 5_000
    })
    const fit = new FitAddon()
    // highlightLimit 显式传入而不是吃 addon 的默认值：计数文案要在命中上限时说「1000+」而不是
    // 「1000」，那个判据和这个数必须是同一个来源。不传就得靠"库的默认恰好是 1000"这条无人守的假设。
    const search = new SearchAddon({ highlightLimit: TERMINAL_SEARCH_HIGHLIGHT_LIMIT })
    /**
     * 一个 http 链接被点开时该发生什么。**两条 provider 共用这一个出口。**
     *
     * 终端里的 http 链接有两个来源，xterm 用两条互不相干的 provider 处理它们：
     *  - 裸文本 URL（终端只是吐了字符串）→ `WebLinksAddon`，activate 由我们传入；
     *  - OSC 8 超链接（终端用转义序列声明"这段文字是个链接"，Claude Code 就这么输出）→
     *    xterm 内建的 `OscLinkProvider`，它的 activate 取自**构造选项 `linkHandler`**，
     *    没设就落到自己的 `defaultActivate`：一个原生 `confirm("…could potentially be dangerous")`
     *    加 `window.open`（见 @xterm/xterm OscLinkProvider.ts）。
     *
     * 这一族缺陷极难自查：裸 URL 那条路一直好的，所以"点链接出选择器"在开发中天天验证通过，
     * 而 OSC 8 那条路从未接线，用户看到的是浏览器厂商的告警框，界面上没有任何我们的痕迹。
     * 判据要按**出口个数**而不是"点击这个动作有没有被处理"——同一个概念有两个入口时，
     * 少接一个不会让另一个变红。
     */
    const activateHttpLink = (event: MouseEvent, uri: string): void => {
      const url = parseHttpLinkUrl(uri)
      if (!url) return
      // Both providers activate on a mouse-up over the link, so a drag that selects text across one
      // would otherwise raise the picker instead of selecting. Only a gesture that stayed put and
      // left no selection is a click on the link.
      const origin = linkPressRef.current
      linkPressRef.current = null
      if (!isTerminalLinkClick({
        origin,
        release: { x: event.clientX, y: event.clientY },
        hasSelection: terminal.hasSelection()
      })) return
      // Cmd (macOS) / Ctrl (elsewhere) + click opens the system browser immediately, skipping the
      // destination picker. A plain click keeps the picker.
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
    }
    const hoverHttpLink = (event: MouseEvent, text: string): void => {
      const url = parseHttpLinkUrl(text)
      if (!url) return
      const anchor = previewAnchorAt(event.clientX, event.clientY)
      setLinkPreview({
        kind: 'http',
        url,
        left: anchor.left,
        top: anchor.top,
        placement: anchor.placement,
        fastPath: terminalLinkModifierOpensSystemBrowser(event, isMac)
      })
    }
    // OSC 8 链接的出口。`allowNonHttpProtocols` 保持默认（假）：xterm 会在 provideLinks 里就把
    // 非 http(s) 的 URI 丢掉，于是这个 handler 只会收到我们的选择器能处理的东西。
    terminal.options.linkHandler = {
      activate: (event, text) => activateHttpLink(event, text),
      hover: (event, text) => hoverHttpLink(event, text),
      leave: () => setLinkPreview(null)
    }
    const webLinks = new WebLinksAddon(activateHttpLink, {
      hover: hoverHttpLink,
      leave: () => setLinkPreview(null),
      urlRegex: TERMINAL_HTTP_URL_REGEX
    })
    // Shared anchor math for both link previews (http URLs and file paths), so the file-path preview
    // never covers its link either. Cell height is derived from the grid (no private xterm API).
    function previewAnchorAt(clientX: number, clientY: number) {
      const rect = terminalRoot.getBoundingClientRect()
      const cellHeight = terminal.rows > 0 ? rect.height / terminal.rows : 0
      return terminalLinkPreviewAnchor({
        pointer: { x: clientX, y: clientY },
        cellHeight,
        viewport: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
      })
    }
    terminal.loadAddon(fit)
    terminal.loadAddon(search)
    terminal.loadAddon(webLinks)
    terminal.open(root)
    terminalRef.current = terminal
    consumeCaretFocus()
    searchAddonRef.current = search
    // 「第 3 个 / 共 47 个」。订阅在 addon 加载之后立刻建立，而不是等面板打开：addon 在关闭状态下
    // 也不会发结果事件，等到打开再订阅只是多一处生命周期，且会漏掉打开那一瞬的首次结果。
    // 投影逻辑（截断下界、位置未知）在 lib 里，这里只剩这一句转发——见 terminal-search-count.ts 的说明。
    const searchCounter = subscribeTerminalSearchCount(search, setSearchCount)

    // 宽度表必须在**任何回放字节写入之前**激活：单元格宽度在字节写入那一刻按当时的
    // Unicode 版本定型，先写进去的 CJK/emoji 会按默认的 v6 宽度串行，之后再切版本也救不回来。
    // 所以这一步紧跟 open()、排在下面 attach 里首个 replay write 之前。返回值就地断言，
    // 把"只 load 没激活"（loadAddon 只登记版本、不改 activeVersion）这种静默失效挡在启动期。
    // 这个 addon 的 dispose 是空操作、不持有任何可泄漏资源，故不计入下方的 addon owner 账。
    const activeUnicodeVersion = activateTerminalUnicodeWidth(terminal)
    if (activeUnicodeVersion !== UNICODE_WIDTH_VERSION) {
      console.warn(`[terminal] Unicode width table did not activate (active=${activeUnicodeVersion})`)
    }

    // File-path link provider. Runs on the render/hover hot path, so it does ONLY string work:
    // read the buffer line xterm already holds and scan it with the pure, conservative matcher.
    // No disk, no IPC, no existence probe here — a path that does not exist fails visibly on click
    // via reportError, never on this path.
    const pathLinks = terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const line = terminal.buffer.active.getLine(bufferLineNumber - 1)?.translateToString(true)
        if (!line) return callback(undefined)
        const matches = detectTerminalPathLinks(line, activeWorkspaceRootRef.current)
        if (matches.length === 0) return callback(undefined)
        callback(matches.map((match) => {
          const location = match.line !== undefined
            ? { line: match.line, ...(match.column !== undefined ? { column: match.column } : {}) }
            : undefined
          const label = match.line !== undefined
            ? `${match.path}:${match.line}${match.column !== undefined ? `:${match.column}` : ''}`
            : match.path
          return {
            // 1-based, right side inclusive on start / exclusive-as-inclusive on end (xterm range).
            range: {
              start: { x: match.index + 1, y: bufferLineNumber },
              end: { x: match.index + match.length, y: bufferLineNumber }
            },
            text: match.path,
            activate: (event: MouseEvent) => {
              // Same drag-guard as the http provider: a drag that ends over a path must select,
              // not open. Shares the single linkPressRef set on pointerdown.
              const origin = linkPressRef.current
              linkPressRef.current = null
              if (!isTerminalLinkClick({
                origin,
                release: { x: event.clientX, y: event.clientY },
                hasSelection: terminal.hasSelection()
              })) return
              setLinkPreview(null)
              // openFile ignores its workspaceId and uses the active workspace; a terminal is only
              // clickable while its workspace is active, so linkOrigin.tabGroupId lands the file in
              // the terminal's own Tab Group. A miss surfaces through reportError (fail visibly).
              void openFile(match.path, linkOriginRef.current.tabGroupId, location).catch(reportError)
            },
            hover: (event: MouseEvent) => {
              const anchor = previewAnchorAt(event.clientX, event.clientY)
              setLinkPreview({
                kind: 'file',
                label,
                left: anchor.left,
                top: anchor.top,
                placement: anchor.placement
              })
            },
            leave: () => setLinkPreview(null)
          }
        }))
      }
    })

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
      // 8 而非 7：onData 与 onBinary 是两个独立的 xterm 订阅（见 subscribeTerminalInput），
      // 加上 search addon 的 onDidChangeResults（计数订阅）。三者都在 cleanup 里释放。
      // 少数一个就等于把一条泄漏账瞒下去。
      listeners: 8
    })

    let disposed = false
    let observedOutput = false
    let attachmentId: string | null = null
    let readyForLiveOutput = false
    let cursor = 0
    let outputTail = Promise.resolve()
    const liveOutputQueue: TerminalLiveOutputChunk[] = []
    let liveDrain: Promise<void> | null = null
    const pending: RuntimeEvent[] = []
    let pendingBytes = 0
    let droppedPendingThrough = 0
    // 下游程序自己声明的 kitty keyboard 状态，决定 Shift+Enter 送 CSI-u 还是退回 ESC+CR。
    let kittyKeyboard = initialKittyKeyboardState()
    let renderReady: { dispose(): void } | null = null
    const viewport = new TerminalViewportSynchronizer({
      proposeGrid: () => fit.proposeDimensions() ?? null,
      fit: () => fit.fit(),
      readGrid: () => ({ cols: terminal.cols, rows: terminal.rows }),
      resize: async ({ cols, rows }) => {
        // 进程已死时不向 PTY 发 resize（effect 不再随 processState 重挂，
        // ResizeObserver 仍可能在 exit 后触发）。返回 false 而不是静默 resolve：
        // 这次几何没到 PTY，synchronizer 不许把它记成 PTY 的当前尺寸，否则恢复运行后
        // 同一几何被相同-key 短路吞掉，网格永久停在退出前（见 viewport-sync 的 resize 合同）。
        if (!canControlRunRef.current || attachmentId === null) return false
        await api.sessions.resize(attachmentId, cols, rows)
        return true
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
    viewport.setVisible(visibleRef.current)
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

    const drainLiveOutput = async (): Promise<void> => {
      // Let same-turn IPC events accumulate so xterm sees one visual write instead of one write
      // per RuntimeEvent. The loop remains bounded and yields between batches when output is large.
      await yieldTerminalWork()
      while (!disposed && liveOutputQueue.length > 0) {
        const taken = takeTerminalLiveOutputBatch(liveOutputQueue)
        liveOutputQueue.splice(0, liveOutputQueue.length, ...taken.rest)
        // 重叠三分（整块已有 / 部分已有 / 真的缺了一段）全在 lib 里判，这里只转发：
        // 「部分已有」曾落到告示分支，于是无缺字节也报缺、且把已显示的内容重写一遍。
        const composed = composeTerminalLiveOutputWrite(taken.batch, cursor)
        if (composed.data.length === 0) {
          // 整批都已在屏上。cursor 仍要跟上（它只增不减），否则同一批会被反复认成新字节。
          cursor = composed.cursor
          continue
        }
        const data = composed.data
        const nextCursor = composed.cursor
        await terminalWrite(terminal, data)
        kittyKeyboard = readKittyKeyboardOutput(kittyKeyboard, data)
        cursor = nextCursor
        acknowledger.queue(cursor)
        if (liveOutputQueue.length > 0) await yieldTerminalWork()
      }
    }

    const scheduleLiveOutputDrain = (output: TerminalLiveOutputChunk): void => {
      if (disposed) return
      // 入队必须**经过** admit：直接 push 会让这个队列无界，而 attach 之后再没有第二道闸
      // （MAX_PENDING_* 那对只管 attach 前的启动缓冲）。积压超上限时从队头丢，省略由 drain 里
      // 既有的「序列不连续」告示如实说出来。
      const admitted = admitTerminalLiveOutput(liveOutputQueue, output)
      liveOutputQueue.splice(0, liveOutputQueue.length, ...admitted.queue)
      if (liveDrain) return
      const drain = drainLiveOutput()
      liveDrain = drain
      outputTail = drain
      void drain.finally(() => {
        if (liveDrain !== drain) return
        liveDrain = null
        // A late event can arrive in the same turn the drain observes an empty queue. Keep the
        // queue live without turning it into a second output owner.
        if (!disposed && liveOutputQueue.length > 0) scheduleLiveOutputDrain(liveOutputQueue.shift()!)
      }).catch(() => {})
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
      scheduleLiveOutputDrain({
        data: output.data,
        startByte: output.startByte,
        endByte: output.endByte
      })
    }
    const disposeEvents = api.sessions.onEvent(accept)
    const resize = new ResizeObserver(() => viewport.observeViewport())
    resize.observe(root)
    /**
     * 输入的唯一出口。四条通路（onData、onBinary、OSC 回复、Shift+Enter）都送进这里——
     * 少卡一条就等于没卡，用户总会找到那一条。
     *
     * 闸不写在这里：`terminalInputSender` 把「判定 + 送出」一起收在 lib 里，所以这个组件里
     * 没有一个可以写反的 `if`。此前三处各写一个 `if (acceptsInputNow())`，把它们一起取反
     * 76 条断言全绿——文本守卫数得出闸的**个数**，数不出**极性**。
     *
     * onData 与 onBinary 是同一件事（用户输入）的两个编码面，共用这同一把闸：xterm 对鼠标上报
     * 有两个出口——SGR 编码（程序开了 DECSET ?1006）走 onData，是 ASCII；只开旧式协议
     * （?1000/?1002/?1003 或 ?9 而没开 ?1006）时坐标字节可能 ≥128、是 latin1 语义，xterm 为了
     * 不被 UTF-8 破坏改走 onBinary。少订阅 onBinary，旧式鼠标 TUI（很多 ncurses 程序、旧配置的
     * vim/htop）里鼠标就**完全没反应**，而现代 TUI 里鼠标正常——极难归因到这里。编码差异只在
     * 源头处理（见 subscribeTerminalInput / encodeTerminalBinaryInput）：latin1 字节必须以
     * Uint8Array 身份透传，否则 SDK 的 UTF-8 编码会把 0x80 拆成 0xC2 0x80、坐标毁掉。
     */
    const sendInput = terminalInputSender({
      accepts: () =>
        terminalAcceptsInput({
          canControlRun: canControlRunRef.current,
          acceptsInput: acceptsInputRef.current,
          liveReady: readyForLiveOutput
        }),
      write: (data) => {
        void api.sessions.write(session.control, data)
      }
    })
    const input = subscribeTerminalInput(terminal, sendInput)
    const selection = terminal.onSelectionChange(() => {
      const text = terminal.getSelection()
      if (text) rememberedSelectionRef.current = text
      setHasSelection(text.length > 0)
    })
    const oscHandlers = installTerminalOscHandlers(terminal, {
      isReplaying: () => !readyForLiveOutput,
      respondFromRenderer: session.kind === 'terminal',
      sendInput,
      // PTY 里的 TUI（nvim / fzf / lazygit）用 OSC 52 往剪贴板写。走的是和 Cmd+C 同一个出口，
      // 所以失败同样响亮报错，不会静默丢。
      writeClipboard: (text) => {
        void copyTextToClipboard(text, reportError)
      }
    })
    // 原生 Cmd+V 是 Electron 的 editMenu role，不经过应用的任何 JS，只能在 DOM 层截。装在
    // terminal.element（xterm 自己那棵子树的根，terminal.open 之后才存在）而不是 root 上，是**结构性
    // 作用域**：粘贴目标只可能是它子树里那个 helper textarea，而终端搜索框那个 input 是 root 的另一个
    // 孩子、不在这棵子树里——往搜索框粘贴天然走不到这里，不需要在运行期比对 event.target。
    // 理由与 xterm「只包不转义」的证据见 terminal-paste.ts。
    //
    // element 在 open() 之后必然在场，但类型上是可选的。缺席时**响亮**说出来：那意味着原生 Cmd+V
    // 这条路完全没有消毒，而它恰恰是更常用的那条——静默兜底会把一个安全缺口伪装成正常启动。
    const pasteHost = terminal.element
    if (!pasteHost) {
      console.warn('[terminal] xterm element missing after open(); native paste will not be sanitized')
    }
    const pasteSanitizer = pasteHost ? installTerminalPasteSanitizer(pasteHost, terminal) : () => {}
    // 终端作用域的键判定统一从注册表匹配（scope 'terminal'），命中之后做什么由
    // terminalShortcutHandlers 提供——那一层是纯的，能被直接调用并断言后果。此前这些分支内联在
    // 这里，运行期够不着：把任一分支的体掏空，整族测试照旧全绿而那个键对用户彻底失效。
    // 终端键的判定与吞键全在 terminalKeyEventHandler 里，这里刻意只剩一句转发：把逻辑留在组件
    // 内时它运行期够不着（renderToStaticMarkup 不跑 effect，更不会触发 xterm 的键回调），于是
    // 「分支体被掏空」「回调开头插一句早退」这两种变异都能在全绿下存活。壳里没有语句可插，
    // 那两族变异就都落在 terminal-shortcuts.test.ts 的射程里。
    //
    // Paste 刻意没有条目，理由有两层。其一：本回调返回 false 不会 preventDefault（xterm 的 _keyDown
    // 在 cancel() 之前就返回），所以原生 Edit→Paste 路径照旧触发；在这里也处理会让同一份文本贴两次。
    // 其二：原生 Cmd+V 走的是浏览器 paste 事件，压根不经过键回调——它由
    // installTerminalPasteSanitizer 在 terminal.element 上以捕获期接管（见 terminal-paste.ts），
    // 那才是「粘贴的字节要不要消毒」这件事的落点。
    terminal.attachCustomKeyEventHandler(
      terminalKeyEventHandler({
        matchTerminalShortcut: (event) => matchShortcut(event, isMac, { scope: 'terminal' }),
        hasSelection: () => terminal.hasSelection(),
        sendInput,
        kittyKeyboardActive: () => isKittyKeyboardActive(kittyKeyboard),
        setSearchOpen,
        readSelection: () => terminal.getSelection(),
        rememberSelection: (text) => {
          rememberedSelectionRef.current = text
        },
        writeClipboard: (text) => {
          void copyTextToClipboard(text, reportError)
        },
        clear: () => terminal.clear()
      })
    )

    /**
     * 揭示的兜底时限（AGENTS.md 原则 11）。
     *
     * 恢复态此前只有两个出口——全链成功、attach 抛错——所以链上任一处"既不成功也不抛错"就是
     * 永久转圈，而 ctxmux / Run / PTY 全都好着。这个 timer 是那一类的唯一出口：到点把画布交还
     * 用户，并置 `revealOverdue` 让服务窗说清情况。用 `setTimeout` 而非 `setInterval`——后者是
     * 常驻开销，且在 retention 测试的黑名单里。
     */
    let revealed = false
    const reveal = (forced = false, clearNotice = true): void => {
      if (disposed) return
      if (!revealed) {
        revealed = true
        setHydrating(false)
      }
      // A late successful attach/replay supersedes the deadline notice. The local `revealed` guard
      // still prevents a second DOM transition, while this state update removes a stale warning.
      if (clearNotice) setRevealOverdue(forced)
    }
    const revealStartedAtMs = Date.now()
    const revealDeadline = setTimeout(() => {
      if (disposed) return
      const decision = terminalRevealDecision({
        revealed,
        startedAtMs: revealStartedAtMs,
        nowMs: Date.now(),
        deadlineMs: TERMINAL_REVEAL_DEADLINE_MS
      })
      if (!decision.reveal) return
      // 强制揭示绝不静默：先记账，再揭示。
      reveal(decision.overdue)
    }, TERMINAL_REVEAL_DEADLINE_MS)

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
          async (data) => {
            await terminalWrite(terminal, data)
            // 回放也要读：重新 attach 到一个早已协商过的 Agent 时，那次协商就在回放里。
            // 漏掉它会让协议状态静默退回"没协商过"，Shift+Enter 于是送错编码。
            kittyKeyboard = readKittyKeyboardOutput(kittyKeyboard, data)
          }
        ) ?? cursor
        // 重放的那一屏是按**此刻**的 grid 排的。记下来，起活时才判得出它有没有排错宽度：
        // 后面第一次 live fit 若把 grid 挪到别处，那一屏就是按错的宽度排的，而 alt screen
        // 不会自行重排（详见 viewport-sync 的 `gridWhenReplayLanded`）。
        viewport.markReplayLanded()
        // Initial attaches and true rebuilds have no previous viewport to restore. Explicitly pin
        // their first visible frame to the latest output instead of relying on xterm's parser
        // default, which can be the top of a freshly-created normal buffer.
        if (visibleRef.current) restoreRememberedViewport(terminal)
        if (droppedPendingThrough > cursor) {
          await terminalWrite(
            terminal,
            '\r\n\u001b[33m[Live output exceeded the pane startup buffer; omitted bytes were acknowledged]\u001b[0m\r\n'
          )
          cursor = droppedPendingThrough
        }
        // 画面正确真正依赖的就是上面这些字节写完——隐藏画布的正当理由到此结束，先揭示。
        // 恢复收尾（live 视口同步 / gap redraw）继续跑，但不再决定画面何时可看：它经
        // api.sessions.resize 与 attach 争用同一把按 Run 串行的锁，排在揭示之前时，该 Run 上
        // 任一不 settle 的操作都会让一个健康的终端被永久藏起来。
        reveal()
        if (autoFocusRef.current) terminal.focus()
        await finishTerminalReplayRecovery({
          gap: Boolean(result.gap),
          canControlRun: canControlRunRef.current,
          startLiveSynchronization: async () => await viewport.startLiveSynchronization(),
          releaseLiveOutput: async () => {
            readyForLiveOutput = true
            if (!disposed) setLiveOutputReady(true)
            if (cursor > 0) acknowledger.queue(cursor)
            for (const event of pending.splice(0)) accept(event)
            await outputTail
          },
          redrawCurrentScreen: async () => {
            const redrawn = await viewport.requestContentRedraw()
            await outputTail
            return redrawn
          },
          onRedrawError: (error) => console.warn('[terminal] failed to redraw after replay gap', error),
          onRecoveryError: (error) => console.warn('[terminal] live viewport recovery degraded', error)
        })
      } catch (error) {
        if (!disposed) {
          setAttachFailed(true)
          const detail = (error instanceof Error ? error.message : String(error))
            .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
          await terminalWrite(
            terminal,
            `\r\n\u001b[31m[Attach failed: ${detail}]\u001b[0m\r\n`
          )
          // Preserve an already-visible deadline warning when attach fails late. Clearing it would
          // turn the only honest diagnosis into a silent failure after the canvas was handed back.
          reveal(false, false)
        }
      }
    })()

    viewport.observeViewport()
    if (autoFocusRef.current) requestAnimationFrame(() => terminal.focus())
    return () => {
      disposed = true
      clearTimeout(revealDeadline)
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
      oscHandlers.dispose()
      searchCounter.dispose()
      selection.dispose()
      pathLinks.dispose()
      pasteSanitizer()
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
    const text = terminalSelectionForCopy(terminal?.getSelection() ?? '', rememberedSelectionRef.current)
    if (!text) return
    rememberedSelectionRef.current = text
    void copyTextToClipboard(text, reportError)
  }

  function pasteClipboard(): void {
    const terminal = terminalRef.current
    if (!terminal) return
    void api.ui.readClipboardText().then((text) => {
      // 走 pasteIntoTerminal 而不是 terminal.paste：ESC 怎么办由 Core 那一个函数说了算，
      // 与原生 Cmd+V 那条路（installTerminalPasteSanitizer）以及 provider 投递 prompt 同源。
      if (terminalRef.current === terminal && text) pasteIntoTerminal(terminal, text)
    })
  }

  function closeSearch(): void {
    searchAddonRef.current?.clearDecorations()
    setSearchOpen(false)
    // 提示是对**这一次**输入的说明，关掉就过期了。留着它，下次打开面板会挂着一句上次的
    // 「正则还不完整」——那时用户还没输任何东西，这句话就成了假话。开关本身不重置：
    // 成熟编辑器都记住它们，打开搜索发现上次的条件还在才是符合预期的。
    setSearchNotice(undefined)
    // 计数同理，而且必须显式清：clearDecorations 只擦掉高亮，addon 不会为"擦干净了"再发一次
    // 结果事件。不清的话，下次打开面板会先亮着上次的「3 of 47」，而那时输入框里什么都没有。
    setSearchCount(undefined)
    terminalRef.current?.focus()
  }

  // 开关状态**永远显式传入**，没有"用当前 state"这个省事的重载。
  //
  // 原本这里有两个函数：searchWith(query, toggles) 和一个替你读 state 的 searchTerminal(query)。
  // 后者是个陷阱：setState 是异步的，点开关那条路径必须传翻转后的新值，读 state 会拿到旧的，
  // 于是第一次点不生效、第二次才生效。更糟的是它把「用哪份开关」变成了调用点的自由，
  // 而这个自由在测试里够不着——把某一条路径的 toggles 换成默认值，30 条断言一条都不会红
  // （第一轮 review 实测如此）。参数没有默认值，漏传就编译不过，于是"传错开关"这种事
  // 从运行期缺陷降级成编译期错误。
  //
  // 函数体只剩转发。此前它自己取 addon、调 runTerminalSearch、接 notice——那三步长在组件里，
  // 只有源码文本断言够得着，而文本断言看不见"这一行有没有被执行到"：在这里插一句早退，
  // 搜索四条通路对用户全部失效而 40 条断言全绿（实测）。现在那三步在
  // lib/terminal-search.ts 的 searchTerminalFromSurface 里，跑得到、断言得着。
  function searchWith(
    query: string,
    toggles: TerminalSearchToggles,
    previous = false
  ): void {
    searchTerminalFromSurface({
      addon: searchAddonRef.current,
      query,
      toggles,
      direction: previous ? 'previous' : 'next',
      showNotice: setSearchNotice
    })
  }

  const startupPhase = terminalStartupPhase({
    hydrating,
    attachFailed,
    agent: session.kind === 'agent',
    running: canControlRun,
    hasOutput,
    revealOverdue
  })

  const revealNotice = serviceNoticeToRender(
    classifyServiceNotice(
      terminalRevealServiceOutcome({
        overdue: revealOverdue,
        processState: session.processState,
        liveReady: liveOutputReady
      })
    )
  )

  return (
    <Fragment>
      <TerminalContextMenu
        hasSelection={hasSelection}
        mouseTrackingMode={mouseTrackingMode}
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
              // xterm may clear its live selection while the native context-menu gesture
              // moves focus. Snapshot it before that transition so Radix Copy stays enabled.
              if (event.button === 2) {
                const text = terminalRef.current?.getSelection() ?? ''
                if (text) {
                  rememberedSelectionRef.current = text
                  setHasSelection(true)
                }
                // 与上面同因同时：菜单即将打开，此刻采样鼠标上报模式。选区为空时**尤其**要采——那正是
                // 需要解释「为什么 Copy 是灰的」的情形，若只在有选区时采样，提示永远不会出现。
                const mode = terminalRef.current?.modes.mouseTrackingMode
                if (mode) setMouseTrackingMode(mode)
              }
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
              {linkPreview.kind === 'http' ? (
                <>
                  <ExternalLink size={13} />
                  <span className="terminal-link-preview__url" title={linkPreview.url}>
                    {linkPreview.url}
                  </span>
                  <kbd className="terminal-link-preview__hint">
                    {linkPreview.fastPath
                      ? 'Open in browser'
                      : `${isMac ? '⌘' : 'Ctrl'}+click to open · click to choose`}
                  </kbd>
                </>
              ) : (
                <>
                  <FileCode size={13} />
                  <span className="terminal-link-preview__url" title={linkPreview.label}>
                    {linkPreview.label}
                  </span>
                  <kbd className="terminal-link-preview__hint">click to open</kbd>
                </>
              )}
            </div>
          ) : null}
          {startupPhase === 'restoring' ? (
            <div className="terminal-hydration" role="status" aria-live="polite">
              <div className="terminal-hydration__content">
                <div className="terminal-hydration__line">
                  <span className="terminal-hydration__cursor" aria-hidden="true" />
                  <strong className="terminal-hydration__label">Restoring terminal…</strong>
                </div>
                <span className="terminal-hydration__hint">Replaying retained output.</span>
              </div>
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
          {/* 服务窗（原则 11）：揭示是被 deadline 逼出来的时，绝不静默——画布已交还，同时说清
              哪一步没走通、终端此刻可用、怎么恢复完整滚动历史。判据是这个 Run 还能不能干活，
              判定全在 lib/terminal-reveal.ts，这里只渲染结果。没有告示就连容器都不挂，
              否则一个空壳会盖在画布上吃掉指针事件。 */}
          {revealNotice ? (
            <div className="terminal-service-window">
              <ServiceWindowNotice notice={revealNotice} />
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
                  searchWith(event.target.value, searchToggles)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') searchWith(searchQuery, searchToggles, event.shiftKey)
                  if (event.key === 'Escape') closeSearch()
                }}
              />
              {/* 「3 of 47」。位置在输入框与上下箭头**之间**：它回答的是"我现在在第几个、一共几个"，
                  而那两个箭头就是拿它导航的，读起来是一句连贯的话。这里也常驻 live region 而不是
                  条件插入——理由同下面的 notice。空文案时收起来，搜索条恢复成原来的宽度。 */}
              <span className="terminal-search__count" role="status" hidden={!searchCount}>
                {searchCount ?? ''}
              </span>
              <button type="button" title="Previous match" onClick={() => searchWith(searchQuery, searchToggles, true)}><ChevronUp size={13} /></button>
              <button type="button" title="Next match" onClick={() => searchWith(searchQuery, searchToggles)}><ChevronDown size={13} /></button>
              {/* 三个开关。能力本来就在 addon 里，这里只是把它露出来。翻转后**立刻按新条件重搜**
                  ——留着上一次的结果会让开关看起来没生效，那比没有开关更糟。
                  aria-pressed 而非颜色单独承载状态：色觉差异下仍读得出哪个开着。 */}
              {SEARCH_TOGGLES.map(({ key, label, glyph }) => (
                <button
                  key={key}
                  type="button"
                  className="terminal-search__toggle"
                  title={label}
                  aria-label={label}
                  aria-pressed={searchToggles[key]}
                  data-active={searchToggles[key] ? '' : undefined}
                  onClick={() => {
                    const next = toggleTerminalSearch(searchToggles, key)
                    setSearchToggles(next)
                    searchWith(searchQuery, next)
                  }}
                >{glyph}</button>
              ))}
              <button type="button" title="Close find" onClick={closeSearch}><X size={13} /></button>
              {/* live region **常驻**，只换里面的文字。读屏软件播报的是已存在区域内的**内容变化**；
                  连同区域一起插进来的文字，好几款读屏都不会念——那等于这句话只对看得见的人说。
                  没话说时用 hidden 收起来，区域还在，但不占位、不画那层玻璃背景。 */}
              <span className="terminal-search__notice" role="status" hidden={!searchNotice}>
                {searchNotice ?? ''}
              </span>
            </div>
          ) : null}
        </div>
      </TerminalContextMenu>
      <OpenDestinationPopover
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
