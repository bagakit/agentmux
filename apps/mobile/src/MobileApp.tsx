import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { TopicKnowledgeSource } from '@agentmux/core/control'
import { MobileTopicSource } from './topics/MobileTopicSource'
import { MobileTopicsSurface, type MobileTopicsContext } from './topics/MobileTopicsSurface'
import { MobileSurveySurface, type MobileSurveyContext } from './survey/MobileSurveySurface'
import { MobileGoalsSurface } from './goals/MobileGoalsSurface'
import { MobileZoneWorkface } from './navigation/MobileZoneWorkface'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import { MobileAgentCreate, type MobileAgentCreateTarget } from './navigation/MobileAgentCreate'
import { MobileAgentActions } from './conversation/MobileAgentActions'
import { recoverMobileAgent } from './conversation/mobile-agent-recovery'
import { MobileAgentMenuContext, type MobileAgentMenuTarget } from './navigation/MobileAgentRow'
import { MobileConversationSurface, type MobileConnection } from './conversation/MobileConversationSurface'
import { MobileTerminalViewer } from './terminal/MobileTerminalViewer'
import { useHostAppearance } from './appearance/useHostAppearance'
import { bindMobileViewport, bindNativeDevice } from './platform/native/device'
import { openBrowserHttpLink } from './platform/browser'
import './mobile.css'
import { getDeviceWorkface, type Navigation } from './recovery/device-workface'
import { MobileRecoveryPanel } from './recovery/MobileRecoveryPanel'
import { exportNativeWorkfaceFile } from './platform/native/workface-file'

import brandIcon from './assets/dragon.png'
import { MobileIdentity, type MobileObjectIdentity } from './navigation/MobileIdentity'
import { MobilePrimaryNavigation } from './navigation/MobilePrimaryNavigation'
import { MobileSpatialNavigation, type MobileSpatialContext } from './navigation/MobileSpatialNavigation'
import { readMobileHome, saveMobileHome, type MobileHome, type MobilePrimaryWorkface } from './navigation/home-preference'
import { MobileGoalWork } from './navigation/MobileGoalWork'
import { MobileMoteProfile } from './navigation/MobileMoteProfile'
import { mobileChatStart } from './navigation/chat-start'
import { useMobileBack } from './navigation/useMobileBack'
import { retainObjectReference, type MobilePresentationRoute, type MobileTopicsRoute, type MobileGoalsContext, type MobileKnowledgeReference } from './recovery/presentation-route'
import type { MobileTopicSourceContentReference } from './topics/source-reference'
import { MobileNotice, MobileNoticeProvider, MobileNoticeRestore, MobileNoticeScope, useMobileNotices } from './notices/MobileNotice'
import { MobileGoalOperationRecovery, MobileGoalOperationSafety } from './goals/goal-operation-recovery'
import { MobileWebDiagnostics } from './mobile-web/MobileWebDiagnostics'
import { MobileWebUpdateSettings } from './mobile-web/MobileWebUpdate'
import { mobileWebUpdateStatus } from './mobile-web/use-mobile-web-observation'
import type { MobileWebPageObservation } from './mobile-web/use-mobile-web-observation'

const ThemeNavigationSubmenuIcon = semanticIconComponent('navigation.submenu')
const ThemeObjectNetworkIcon = semanticIconComponent('object.network')
const ThemeObjectConnectionIcon = semanticIconComponent('object.connection')
const ThemeObjectConversationIcon = semanticIconComponent('object.conversation')
const ThemeActionMoreIcon = semanticIconComponent('action.more')
const ThemeActionComposeIcon = semanticIconComponent('action.compose')
const ThemeStatusInfoIcon = semanticIconComponent('status.info')
const ThemeNavigationBackIcon = semanticIconComponent('navigation.back')
const ThemeActionMenuIcon = semanticIconComponent('action.menu')
const ThemeObjectTerminalIcon = semanticIconComponent('object.terminal')
const ThemeActionCloseIcon = semanticIconComponent('action.close')
const ThemeNavigationSurveyIcon = semanticIconComponent('navigation.survey')

type Workface = Navigation

function loadWorkface(): { workface: Workface; presentation?: MobilePresentationRoute; issue: string | null } {
  const empty: Workface = { selectedSessionId: null, hostUrl: '', panel: 'conversation' }
  try {
    const { record, issue } = getDeviceWorkface().snapshot()
    return { issue, ...(record.presentation ? { presentation: record.presentation } : {}), workface: { selectedSessionId: record.selectedSessionId, hostUrl: record.hostUrl, panel: record.panel } }
  } catch {
    return { workface: empty, issue: '这台设备的导航记录暂时无法读取，原记录尚未覆盖。Mac 上的原会话不受影响；重新选择会话前请先恢复设备存储。' }
  }
}

