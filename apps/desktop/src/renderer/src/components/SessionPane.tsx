import { AlertTriangle, LoaderCircle, RefreshCw, RotateCcw, ServerOff } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store'
import type { AgentMuxRunExitReason, AgentProviderId } from '@agentmux/core'
import { TERMINAL_FONT_SIZE_DEFAULT } from '../../../shared/contracts'
import {
  dismissOpenDestinationRequest,
  type OpenDestination,
  type OpenHttpLinkOrigin
} from '../lib/open-destination'
import { terminalLinkModifierOpensSystemBrowser } from '../lib/terminal-link-gesture'
import { CONNECTION_UNRECOVERABLE_DETAIL } from '../lib/session-state'
import { regionDisplayName, regionSurfaceLabel } from '../lib/region-display-name'
import { regionIds } from '@agentmux/layout'
import { sessionRecoveryClassName, sessionRecoveryState } from '../lib/session-recovery-banner'
import { workspaceRootForPath } from '../lib/workbench-tabs'
import { api } from '../lib/api'
import type { ConversationSpeaker } from '../lib/conversation-speaker'
import type { LinkClickModifiers } from './AgentMarkdown'
import { AgentSessionComposer } from './AgentSessionComposer'
import { AgentInteractionCard } from './AgentInteractionCard'
import { ActivityView } from './ActivityView'
import { OpenDestinationPopover, type OpenDestinationRequest } from './OpenDestinationBar'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { TerminalView } from './TerminalView'
import { agentPromptDeliveryServiceOutcome, agentSessionServiceOutcome, classifyServiceNotice, serviceNoticeToRender } from '../lib/service-window-notice'
import { isMacPlatform } from '../lib/host-platform'
import {
  classifyContinuityFailure,
  continuityRefreshEnabled,
  continuityRetryEnabled
} from '../lib/continuity-failure-notice'

const NO_TIMELINE_ITEMS: never[] = []

const INTERRUPTION_REASON_COPY: Record<string, string> = {
  daemon_restart: 'The terminal backend restarted, so this session’s process was lost. Open a new session to continue here.',
  tmux_server_unavailable: 'The terminal backend became unavailable and this session’s process was lost. Open a new session to continue here.',
  tmux_target_changed: 'The underlying terminal target changed, so this session could no longer be tracked. Open a new session to continue here.',
  tmux_protocol_error: 'The terminal backend hit a protocol error and this session’s process was lost. Open a new session to continue here.'
}

function humanizeDetail(
  interruptionReason: string | undefined,
  detail: string | undefined,
  exited: boolean,
  exitReason: AgentMuxRunExitReason | undefined
): string {
  if (interruptionReason && INTERRUPTION_REASON_COPY[interruptionReason]) {
    return INTERRUPTION_REASON_COPY[interruptionReason]
  }
  // 退出时，先按 Core 合成的原因说清「是你关的还是它崩的」——这正是 T-012 要区分的事。
  if (exited && exitReason) {
    if (exitReason === 'user-stopped') return 'You stopped this session.'
    if (exitReason === 'crashed') return 'The process exited on its own.'
    // unknown：诚实说读不出结论，绝不把裸 0 冒充成干净完成。
    return 'The process is no longer running; the reason could not be determined.'
  }
  if (!detail) return exited ? 'The process is no longer running.' : 'Check the host and try again.'
  return detail
}