type MobileAppProps = {
  client: AgentMuxHostedClient | null; connection: MobileConnection; platform: ClientUiPlatform
  native?: boolean; focusComposer?: () => boolean
  connectionPanel?: ReactNode
  webObservation?: MobileWebPageObservation | null
}
export function MobileApp(props: MobileAppProps) {
  return <MobileNoticeProvider><MobileAppContent {...props} /></MobileNoticeProvider>
}
function MobileAppContent({ client, connection, platform, native = false, focusComposer = () => false, connectionPanel, webObservation }: MobileAppProps) {
  const composeAfterClose = useRef<{ client: MobileAppProps['client']; sessionId: string } | null>(null)
  const composeScope = useRef({ client, sessionId: null as string | null, visible: false, focusComposer })
  const connected = connection.state === 'connected'
  const notices = useMobileNotices()
  const initial = useRef<ReturnType<typeof loadWorkface> | null>(null)
  initial.current ??= loadWorkface()
  const navigationRecord = useRef<{ recordId: string | null } | null>(null)
  navigationRecord.current ??= { recordId: getDeviceWorkface().recordIdentity() }
  const [hasConnected, setHasConnected] = useState(connection.state === 'connected' || initial.current.workface.selectedSessionId !== null || initial.current.presentation !== undefined)
  const hostAppearance = useHostAppearance(client, connection.state)
  useEffect(() => { if (connection.state === 'connected') setHasConnected(true) }, [connection.state])
  const [workface, setWorkface] = useState<Workface>(() => ({ ...initial.current!.workface, panel: 'conversation' }))
  const [canPersist, setCanPersist] = useState(initial.current.issue === null)
  const initialHome = useRef(readMobileHome())
  const initialPrimary = initial.current.presentation?.primary ?? initialHome.current.home
  const [home, setHome] = useState<MobileHome>(initialPrimary === 'mote' || initialPrimary === 'space' ? initialPrimary : 'focus')
  const [defaultHome, setDefaultHome] = useState<MobilePrimaryWorkface>(initialHome.current.home)
  const [homeIssue, setHomeIssue] = useState(initialHome.current.issue)
  const [secondary, setSecondary] = useState<'topics' | 'survey' | 'goals' | null>(initialPrimary === 'goals' || initialPrimary === 'topics' || initialPrimary === 'survey' ? initialPrimary : null)
  const [topicsRoute, setTopicsRoute] = useState<MobileTopicsRoute>(initial.current.presentation?.topics
    ?? { context: { categoryId: null, topicId: null, mode: 'discussion' }, sources: [] })
  const [surveyContext, setSurveyContext] = useState<MobileSurveyContext>(initial.current.presentation?.survey
    ?? { zoneId: null, tabId: null, regionId: null })
  const [spatialContext, setSpatialContext] = useState<MobileSpatialContext>(initial.current.presentation?.spatial
    ?? { spaceId: null, tabId: null, regionId: null })
  const [goalsContext, setGoalsContext] = useState<MobileGoalsContext>(initial.current.presentation?.goals
    ?? { goalId: null, mode: 'detail', discussion: null })
  const updateGoalsContext = useCallback((context: MobileGoalsContext) => setGoalsContext(value =>
    JSON.stringify(value) === JSON.stringify(context) ? value : context), [])
  const updateSurveyContext = useCallback((context: MobileSurveyContext) => setSurveyContext(value =>
    value.zoneId === context.zoneId && value.tabId === context.tabId && value.regionId === context.regionId ? value : context), [])
  const updateSpatialContext = useCallback((context: MobileSpatialContext) => setSpatialContext(value =>
    value.spaceId === context.spaceId && value.tabId === context.tabId && value.regionId === context.regionId ? value : context), [])
  const topicId = topicsRoute.context.topicId, source = topicsRoute.sources.at(-1)?.source ?? null
  const sourceReference = topicsRoute.sources.at(-1)?.content
  const sourceBytes = JSON.stringify(source)
  const updateSourceReference = useCallback((content: MobileTopicSourceContentReference) => setTopicsRoute(value => {
    const frame = value.sources.at(-1)
    if (!frame || JSON.stringify(frame.source) !== sourceBytes || JSON.stringify(frame.content) === JSON.stringify(content)) return value
    return { ...value, sources: [...value.sources.slice(0, -1), { ...frame, content }] }
  }), [sourceBytes])
  const updateTopicsContext = useCallback((context: MobileTopicsContext) => setTopicsRoute(value =>
    value.context.categoryId === context.categoryId && value.context.topicId === context.topicId && value.context.mode === context.mode
      ? value : { ...value, context }), [])
  const updateKnowledgeReference = useCallback((knowledge: MobileKnowledgeReference) => setTopicsRoute(value =>
    JSON.stringify(value.knowledge) === JSON.stringify(knowledge) ? value : { ...value, knowledge }), [])
  const leaveSource = useCallback(() => setTopicsRoute(value => {
    const frame = value.sources.at(-1)
    if (!frame) return value
    const { knowledge: _knowledge, ...rest } = value
    return { ...rest, context: frame.origin, sources: value.sources.slice(0, -1),
      ...(frame.originKnowledge ? { knowledge: frame.originKnowledge } : {}) }
  }), [])
  const pageName = secondary === 'topics' ? 'Topics' : secondary === 'survey' ? 'Survey' : secondary === 'goals' ? 'Goals' : home === 'mote' ? 'Mote' : home === 'space' ? 'Space' : 'Focus'
  const rpc = useCallback<NonNullable<AgentMuxHostedClient['forwardRpc']>>((method, params) => {
    if (!client?.forwardRpc) return Promise.reject(new Error('连接暂不可用，原工作面保留。'))
    return client.forwardRpc(method, params)
  }, [client])
  const [showSession, setShowSession] = useState(true)
  const [showGoalWork, setShowGoalWork] = useState(false)
  const [conversationToolsTarget, setConversationToolsTarget] = useState<HTMLDivElement | null>(null)
  const [recentMoteSpaceId, setRecentMoteSpaceId] = useState(initial.current.presentation?.recentMoteSpaceId ?? initial.current.presentation?.identity?.mote?.spaceId ?? null)
  const startupProfile = useRef(initial.current.presentation?.profile ?? null)
  const goalReturn = useRef<{ trigger: HTMLButtonElement; sessionId: string | null } | null>(null)
  useEffect(() => {
    if (showGoalWork || !goalReturn.current) return
    const original = goalReturn.current
    goalReturn.current = null
    if (!showSession || original.sessionId !== workface.selectedSessionId || workface.panel === 'terminal') return
    const document = original.trigger.ownerDocument, focused = document.activeElement
    const frame = document.defaultView?.requestAnimationFrame(() => {
      if (original.trigger.isConnected && !original.trigger.closest('[hidden], [inert]') && document.activeElement === focused)
        original.trigger.focus({ preventScroll: true })
    })
    return () => { if (frame !== undefined) document.defaultView?.cancelAnimationFrame(frame) }
  }, [showGoalWork, showSession, workface.selectedSessionId, workface.panel])
  const closeSession = () => {
    setShowSession(false); setShowGoalWork(false)
    if (startupProfile.current) { setSheet('identity'); startupProfile.current = null }
    if (secondary === 'goals' && goalsContext.discussion?.agentSessionId === workface.selectedSessionId)
      setGoalsContext(value => ({ ...value, discussion: null }))
  }
  const [objectIdentity, setObjectIdentity] = useState<MobileObjectIdentity | null>(initial.current.presentation?.identity ?? null)
  const [profileIdentity, setProfileIdentity] = useState<MobileObjectIdentity | null>(initial.current.presentation?.profile?.identity ?? null)
  const [profileSourcePath, setProfileSourcePath] = useState<string | null>(initial.current.presentation?.profile?.sourcePath ?? null)
  const navigationRevision = useRef(0)
  const originalConnection = useRef({ client, connected }); originalConnection.current = { client, connected }
  const openSession = useCallback((id: string, identity: MobileObjectIdentity) => {
    navigationRevision.current += 1
    if (identity.mote) setRecentMoteSpaceId(identity.mote.spaceId)
    setObjectIdentity(identity); setShowGoalWork(false)
    setWorkface(value => ({ ...value, selectedSessionId: id, panel: 'conversation' }))
    setShowSession(true)
  }, [])
  const openMainAgent = useCallback((id: string, identity: MobileObjectIdentity, hostId: string) => {
    openSession(id, identity)
    const revision = navigationRevision.current, source = client
    if (!source || !connected) { setNotice('连接暂不可用；主 Agent 的原身份、历史与草稿保留，可连接后显式恢复。'); return }
    void recoverMobileAgent({ client: source, agentSessionId: id, expectedHostId: hostId, mode: 'open',
      isCurrent: () => originalConnection.current.client === source && originalConnection.current.connected && navigationRevision.current === revision,
      onNotice: setNotice })
  }, [client, connected, openSession])
  const openSource = (value: TopicKnowledgeSource) => {
    navigationRevision.current += 1
    if (value.kind === 'url') { openBrowserHttpLink(value.url); return }
    setTopicsRoute(current => ({ ...current, context: value.kind === 'topic'
      ? { categoryId: null, topicId: value.topicId, mode: 'discussion' } : current.context,
      sources: [...current.sources, { source: value, origin: current.context,
        ...(current.knowledge ? { originKnowledge: current.knowledge } : {}) }] }))
    setSecondary('topics')
  }
  const openPrimaryWorkface = (value: MobilePrimaryWorkface) => {
    navigationRevision.current += 1
    if (value === 'goals' || value === 'topics') setSecondary(value)
    else { setHome(value); setSecondary(null) }
    setShowSession(false); setShowGoalWork(false)
  }
  const openSurveyTopic = (spaceId: string) => {
    const revision = ++navigationRevision.current
    void rpc('space.inspect', { target: { spaceId } }).then(value => {
      if (revision !== navigationRevision.current) return
      const topic = value.catalog.spaces.find(item => item.spaceId === spaceId)?.topicId
      if (topic) { setTopicsRoute({ context: { categoryId: null, topicId: topic, mode: 'discussion' }, sources: [] }); setSecondary('topics') }
      else setNotice('原 Topic 身份尚未确认，研究与资料保留。')
    }).catch(error => setNotice(error instanceof Error ? error.message : String(error)))
  }
  const sessionTitle = objectIdentity?.name ?? null
  const [sheet, updateSheet] = useState<'connection' | 'settings' | 'identity' | 'actions' | 'agent' | 'create' | 'notices' | null>(null)
  const setSheet = useCallback((value: typeof sheet) => {
    if (value !== null) navigationRevision.current += 1
    updateSheet(value)
  }, [])
  const menuSource = () => {
    const runtime = client?.runtimeOwnerIdentity?.(), { recordId, host } = getDeviceWorkface().snapshotIdentity()
    return JSON.stringify([runtime?.runtimeId, runtime?.ownerInstanceId, recordId, host?.hostId, host?.origin])
  }
  const [rowMenu, setRowMenu] = useState<{ client: typeof client; target: MobileAgentMenuTarget; source: string } | null>(null)
  const [menuIssue, setMenuIssue] = useState('')
  const openAgentMenu = useCallback((target: MobileAgentMenuTarget) => { setRowMenu({ client, target, source: menuSource() }); setMenuIssue(''); setSheet('agent') }, [client])
  const menuTarget = rowMenu?.client === client ? rowMenu?.target : null
  const validateMenuSource = useCallback(() => {
    if (rowMenu && rowMenu.client === client && rowMenu.source === menuSource() && (!rowMenu.target.beforeAction || rowMenu.target.beforeAction())) return true
    setMenuIssue('原菜单的 Host 或工作面来源已变化；原身份链接仍可复制。请关闭菜单，核对原来源后重新打开。')
    return false
  }, [rowMenu, client])
  useEffect(() => { if (sheet === 'agent' && !menuTarget) setSheet(null) }, [sheet, menuTarget])
  const [createTarget, setCreateTarget] = useState<MobileAgentCreateTarget>({})
  const createAgent = useCallback((target: MobileAgentCreateTarget) => { setCreateTarget(target); setSheet('create') }, [])
  const openProfile = useCallback((identity: MobileObjectIdentity) => {
    navigationRevision.current += 1
    if (identity.mote) setRecentMoteSpaceId(identity.mote.spaceId)
    startupProfile.current = null
    setProfileIdentity(identity); setProfileSourcePath(null); setSheet('identity')
  }, [])
  const selectMote = useCallback((id: string) => { navigationRevision.current += 1; setRecentMoteSpaceId(id) }, [])
  const [profileBack, setProfileBack] = useState<(() => void) | null>(null)
  const [spatialBack, setSpatialBack] = useState<(() => void) | null>(null)
  const [topicsBack, setTopicsBack] = useState<(() => void) | null>(null)
  const [sourceBack, setSourceBack] = useState<(() => void) | null>(null)
  const [surveyBack, setSurveyBack] = useState<(() => void) | null>(null)
  const [goalsBack, setGoalsBack] = useState<(() => void) | null>(null)
  const registerProfileBack = useCallback((back: (() => void) | null) => setProfileBack(() => back), [])
  const registerSpatialBack = useCallback((back: (() => void) | null) => setSpatialBack(() => back), [])
  const registerTopicsBack = useCallback((back: (() => void) | null) => setTopicsBack(() => back), [])
  const registerSourceBack = useCallback((back: (() => void) | null) => setSourceBack(() => back), [])
  const registerSurveyBack = useCallback((back: (() => void) | null) => setSurveyBack(() => back), [])
  const registerGoalsBack = useCallback((back: (() => void) | null) => setGoalsBack(() => back), [])
  const familyBack = secondary === 'topics' ? topicsBack : secondary === 'goals' ? goalsBack : secondary === 'survey' ? surveyBack : spatialBack
  const hasBack = sheet !== null || showSession || secondary === 'topics' && source !== null || familyBack !== null
  const requestBack = useMobileBack(hasBack, () => {
    navigationRevision.current += 1
    if (sheet !== null) {
      if (sheet === 'identity' && profileBack) profileBack()
      else setSheet(null)
    } else if (showSession) {
      if (showGoalWork) setShowGoalWork(false)
      else if (workface.panel === 'terminal') setWorkface(value => ({ ...value, panel: 'conversation' }))
      else closeSession()
    } else if (secondary === 'topics' && source) {
      if (source.kind === 'topic') topicsBack ? topicsBack() : leaveSource()
      else sourceBack ? sourceBack() : leaveSource()
    }
    else familyBack?.()
  })
  const backRef = useRef(requestBack)
  backRef.current = requestBack
  const [notice, setNotice] = useState<string | null>(initial.current.issue)
  const [chatStartIssue, setChatStartIssue] = useState<string | null>(null)
  const [chatStartRevision, retryChatStart] = useState(0)
  const chatStartDone = useRef(initial.current.workface.selectedSessionId !== null)
  const chatStartExpectedRevision = useRef(0)
  useEffect(() => {
    if (chatStartDone.current || !client?.forwardRpc || !connected || !canPersist || navigationRevision.current !== chatStartExpectedRevision.current) return
    let disposed = false
    const revision = navigationRevision.current, owner = client.runtimeOwnerIdentity?.(), recordId = getDeviceWorkface().recordIdentity()
    const isCurrent = () => {
      const currentOwner = client.runtimeOwnerIdentity?.()
      return !disposed && navigationRevision.current === revision && getDeviceWorkface().recordIdentity() === recordId &&
        owner?.runtimeId === currentOwner?.runtimeId && owner?.ownerInstanceId === currentOwner?.ownerInstanceId
    }
    void client.forwardRpc('space.ls', { target: {}, presentation: true }).then(result => {
      if (!isCurrent()) return
      const target = mobileChatStart(result.catalog, recentMoteSpaceId)
      setChatStartIssue(target.issue)
      if (target.identity) setObjectIdentity(target.identity)
      if (!target.sessionId) return
      chatStartDone.current = true
      setHome('mote'); setSecondary(null)
      setWorkface(value => ({ ...value, selectedSessionId: target.sessionId, panel: 'conversation' }))
      setShowSession(true); setShowGoalWork(false)
    }).catch(error => { if (isCurrent()) setChatStartIssue(error instanceof Error ? error.message : String(error)) })
    return () => { disposed = true }
  }, [client, connected, canPersist, recentMoteSpaceId, chatStartRevision])
  const [sessionRevision, setRevision] = useState(0)
  const { selected, projectionError } = useMemo(() => {
    try { return { selected: client && workface.selectedSessionId ? client.agentSession(workface.selectedSessionId) : undefined, projectionError: null } }
    catch { return { selected: undefined, projectionError: '原会话元信息尚未核实。原身份、阅读与草稿仍保留；可核对原 Mac 的连接。' } }
  }, [client, connection.state, workface.selectedSessionId, sessionRevision])
  const reportError = (error: unknown) => setNotice(error instanceof Error ? error.message : String(error))

  useEffect(() => {
    const release = bindMobileViewport(window, document.documentElement)
    return release
  }, [])
  useEffect(() => {
    if (!native) return
    const binding = bindNativeDevice({ root: document.documentElement, reportError,
      onForeground: () => { void client?.connect().catch(reportError) },
      onBack: () => backRef.current()
    })
    return () => { void binding.dispose().catch(reportError) }
  }, [client, native])
  useEffect(() => client?.onEvent(event => {
    if (event.type === 'agent-session' && event.session.agentSessionId === workface.selectedSessionId ||
      event.type === 'run-removed' && (event.agentSessionId === workface.selectedSessionId || event.run.runId === selected?.run.runId) || event.type === 'connection-state') {
      setRevision(value => value + 1)
    }
    // Keep the local reading reference, including after retirement. The original Core determines
    // whether its history remains readable; unknown/old-Run events cannot erase a saved workface.
  }), [client, workface.selectedSessionId, selected?.run.runId])
  const retainTopics = initial.current.presentation?.topics !== undefined || topicsRoute.context.categoryId !== null || topicId !== null
    || topicsRoute.context.mode !== 'discussion' || topicsRoute.sources.length > 0
  const presentation: MobilePresentationRoute = { primary: secondary ?? home, showSession, showGoalWork, ...(retainTopics ? { topics: topicsRoute } : {}),
    ...(recentMoteSpaceId ? { recentMoteSpaceId } : {}),
    ...(initial.current.presentation?.goals || goalsContext.goalId !== null ? { goals: goalsContext } : {}),
    ...(initial.current.presentation?.survey !== undefined || surveyContext.zoneId !== null ? { survey: surveyContext } : {}),
    ...(initial.current.presentation?.spatial !== undefined || spatialContext.spaceId !== null ? { spatial: spatialContext } : {}),
    identity: retainObjectReference(objectIdentity), profile: sheet === 'identity' && profileIdentity
      ? { identity: retainObjectReference(profileIdentity)!, sourcePath: profileSourcePath } : startupProfile.current }
  const presentationBytes = JSON.stringify(presentation)
  const savedPresentation = useRef(JSON.stringify(initial.current.presentation ?? presentation))
  useEffect(() => {
    if (!chatStartDone.current && navigationRevision.current === 0) return
    if (workface === initial.current?.workface && savedPresentation.current === presentationBytes) return
    try {
      void getDeviceWorkface().updatePresentation(workface, JSON.parse(presentationBytes) as MobilePresentationRoute, navigationRecord.current!.recordId).then(() => { savedPresentation.current = presentationBytes }).catch(() => { setNotice('这台设备暂时无法保存导航位置。地址与导航仅临时采用；当前阅读和 Mac 上的原会话仍保留，原存储记录尚未覆盖。') })
    } catch {
      setNotice('这台设备暂时无法保存导航位置。地址与导航仅临时采用；当前阅读和 Mac 上的原会话仍保留，原存储记录尚未覆盖。')
    }
  }, [workface, presentationBytes])

  const restoreNavigationStorage = async () => {
    try {
      const owner = getDeviceWorkface()
      await owner.replaceUnreadableWithCurrent(workface)
      navigationRecord.current = { recordId: owner.recordIdentity() }
      setCanPersist(true)
      setNotice('已用当前工作面替换这台设备无法读取的原记录。导航、草稿和未确认输入一起保存；Mac 上的原会话保持不变。')
    } catch { setNotice('这台设备仍无法保存导航。原记录尚未覆盖；当前仍按临时导航继续阅读。') }
  }


  const workspaceVisible = connected || hasConnected
  const label = connected ? '已连接' : connection.state === 'connecting' ? '连接中' : connection.state === 'disconnected' ? '连接中断' : '尚未连接'
  const primaryHeader = workspaceVisible && !showSession && !source
  const sessionBackLabel = showGoalWork && workface.panel === 'terminal' ? '返回终端' : showGoalWork || workface.panel === 'terminal' ? '返回对话' : `返回 ${pageName}`
  const menuButton = <button className="mobile-settings-button" onClick={() => setSheet(workspaceVisible ? 'settings' : 'connection')} aria-label={workspaceVisible ? '手机设置与连接' : '连接你的 Mac'}><ThemeActionMenuIcon size={18} />{workspaceVisible && <small>菜单</small>}<span className="mobile-status-dot" aria-label={label} /></button>
  const terminalToggle = <button type="button" className="mobile-icon-button mobile-session-view-toggle"
    aria-label={workface.panel === 'terminal' && !showGoalWork ? '查看对话' : '查看终端'}
    title={workface.panel === 'terminal' && !showGoalWork ? '查看对话' : '查看终端'}
    onClick={() => { navigationRevision.current += 1; setShowGoalWork(false); setWorkface(value => ({ ...value, panel: value.panel === 'terminal' && !showGoalWork ? 'conversation' : 'terminal' })) }}>
    {workface.panel === 'terminal' && !showGoalWork ? <ThemeObjectConversationIcon size={18} /> : <ThemeObjectTerminalIcon size={18} />}
  </button>

  const exposed = sheet === null
  const moteConversation = showSession && objectIdentity?.mote && home === 'mote' && secondary === null
  const conversationVisible = workspaceVisible && showSession && !showGoalWork && workface.panel !== 'terminal'
  composeScope.current = { client, sessionId: workface.selectedSessionId, visible: conversationVisible, focusComposer }
  // The visible conversation owns its connection feedback. Storage and projection
  // failures remain separate facts even when the connection is also unavailable.
  const serviceNotices = [...new Set([notice, projectionError, hostAppearance.issue,
    !conversationVisible ? connection.issue ?? (hasConnected && !connected ? connection.message : null) : null
  ].filter((message): message is string => Boolean(message)))]
  return <MobileAgentMenuContext.Provider value={openAgentMenu}><MobileNoticeScope owner={client} identity={[ getDeviceWorkface().recordIdentity()]}><MobileGoalOperationSafety /><div className="mobile-app" data-connection={connection.state} data-drawer={sheet === 'settings' ? 'open' : 'closed'} data-mobile-workface={moteConversation ? 'mote' : 'workspace'} data-page-header={primaryHeader ? 'inline' : 'shell'}>
    {!primaryHeader && <header className={`mobile-header${workspaceVisible && showSession && !moteConversation ? ' mobile-header--session' : ''}`}>
      {workspaceVisible && showSession && !moteConversation ? <div className="mobile-session-toolbar">
        <button type="button" className="mobile-session-origin" data-mobile-back aria-label={sessionBackLabel} onClick={requestBack}><ThemeNavigationBackIcon size={16} /><span>{pageName}</span></button>
        {objectIdentity?.mote ? <button className="mobile-mote-heading mobile-session-identity" aria-label={`${objectIdentity.name} · 查看身份与状态`} onClick={() => openProfile(objectIdentity)}><MobileIdentity identity={objectIdentity} session={selected} client={client} connected={connected} size={28} visible={exposed} /><span className="mobile-session-title">{sessionTitle ?? objectIdentity.name}</span></button>
          : <><MobileIdentity identity={objectIdentity ?? { name: sessionTitle ?? '原会话', project: pageName }} session={selected} client={client} connected={connected} size={24} visible={exposed} /><span className="mobile-session-title">{sessionTitle ?? selected?.providerId ?? '原会话'}</span></>}
        <div ref={setConversationToolsTarget} className="mobile-session-tool-slot" hidden={!conversationVisible} />
        {terminalToggle}
        <button className="mobile-icon-button" aria-label="当前对话操作" onClick={() => setSheet('actions')}><ThemeActionMoreIcon size={18} /></button>
      </div> : <>
        {workspaceVisible && showSession ? <button className="mobile-icon-button" data-mobile-back aria-label={sessionBackLabel} onClick={requestBack}><ThemeNavigationBackIcon size={20} /></button> : <span className="mobile-header-spacer" />}
        {showSession && objectIdentity?.mote ? <button className="mobile-mote-heading" aria-label={`${objectIdentity.name} · 查看身份与状态`} onClick={() => openProfile(objectIdentity)}><MobileIdentity identity={objectIdentity} session={selected} client={client} connected={connected} size={38} visible={exposed} /></button>
          : <div className="mobile-brand"><img className="mobile-brand-icon" src={brandIcon} width={24} height={24} alt="" /><span>AgentMux</span></div>}
        {showSession ? <div className="mobile-session-header-actions"><div ref={setConversationToolsTarget} className="mobile-session-tool-slot" hidden={!conversationVisible} />{terminalToggle}<button className="mobile-icon-button" aria-label="当前对话操作" onClick={() => setSheet('actions')}><ThemeActionMoreIcon size={20} /></button></div> : <span className="mobile-header-spacer" />}
      </>}
    </header>}
    <main className="mobile-main" tabIndex={-1}>
      {!workspaceVisible && <section className="mobile-connect-page"><img className="mobile-connect-dragon" src={brandIcon} alt="AgentMux 龙" /><h1>连接你的 Mac</h1>
        <p>在 Mac 的 Phone &amp; Devices 中复制连接链接，用手机打开。两台设备连接同一 Wi-Fi。</p>
        <MobileNotice owner={client} identity={[connection.state,connection.issue]} className="mobile-spatial-notice">{connection.message}</MobileNotice>{connectionPanel}
        <button className="mobile-secondary" onClick={() => setSheet('connection')}><ThemeObjectConnectionIcon size={16} />连接详情</button>
      </section>}
      {workspaceVisible && <>
        <div hidden={showSession || secondary !== null}><MobileSpatialNavigation onCreateAgent={createAgent} visible={exposed && !showSession && secondary === null} home={home} client={client} connected={connected} openSession={openSession} openMainAgent={openMainAgent} openProfile={openProfile} onBackChange={registerSpatialBack}
          recentMoteSpaceId={recentMoteSpaceId} onSelectMote={selectMote}
          initialContext={spatialContext} onContextChange={updateSpatialContext} openHttpLink={openBrowserHttpLink} /></div>
        <div hidden={showSession || secondary !== 'topics' || Boolean(source && source.kind !== 'topic')}><MobileTopicsSurface rpc={rpc} visible={exposed && !showSession && secondary === 'topics' && (!source || source.kind === 'topic')} topicId={topicId}
          client={client} connected={connected} {...(topicsRoute.knowledge ? { initialKnowledge: topicsRoute.knowledge } : {})} onKnowledgeChange={updateKnowledgeReference}
          initialContext={topicsRoute.context} onContextChange={updateTopicsContext}
          {...(source?.kind === 'topic' ? { onLeaveTopic: leaveSource, topicBackLabel: '返回知识' } : {})}
          onOpenTopic={topic => updateTopicsContext({ ...topicsRoute.context, topicId: topic.topicId, mode: 'discussion' })} openSource={openSource} openHttpLink={openBrowserHttpLink} onBackChange={registerTopicsBack}
          renderWorkface={(topic, visible) => <MobileZoneWorkface key={topic.topicId} client={client} zoneId={topic.zoneId} name={topic.title} visible={visible} onCreateAgent={createAgent}
            {...(source?.kind === 'topic' && source.topicId === topic.topicId ? { tabId: source.chatId, regionId: source.threadId } : {})} openSession={openSession} />} /></div>
        <div hidden={showSession || secondary !== 'survey'}><MobileSurveySurface client={client} connected={connected} visible={exposed && !showSession && secondary === 'survey'} openSession={openSession}
          openTopic={openSurveyTopic} initialContext={surveyContext} onContextChange={updateSurveyContext} onBackChange={registerSurveyBack} openHttpLink={openBrowserHttpLink} /></div>
        {source && source.kind !== 'topic' && <div hidden={showSession || secondary !== 'topics'}>
          {source.kind === 'space' || source.kind === 'survey' ? <>
            <button className="mobile-text-button" onClick={leaveSource}><ThemeNavigationBackIcon size={16} />返回知识</button>
            <MobileZoneWorkface key={source.zoneId} client={client} zoneId={source.zoneId} name="来源工作面" visible={exposed && !showSession && secondary === 'topics'} tabId={source.tabId} regionId={source.regionId} openSession={openSession} />
          </> : source.kind === 'file' || source.kind === 'note' || source.kind === 'notebook' ? <MobileTopicSource source={source} rpc={rpc} onBack={leaveSource} openHttpLink={openBrowserHttpLink}
            visible={exposed && !showSession && secondary === 'topics'} onBackChange={registerSourceBack}
            {...(sourceReference ? { initialReference: sourceReference } : {})} onReferenceChange={updateSourceReference}
            openScope={scope => { openSource({ kind: 'space', zoneId: scope.zoneId }) }} /> : null}
        </div>}
        <div hidden={showSession || secondary !== 'goals'}><MobileGoalsSurface client={client} connected={connected} visible={exposed && !showSession && secondary === 'goals'} openSession={openSession} onBackChange={registerGoalsBack}
          context={goalsContext} onContextChange={updateGoalsContext} copyText={platform.copyText} /></div>
      </>}
      <section className="mobile-goal-panel" hidden={!workspaceVisible || !showSession || !showGoalWork}>
        <MobileGoalWork client={client} agentSessionId={workface.selectedSessionId} connected={connected} visible={exposed && workspaceVisible && showSession && showGoalWork} />
      </section>
      <section className="mobile-conversation-panel" hidden={!workspaceVisible || !showSession || showGoalWork || workface.panel === 'terminal'}>
        {!workface.selectedSessionId && <div className="mobile-chat-start">
          <ThemeObjectConversationIcon size={24} /><h1>继续对话</h1>
          <p>{chatStartIssue ?? '正在找回原对话…'}</p>
          <div><button type="button" className="mobile-text-button" onClick={() => openPrimaryWorkface('mote')}>选择 Mote</button>
            <button type="button" className="mobile-text-button" onClick={() => openPrimaryWorkface('focus')}>已有对话</button>
            {objectIdentity?.mote && <button type="button" className="mobile-text-button" onClick={() => openProfile(objectIdentity)}>查看 Profile</button>}
            {chatStartIssue && <button type="button" className="mobile-text-button" onClick={() => { chatStartExpectedRevision.current = navigationRevision.current; retryChatStart(value => value + 1) }}>重新核对</button>}</div>
        </div>}
        <div className={`mobile-conversation-slot${workface.selectedSessionId ? ' is-active' : ''}`}>
          <MobileConversationSurface client={client} agentSessionId={workface.selectedSessionId} connection={connection} platform={platform} toolbarTarget={conversationToolsTarget} {...(sessionTitle ? { displayName: sessionTitle } : {})} visible={exposed && conversationVisible} onShowTerminal={() => setWorkface(value => ({ ...value, panel: 'terminal' }))}
            onShowGoals={trigger => { goalReturn.current = { trigger, sessionId: workface.selectedSessionId }; setShowGoalWork(true) }} openHttpLink={openBrowserHttpLink} />
        </div>
      </section><section className="mobile-terminal-panel" hidden={!workspaceVisible || !showSession || showGoalWork || workface.panel !== 'terminal'}>
        <MobileTerminalViewer terminalPalette={hostAppearance.terminalPalette} client={client} agentSessionId={workface.selectedSessionId} connection={connection} platform={platform} {...(sessionTitle ? { displayName: sessionTitle } : {})} inputActive={exposed} visible={workspaceVisible && showSession && !showGoalWork && workface.panel === 'terminal'} />
      </section>
    </main>
    <div className="mobile-notice-stack">
      {webObservation && <MobileNotice owner={client} hidden={mobileWebUpdateStatus(webObservation) !== 'available'}
        identity={[webObservation.inspection.result?.hostInstanceId, webObservation.inspection.result?.active?.digest]} className="mobile-web-update-notice" kind="feedback">
        <span>网页有新版本</span><button type="button" onClick={() => setSheet('settings')}>前往更新</button>
      </MobileNotice>}
      {(serviceNotices.length > 0 || !canPersist) && <MobileNotice owner={client} kind="feedback" identity={[notice,projectionError,hostAppearance.issue,connection.issue,connection.state,canPersist]} className="mobile-service-notice"><span className="mobile-notice-mark"><ThemeStatusInfoIcon size={15} /></span><div>{serviceNotices.map(message => <p key={message}>{message}</p>)}{!canPersist && <button onClick={restoreNavigationStorage}>用当前工作面替换原记录</button>}</div></MobileNotice>}
    </div>
    <footer className="mobile-navigation-bar">{menuButton}{workspaceVisible && <MobilePrimaryNavigation current={secondary === 'survey' ? null : secondary ?? home} onSelect={openPrimaryWorkface} />}</footer>
    <MobileAgentCreate client={client} connected={connected} visible={sheet === 'create'} target={createTarget} platform={platform} onClose={() => setSheet(null)} openSession={id => openSession(id, { name: '原 Agent', project: '项目未确认' })} />
    <Dialog.Root open={sheet !== null && sheet !== 'create'} onOpenChange={open => { if (!open) setSheet(null) }}>
      <Dialog.Portal container={platform.overlayContainer()}><Dialog.Overlay className={sheet === 'settings' ? 'mobile-drawer-backdrop' : 'mobile-sheet-backdrop'} /><Dialog.Content className={sheet === 'settings' ? 'mobile-drawer' : `mobile-sheet${sheet === 'agent' || sheet === 'actions' ? ' mobile-sheet--agent' : ''}`} aria-describedby="mobile-sheet-description" onCloseAutoFocus={event => {
        const original = composeAfterClose.current
        if (!original) return
        composeAfterClose.current = null
        event.preventDefault()
        const current = composeScope.current
        if (current.client !== original.client || current.sessionId !== original.sessionId || !current.visible) {
          setNotice('已切换工作面，原聚焦操作未执行；草稿保留。')
          return
        }
        if (!current.focusComposer()) setNotice('输入区暂时未准备好。原草稿保留。')
      }}>
        <div className="mobile-sheet-handle" /><div className="mobile-sheet-title"><Dialog.Title>{sheet === 'agent' ? menuTarget?.identity.name ?? 'Agent' : sheet === 'notices' ? '提醒与诊断' : sheet === 'identity' ? profileIdentity?.name ?? 'Mote' : sheet === 'actions' ? '当前对话' : sheet === 'settings' ? 'AgentMux' : '连接你的 Mac'}</Dialog.Title><Dialog.Close className="mobile-icon-button" aria-label="关闭面板"><ThemeActionCloseIcon size={19} /></Dialog.Close></div>
        {sheet === 'settings' ? <>
          <Dialog.Description id="mobile-sheet-description">工作面与手机设置</Dialog.Description>

          <nav className="mobile-drawer-workfaces" aria-label="其他工作面">
            <button className="mobile-menu-row" aria-current={secondary === 'survey' ? 'page' : undefined} onClick={() => { navigationRevision.current += 1; setSecondary('survey'); setShowSession(false); setSheet(null) }}><ThemeNavigationSurveyIcon size={20} /><span>Survey<small>研究与笔记</small></span></button>
          </nav>
          <div className="mobile-drawer-settings">
          <label className="mobile-home-select">默认目录<select aria-label="退出对话后的默认目录" value={defaultHome} onChange={event => {
            const value = event.target.value as MobilePrimaryWorkface
            try { saveMobileHome(value); setDefaultHome(value); setHomeIssue(null) }
            catch { setHomeIssue('默认主页未保存；原设置和草稿保留。') }
          }}><option value="goals">Goals</option><option value="topics">Topics</option><option value="mote">Mote</option><option value="focus">Focus</option><option value="space">Space</option></select></label>
          {homeIssue && <MobileNotice identity={[homeIssue]} className="mobile-spatial-notice">{homeIssue}</MobileNotice>}
          {webObservation && <MobileWebUpdateSettings observation={webObservation} />}
          <button className="mobile-menu-row" aria-label="提醒与诊断" onClick={() => setSheet('notices')}><ThemeStatusInfoIcon size={18} /><span>提醒与诊断<small>{notices?.hasDismissed ? '有已收起的提醒' : '收起或恢复原提醒'}</small></span><ThemeNavigationSubmenuIcon size={16} /></button>
          <button className="mobile-menu-row" onClick={() => setSheet('connection')}><ThemeObjectNetworkIcon size={18} /><span>连接与设备<small>{label} · {location.host}</small></span><ThemeNavigationSubmenuIcon size={16} /></button></div>
        </> : sheet === 'notices' ? <>
          <Dialog.Description id="mobile-sheet-description">本设备的提醒呈现</Dialog.Description>
          {webObservation && <MobileWebDiagnostics observation={webObservation} copyText={platform.copyText} />}
          <MobileGoalOperationRecovery copyText={platform.copyText} />
          <MobileNoticeRestore onRestored={() => setSheet(null)} />
        </> : sheet === 'identity' && profileIdentity ? <>
          <Dialog.Description id="mobile-sheet-description">原资料与当前工作</Dialog.Description>
          <MobileMoteProfile identity={profileIdentity} client={client} copyText={platform.copyText} visible={sheet === 'identity'} sourcePath={profileSourcePath} onSourceChange={setProfileSourcePath} onBackChange={registerProfileBack} onOpenGoals={id => {
            openSession(id, profileIdentity); setShowGoalWork(true); setSheet(null)
          }} />
        </> : sheet === 'agent' && menuTarget ? <>
          <Dialog.Description id="mobile-sheet-description">{menuTarget.identity.project}</Dialog.Description>
          {menuIssue && <MobileNotice owner={client} identity={[menuTarget.agentSessionId, menuIssue]} role="status">{menuIssue}</MobileNotice>}
          <MobileAgentActions key={menuTarget.agentSessionId} client={client} agentSessionId={menuTarget.agentSessionId} connected={connected} copyText={platform.copyText} beforeAction={validateMenuSource} />
          <button className="mobile-menu-row" onClick={() => { if (validateMenuSource()) { openSession(menuTarget.agentSessionId, menuTarget.identity); setSheet(null) } }}><ThemeObjectConversationIcon size={18} /><span>打开原对话</span></button>
        </> : sheet === 'actions' ? <>
          <Dialog.Description id="mobile-sheet-description">{sessionTitle ?? '原 Agent'} · {objectIdentity?.project ?? '项目未确认'}</Dialog.Description>
          {native && selected && !showGoalWork && workface.panel !== 'terminal' && <button className="mobile-menu-row" aria-label="撰写消息" onClick={() => { composeAfterClose.current = { client, sessionId: selected.agentSessionId }; setSheet(null) }}><ThemeActionComposeIcon size={17} /><span>撰写消息</span></button>}
          {workface.selectedSessionId && <MobileAgentActions client={client} agentSessionId={workface.selectedSessionId} connected={connected} copyText={platform.copyText} />}
        </> : <>
          <Dialog.Description id="mobile-sheet-description">连接同一私网里的 Mac。Agent 与会话由 Mac 管理。</Dialog.Description>
          <p>Mac：{location.origin} · {label}</p>
          <p className="mobile-sheet-note">Mac 保持在线即可继续使用原会话。</p>
          {connectionPanel}
          <MobileRecoveryPanel {...(native ? { exportFile: exportNativeWorkfaceFile } : {})} />
          <button className="mobile-menu-row" aria-label="提醒与诊断" onClick={() => setSheet('notices')}><ThemeStatusInfoIcon size={18} /><span>提醒与诊断</span><ThemeNavigationSubmenuIcon size={16} /></button>
          <p className="mobile-sheet-note">连接会自动恢复。{connection.message}</p>
        </>}
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </div></MobileNoticeScope></MobileAgentMenuContext.Provider>
}