export function SessionPane({
  sessionId,
  surfaceKind,
  interactiveResize,
  visible,
  parked = false,
  linkOrigin
}: {
  sessionId: string
  surfaceKind: 'agent' | 'terminal'
  interactiveResize: boolean
  // 这一格看不看得见。隐藏的 Tab 留在 DOM 里保住终端实例，但里面的终端一律停工。
  visible: boolean
  /** Long-hidden, replayable terminal views may release xterm/addons while keeping this Region alive. */
  parked?: boolean
  linkOrigin: OpenHttpLinkOrigin
}) {
  const session = useAppStore((state) => state.sessions.find((item) => item.id === sessionId))
  // 这一格叫什么——喂给 composer 右上角的水印。名字取决于兄弟格（"Terminal" 只有在另一格也叫
  // "Terminal" 时才成 "Terminal 2"），所以这里按 WorkspaceWorkbench 喂换位子菜单的同一形状装配：
  // regionIds(layout.root) 给视觉顺序（左→右/上→下）、regionSurfaceLabel 给每格短名，再交给
  // regionDisplayName 做唯一那份去重编号。两个消费者（水印、换位菜单）由此共用同一次派生，不会分家。
  // linkOrigin 缺 tabId/regionId（无 Region 上下文的宿主）时返回 undefined，水印随之整段缺席——这与
  // canSplit 读的是同一对真相。选择器返回原始字符串，zustand 默认 Object.is 比较即可，无引用抖动。
  const regionName = useAppStore((state) => {
    if (!linkOrigin.tabId || !linkOrigin.regionId) return undefined
    const tab = state.tabs?.[linkOrigin.tabId]
    if (!tab) return undefined
    const regions = regionIds(tab.layout.root).flatMap((regionId) => {
      const region = tab.regions[regionId]
      return region ? [{ regionId, label: regionSurfaceLabel(region, state.sessions) }] : []
    })
    return regionDisplayName(regions, linkOrigin.regionId)
  })
  const timeline = useAppStore((state) => state.timelines[sessionId]?.items ?? NO_TIMELINE_ITEMS)
  const terminalThemeId = useAppStore((state) => state.config?.appearance.terminalTheme)
  const terminalFontSize = useAppStore(
    (state) => state.config?.appearance.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT
  )
  const viewMode = useAppStore((state) => state.viewModes[sessionId] ?? 'terminal')
  // 说话人身份 → 「叫什么、画哪个 provider」。这一层是唯一持有 Session 的地方，所以查 store 归这里；
  // ActivityView 与两条轴都保持受控，可以在无 DOM 的测试里直接求值。
  //
  // 名字是身份的判别器（见设计 SSOT 里那条实测：颜色在同 provider 下不足以区分），所以 agent 这一路
  // 用 Session 自己的 label 而不是 provider 的品牌名——两条 Claude 会有两个不同的 label，却共用同一枚
  // 品牌图标与可能相近的色相。人类这一路今天只有一个身份。
  const describeSpeaker = useMemo(
    () =>
      (speaker: ConversationSpeaker): { name: string; providerId?: AgentProviderId } =>
        speaker.role === 'human'
          ? { name: 'You' }
          : {
              name: session?.label ?? 'Agent',
              ...(session?.kind === 'agent' && session.providerId ? { providerId: session.providerId } : {})
            },
    [session?.label, session?.kind, session?.kind === 'agent' ? session.providerId : undefined]
  )
  const refreshSession = useAppStore((state) => state.refreshSession)
  const recoverSession = useAppStore((state) => state.recoverSession)
  const respondInteraction = useAppStore((state) => state.respondInteraction)
  // Same two reads TerminalView makes for its path links, for the same reason: an Agent that writes
  // `src/foo.ts` means the same file in the Activity projection as in the Terminal one. The root comes
  // from the WorkspaceRecord (NOT session.workspacePath) so worktree/scratch sessions still relativize
  // absolute paths against the base main actually resolves against.
  //
  // Keyed on THIS pane's own session, not on activeWorkspaceId. The two diverge after "Move to
  // Workspace": that reducer relocates the display identity and deliberately never touches
  // session.workspacePath (see move-session-view.ts), so a moved pane's session still lives under its
  // original root while the active workspace is the target. Reading the active root there is not merely
  // "unshortened" — when the wrong root is an ANCESTOR of the session path, the boundary guard in
  // shortenPath matches and strips it, producing a relative path rooted at the wrong repo. Measured:
  // session /Users/me/proj/repo/src/auth.ts under a wrong root of /Users/me/proj renders `repo/src/auth.ts`,
  // which reads as a real answer. A wrong path that looks right is worse than a long one.
  //
  // workspaceRootForPath asks containment, not ownership — a subdirectory terminal (/repo/sub) is
  // owned by no workspace exactly, and answering '' there would make its absolute path links
  // unclickable. See the same note in TerminalView.
  const openFile = useAppStore((state) => state.openFile)
  const reportError = useAppStore((state) => state.reportError)
  const activeWorkspaceRoot = useAppStore((state) =>
    (session ? workspaceRootForPath(state.config ?? null, session) : undefined) ?? ''
  )
  // Lands the file in this pane's own Tab Group, exactly as a terminal path click does. A miss
  // surfaces through reportError — "click opened nothing" is never silent.
  const openWorkspaceFile = useCallback(
    (path: string, location?: { line: number; column?: number }) => {
      void openFile(path, linkOrigin.tabGroupId, location).catch(reportError)
    },
    [openFile, reportError, linkOrigin.tabGroupId]
  )
  // A pasted image cited in the conversation is read back through main (the only place that can reach a
  // file outside the workspace) as an <img>-ready data URI. Main confines the read to the pasted
  // directory; a null return means "not a readable pasted image", and the renderer falls back to the
  // plain-text reference. Stable identity so the thumbnail's load effect does not re-fire each render.
  const readPastedImage = useCallback((path: string) => api.ui.readPastedImage(path), [])
  // An http(s) link in agent prose gets the SAME destination menu the Terminal gives, opening into this
  // pane's own Region — never a jump straight to the system browser. This is the host that owns the menu
  // because it is the host that holds the Region origin, mirroring TerminalView exactly.
  const openHttpLink = useAppStore((state) => state.openHttpLink)
  const [linkRequest, setLinkRequest] = useState<OpenDestinationRequest | null>(null)
  const nextLinkRequestIdRef = useRef(0)
  // canSplit reports the TRUTH of this origin: a directional destination needs a precise Tab+Region, and
  // choosing one without them throws in the Store. Only when both are present are the split items live.
  const canSplit = Boolean(linkOrigin.tabId && linkOrigin.regionId)
  const onProseLinkClick = useCallback(
    (url: string, event: LinkClickModifiers) => {
      const isMac = isMacPlatform()
      // Cmd (macOS) / Ctrl (elsewhere) + click opens the system browser immediately, skipping the menu —
      // the SAME judgement the Terminal uses, so the two surfaces cannot drift on the modifier.
      if (terminalLinkModifierOpensSystemBrowser(event, isMac)) {
        void openHttpLink(linkOrigin, url, 'system').catch(reportError)
        return
      }
      setLinkRequest({
        id: ++nextLinkRequestIdRef.current,
        url,
        x: event.clientX,
        y: event.clientY
      })
    },
    [openHttpLink, linkOrigin, reportError]
  )
  const onProseLinkSelect = useCallback(
    (destination: OpenDestination) => {
      const request = linkRequest
      if (!request) return
      setLinkRequest((current) => dismissOpenDestinationRequest(current, request.id))
      void openHttpLink(linkOrigin, request.url, destination).catch(reportError)
    },
    [linkRequest, openHttpLink, linkOrigin, reportError]
  )
  const [refreshing, setRefreshing] = useState(false)
  const [recovering, setRecovering] = useState(false)
  // daemon_restart auto-recovery fires at most once per dead session id, so a flapping
  // daemon can't spin us into a relaunch loop. Keyed by the session id we last recovered from.
  const autoRecoveredRef = useRef<string | null>(null)

  const disconnected = session?.status.state === 'disconnected'
  const missing = session?.processState === 'interrupted' && session?.status.state === 'error'
  const exited = session?.processState === 'exited'
  const interruptionReason = session?.interruptionReason
  const continuity = session?.status.continuity
  // Which of Core's reasons this is decides the title, the body and whether retry can work.
  // The conflict class comes along too: its two values ask for opposite actions.
  const continuityNotice = classifyContinuityFailure(
    continuity,
    session?.status.continuityReason,
    session?.status.continuityConflict
  )

  async function recover(): Promise<void> {
    if (recovering) return
    setRecovering(true)
    await recoverSession(sessionId)
    setRecovering(false)
  }

  // Terminals whose backend restarted (daemon_restart) can never come back by refreshing —
  // the PTY is gone. Auto-relaunch a fresh terminal in the same cwd and rebind the tab,
  // replacing the useless "Check again" with a seamless recovery. One-shot per session id.
  useEffect(() => {
    if (!session || session.kind !== 'terminal') return
    if (!missing || interruptionReason !== 'daemon_restart') return
    if (autoRecoveredRef.current === session.id) return
    autoRecoveredRef.current = session.id
    void recover()
    // recover()/recovering are stable enough; we intentionally key only on the dead-session signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, session?.kind, missing, interruptionReason])

  // A launching Region exists before Core returns its Session snapshot. Keep that handoff
  // neutral; interrupted and exited Sessions use the explicit recovery banners below.
  if (!session || !terminalThemeId) {
    return (
      <section className="agent-surface">
        <div className="pane-state" role="status" aria-live="polite">
          <LoaderCircle className="spin" size={18} />
          <strong>Connecting to this session…</strong>
          <span>Waiting for the Core client to publish this Runtime View.</span>
        </div>
        {surfaceKind === 'agent' ? <AgentSessionComposer sessionId={sessionId} disabled {...(regionName ? { regionName } : {})} /> : null}
      </section>
    )
  }

  const noun = session.kind === 'agent' ? 'Agent' : 'Terminal'
  // 失联分两类，标题也必须分两类：还在重连 vs 已经放弃。判据取自 detail（连接投影写下的那一对
  // SSOT 常量），而不是另起一个状态位——状态位就是 `disconnected`，两类共用它。只认一个标题的话，
  // 抖动预算用尽后的终局会顶着「Reconnecting…」的皮，用户永远不知道该自己动手了。
  const gaveUpReconnecting =
    disconnected && session.status.detail === CONNECTION_UNRECOVERABLE_DETAIL
  // A continuity failure names its own class; the generic banner copy only covers the rest.
  const recoveryTitle = continuityNotice
      ? continuityNotice.title
      : gaveUpReconnecting
        ? `Can’t reach this host`
        : disconnected
          ? 'Remote terminal disconnected'
          : exited
            ? `${noun} process exited`
            : `${noun} session unavailable`

  async function refresh(): Promise<void> {
    if (refreshing) return
    setRefreshing(true)
    await refreshSession(sessionId)
    setRefreshing(false)
  }

  return (
    <section className="agent-surface">
      <div className="agent-body">
        {session.kind === 'terminal' || viewMode === 'terminal' ? (
          <div className="agent-terminal-stage">
            {parked ? (
              <div className="terminal-cold-parked" role="status" aria-live="polite">
                <strong>Terminal parked</strong>
                <span>Switch back to this tab to restore its terminal view.</span>
              </div>
            ) : (
              <TerminalView
                session={session}
                themeId={terminalThemeId}
                fontSize={terminalFontSize}
                interactiveResize={interactiveResize}
                visible={visible}
                linkOrigin={linkOrigin}
              />
            )}
            {disconnected || missing || exited ? (
              <div className={sessionRecoveryClassName(sessionRecoveryState({ disconnected, exited }))} role="status" aria-live="polite">
                <span className="terminal-recovery__icon">
                  {refreshing || recovering ? <LoaderCircle className="spin" size={16} /> : disconnected ? <ServerOff size={16} /> : <AlertTriangle size={16} />}
                </span>
                <div>
                  <strong>{recoveryTitle}</strong>
                  <span>{
                    continuityNotice
                      ? continuityNotice.reason
                      : humanizeDetail(session.interruptionReason, session.status.detail, exited, session.status.exitReason)
                  }</span>
                </div>
                <div className="terminal-recovery__actions">
                  {session.kind === 'terminal' ? (
                    disconnected ? (
                      <button type="button" className="small-button" disabled={refreshing} onClick={() => void refresh()}>
                        <RefreshCw size={12} /> {refreshing ? 'Checking…' : 'Check again'}
                      </button>
                    ) : (
                      // The PTY is gone for good — relaunch a fresh terminal in the same cwd.
                      <button type="button" className="small-button" disabled={recovering} onClick={() => void recover()}>
                        <RotateCcw size={12} /> {recovering ? 'Restarting…' : 'Restart terminal'}
                      </button>
                    )
                  ) : continuityNotice ? (
                    // Four distinct reasons, four distinct things to do. A retry that cannot
                    // succeed is worse than a disabled button: it promises something untrue.
                    // `refresh` deliberately calls refresh(), NOT recover(): this Agent is already
                    // alive on a newer Run, so resuming again would be a second claim on it — the
                    // view only needs to catch up, which refresh does by stable agentSessionId.
                    <button
                      type="button"
                      className="small-button"
                      disabled={
                        !(continuityRetryEnabled(continuityNotice) || continuityRefreshEnabled(continuityNotice)) ||
                        recovering ||
                        refreshing
                      }
                      title={continuityNotice.reason}
                      onClick={
                        continuityRefreshEnabled(continuityNotice)
                          ? () => void refresh()
                          : continuityRetryEnabled(continuityNotice)
                            ? () => void recover()
                            : undefined
                      }
                    >
                      <RotateCcw size={12} /> {
                        recovering && continuityRetryEnabled(continuityNotice)
                          ? 'Resuming…'
                          : refreshing && continuityRefreshEnabled(continuityNotice)
                            ? 'Re-reading…'
                            : continuityNotice.actionLabel
                      }
                    </button>
                  ) : (
                    <button type="button" className="small-button" disabled={recovering} onClick={() => void recover()}>
                      <RotateCcw size={12} /> {recovering ? 'Resuming…' : 'Resume'}
                    </button>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <ActivityView
            items={timeline}
            capability={session.kind === 'agent' ? session.capabilities.timeline : 'unavailable'}
            displayState={session.status.state}
            workspaceRoot={activeWorkspaceRoot}
            openWorkspaceFile={openWorkspaceFile}
            readPastedImage={readPastedImage}
            openHttpLink={onProseLinkClick}
            describeSpeaker={describeSpeaker}
          />
        )}
      </div>
      <OpenDestinationPopover
        request={linkRequest}
        canSplit={canSplit}
        onDismiss={(requestId) =>
          setLinkRequest((current) => dismissOpenDestinationRequest(current, requestId))
        }
        onSelect={onProseLinkSelect}
      />
      {surfaceKind === 'agent' && session.kind === 'agent' ? (
        <div className="agent-input-stack">
          {/* 服务窗（原则 11）：一处我们的流程失败，在阻断用户之前先分清是哪一类。这里的 disconnected
              是样板——终端投影有恢复横幅承载，但 Activity 投影下它此前只剩一个禁用占位，等于静默降级。
              放行 + 明确告知由这条告示补上；判定全在 lib，组件只渲染结果。 */}
          <ServiceWindowNotice
            notice={serviceNoticeToRender(classifyServiceNotice(agentSessionServiceOutcome(session)))}
          />
          <ServiceWindowNotice
            notice={serviceNoticeToRender(classifyServiceNotice(agentPromptDeliveryServiceOutcome(session)))}
          />
          {session.pendingInteraction ? (
            <AgentInteractionCard
              request={session.pendingInteraction}
              // A pending request outlives the process that asked it, so the card must go inert on the
              // same terms as the composer below it — otherwise a dead Run still shows live buttons and
              // answering it fails on a Run that can no longer accept input.
              disabled={session.processState !== 'running' || session.status.state === 'disconnected'}
              onRespond={async (response) => await respondInteraction(session.id, response)}
            />
          ) : null}
          <AgentSessionComposer sessionId={session.id} {...(regionName ? { regionName } : {})} />
        </div>
      ) : null}
    </section>
  )
}
