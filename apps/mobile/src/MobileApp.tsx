import { IconButton } from '@agentmux/client-ui/components/IconButton'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { TopicKnowledgeSource } from '@agentmux/core/control'

import type { MobileTopicsContext } from './topics/MobileTopicsSurface'
import type { MobileSurveyContext } from './survey/MobileSurveySurface'

import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import { MobileAgentCreate, type MobileAgentCreateTarget } from './navigation/MobileAgentCreate'
import { MobileAgentActions } from './conversation/MobileAgentActions'
import { recoverMobileAgent } from './conversation/mobile-agent-recovery'
import { MobileAgentMenuContext, type MobileAgentMenuTarget } from './navigation/MobileAgentRow'
import { MobileConversationSurface, type MobileConnection } from './conversation/MobileConversationSurface'
import { mobileMoteInputSource } from './conversation/mote-input-source'
import { ClientUiProvider } from '@agentmux/client-ui'
import { MotePeriodConversation } from '@agentmux/client-ui/components/MoteConversationThreads'
import { MobileMoteConversationStart, MobileMoteStartRecovery } from './navigation/MobileMoteConversationStart'
import type { MobileMoteRolloverQuery } from './conversation/mote-main-input'
import type { MoteDialogueLink } from '@agentmux/core/mote-dialogue'
import { MobileMoteThreads } from './navigation/MobileMoteThreads'
import { MobileMoteTeamPanel, MobileMoteTeamSummary, mobileMoteRecipient } from './navigation/MobileMoteTeam'
import { useMobileMoteTeam } from './navigation/use-mobile-mote-team'
import { mobileMoteMainIdentity, mobileMoteMemberName, type MobileMoteMember } from './navigation/mobile-mote-team'
import { mobileMoteMemberIdentity } from './navigation/mobile-mote-team'
import type { MobileMoteWork } from './conversation/MobileMoteConversation'
import { isPrimaryMoteSpace, type MoteDefaultConversation } from '@agentmux/core/mote-preferences'
import { useMoteDialogue, type MoteDialogueReader } from '@agentmux/client-ui/use-mote-dialogue'

import { useHostAppearance } from './appearance/useHostAppearance'
import { bindMobileViewport, bindNativeDevice } from './platform/native/device'
import { openBrowserHttpLink } from './platform/browser'
import './mobile.css'
import { getDeviceWorkface, type Navigation } from './recovery/device-workface'
import { MobileRecoveryPanel } from './recovery/MobileRecoveryPanel'
import { exportNativeWorkfaceFile } from './platform/native/workface-file'

import { BrandIcon } from '@agentmux/client-ui/components/BrandIcon'
import { MobileIdentity, type MobileObjectIdentity } from './navigation/MobileIdentity'
import { MobilePrimaryNavigation } from './navigation/MobilePrimaryNavigation'
import type { MobileSpatialContext } from './navigation/MobileSpatialNavigation'
import { readMobileHome, saveMobileHome, type MobileHome, type MobilePrimaryWorkface } from './navigation/home-preference'

import { mobileChatStart } from './navigation/chat-start'
import { useMobileBack } from './navigation/useMobileBack'
import { retainObjectReference, type MobilePresentationRoute, type MobileTopicsRoute, type MobileGoalsContext, type MobileKnowledgeReference } from './recovery/presentation-route'
import type { MobileTopicSourceContentReference } from './topics/source-reference'
import { MobileAvatarNoticeOutlet, MobileNotice, MobileNoticeProvider, MobileNoticeRestore, MobileNoticeScope, useMobileNotices } from './notices/MobileNotice'
import { MobileGoalOperationRecovery, MobileGoalOperationSafety } from './goals/goal-operation-recovery'
import { MobileWebDiagnostics } from './mobile-web/MobileWebDiagnostics'
import { MobileWebUpdateSettings } from './mobile-web/MobileWebUpdate'
import { mobileWebUpdateStatus } from './mobile-web/use-mobile-web-observation'
import type { MobileWebPageObservation } from './mobile-web/use-mobile-web-observation'

import { deferMobileSurface } from './navigation/defer-mobile-surface'

const MobileTerminalViewer = deferMobileSurface('终端', async () => ({ default: (await import('./terminal/MobileTerminalViewer')).MobileTerminalViewer }))
const MobileSpatialNavigation = deferMobileSurface('目录', async () => ({ default: (await import('./navigation/MobileSpatialNavigation')).MobileSpatialNavigation }))
const MobileTopicsSurface = deferMobileSurface('Topics', async () => ({ default: (await import('./topics/MobileTopicsSurface')).MobileTopicsSurface }))
const MobileSurveySurface = deferMobileSurface('Survey', async () => ({ default: (await import('./survey/MobileSurveySurface')).MobileSurveySurface }))
const MobileGoalsSurface = deferMobileSurface('Goals', async () => ({ default: (await import('./goals/MobileGoalsSurface')).MobileGoalsSurface }))
const MobileGoalWork = deferMobileSurface('当前目标', async () => ({ default: (await import('./navigation/MobileGoalWork')).MobileGoalWork }))
const MobileMoteProfile = deferMobileSurface('Profile', async () => ({ default: (await import('./navigation/MobileMoteProfile')).MobileMoteProfile }))
const MobileTopicSource = deferMobileSurface('知识来源', async () => ({ default: (await import('./topics/MobileTopicSource')).MobileTopicSource }))
const MobileZoneWorkface = deferMobileSurface('来源工作面', async () => ({ default: (await import('./navigation/MobileZoneWorkface')).MobileZoneWorkface }))

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
  /** First presentation only, after the connection owner verifies the original reload handoff. */
  restoreWorkface?: boolean
}
export function MobileApp(props: MobileAppProps) {
  return <MobileNoticeProvider><MobileAppContent {...props} /></MobileNoticeProvider>
}
function MobileAppContent({ client, connection, platform, native = false, focusComposer = () => false, connectionPanel, webObservation, restoreWorkface = false }: MobileAppProps) {
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
  const [workface, setWorkface] = useState<Workface>(() => restoreWorkface ? initial.current!.workface : { ...initial.current!.workface, panel: 'conversation' })
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
  const [showSession, setShowSession] = useState(restoreWorkface ? initial.current.presentation?.showSession ?? true : true)
  const [showGoalWork, setShowGoalWork] = useState(restoreWorkface && (initial.current.presentation?.showGoalWork ?? false))
  const [conversationToolsTarget, setConversationToolsTarget] = useState<HTMLDivElement | null>(null)
  const [recentMoteSpaceId, setRecentMoteSpaceId] = useState(initial.current.presentation?.recentMoteSpaceId ?? initial.current.presentation?.identity?.mote?.spaceId ?? null)
  const startupProfile = useRef(restoreWorkface ? null : initial.current.presentation?.profile ?? null)
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
  const [identityRecipient, setIdentityRecipient] = useState<string | null>(initial.current.workface.selectedSessionId)
  const [profileIdentity, setProfileIdentity] = useState<MobileObjectIdentity | null>(initial.current.presentation?.profile?.identity ?? null)
  const [profileSourcePath, setProfileSourcePath] = useState<string | null>(initial.current.presentation?.profile?.sourcePath ?? null)
  const [moteEntryIssue, setMoteEntryIssue] = useState<{ client: typeof client; spaceId: string; message: string } | null>(null)
  const navigationRevision = useRef(0)
  const originalConnection = useRef({ client, connected }); originalConnection.current = { client, connected }
  // A direct Agent navigation stays direct until the user returns to the main conversation.
  const [moteDirectAgent, setMoteDirectAgent] = useState(initial.current.presentation?.moteView?.directAgent ?? false)
  const [moteView, setMoteView] = useState<Pick<NonNullable<MobilePresentationRoute['moteView']>, 'spaceId' | 'section' | 'detail'> | null>(initial.current.presentation?.moteView ?? null)
  const [moteStart, setMoteStart] = useState<{ spaceId: string; mode: 'new'; automatic?: MobileMoteRolloverQuery } | null>(null)
  const [moteHistory, setMoteHistory] = useState<Extract<MoteDialogueLink, { kind: 'main' }> | null>(null)
  const openSession = useCallback((id: string, identity: MobileObjectIdentity) => {
    navigationRevision.current += 1
    setMoteStart(null); setMoteHistory(null)
    if (identity.mote) { setRecentMoteSpaceId(identity.mote.spaceId); setMoteView({ spaceId: identity.mote.spaceId, section: 'threads', detail: true }) }
    setObjectIdentity(identity); setIdentityRecipient(id); setShowGoalWork(false); setMoteDirectAgent(true)
    setWorkface(value => ({ ...value, selectedSessionId: id, panel: 'conversation' }))
    setShowSession(true)
  }, [])
  const openMainAgent = useCallback((id: string, identity: MobileObjectIdentity, hostId: string) => {
    openSession(id, identity)
    setMoteDirectAgent(false)
    if (identity.mote) setMoteView({ spaceId: identity.mote.spaceId, section: 'discussion', detail: false })
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
    if (value === 'mote') { void enterMote(recentMoteSpaceId); return }
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
  const [sheet, updateSheet] = useState<'connection' | 'settings' | 'identity' | 'actions' | 'agent' | 'create' | 'notices' | 'team' | null>(restoreWorkface && initial.current.presentation?.profile ? 'identity' : null)
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
  // An explicit Mote entry resolves its saved Main; directory refreshes never navigate.
  const enterMote = useCallback(async (spaceId: string | null) => {
    const revision = ++navigationRevision.current, source = client
    const runtime = source?.runtimeOwnerIdentity?.(), recordId = getDeviceWorkface().recordIdentity()
    setHome('mote'); setSecondary(null); setShowSession(false); setShowGoalWork(false)
    if (spaceId) setRecentMoteSpaceId(spaceId)
    const isCurrent = () => {
      const current = source?.runtimeOwnerIdentity?.()
      return navigationRevision.current === revision && originalConnection.current.client === source && originalConnection.current.connected &&
        current?.runtimeId === runtime?.runtimeId && current?.ownerInstanceId === runtime?.ownerInstanceId && getDeviceWorkface().recordIdentity() === recordId
    }
    if (!source?.forwardRpc || !connected) { setNotice('原 Mote 主对话暂未核对；原引用与草稿保留，可从 Mote 目录继续原对话或查看配置。'); return }
    try {
      const { catalog } = await source.forwardRpc('space.ls', { target: spaceId ? { spaceId } : {}, presentation: true })
      if (!isCurrent()) return
      const owners = catalog.spaces.filter(owner => owner.kind === 'mote' && (spaceId ? owner.spaceId === spaceId : isPrimaryMoteSpace(owner)))
      if (owners.length !== 1) { setNotice('原 Mote 身份尚未唯一确认；原对话与草稿保留，请在 Mote 目录选择原对象。'); return }
      const owner = owners[0]!
      // This entry is for one exact object; an unbound Mote cannot borrow another Main.
      const target = mobileChatStart({ ...catalog, spaces: [owner] }, owner.spaceId)
      const facts = target.identity?.mote?.facts
      const main = facts?.quickMode.status === 'saved' ? facts.quickMode.defaults.conversation : undefined
      setMoteEntryIssue(target.issue ? { client: source, spaceId: owner.spaceId, message: target.issue } : null)
      if (target.sessionId && target.identity && main) openMainAgent(target.sessionId, target.identity, main.hostId)
      else if (target.identity) {
        if ((!facts || facts.quickMode.status === 'unconfirmed') && objectIdentity?.mote?.spaceId === owner.spaceId && identityRecipient === workface.selectedSessionId && workface.selectedSessionId) {
          setShowSession(true); setSheet(null); return
        }
        setMoteStart(null); setMoteHistory(null); setObjectIdentity(target.identity); setIdentityRecipient(null); setMoteDirectAgent(false)
        setMoteView({ spaceId: owner.spaceId, section: 'discussion', detail: false }); setSheet(null)
        setWorkface(value => ({ ...value, selectedSessionId: null, panel: 'conversation' })); setShowSession(true)
      }
    } catch (error) { if (isCurrent()) setNotice(`原 Mote 主对话未能核对：${error instanceof Error ? error.message : String(error)}。原引用与草稿保留，可从原目录重试。`) }
  }, [client, connected, openMainAgent, openProfile, objectIdentity, identityRecipient, workface.selectedSessionId])
  const selectMote = useCallback((id: string) => { void enterMote(id) }, [enterMote])
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
  const returnToConversation = useCallback(() => {
    navigationRevision.current += 1
    setShowSession(true); setShowGoalWork(false); setSheet(null)
    setWorkface(value => ({ ...value, panel: 'conversation' }))
  }, [])
  const backRef = useRef(requestBack)
  backRef.current = requestBack
  const [notice, setNotice] = useState<string | null>(initial.current.issue)
  const [chatStartIssue, setChatStartIssue] = useState<string | null>(restoreWorkface && !initial.current.workface.selectedSessionId ? '原工作面已接回，可选择 Mote 或已有对话。' : null)
  const [chatStartRevision, retryChatStart] = useState(0)
  const chatStartDone = useRef(restoreWorkface || initial.current.workface.selectedSessionId !== null)
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
      if (target.identity) { setObjectIdentity(target.identity); setIdentityRecipient(target.sessionId) }
      if (!target.sessionId) {
        if (target.identity?.mote) {
          chatStartDone.current = true; setHome('mote'); setSecondary(null); setMoteDirectAgent(false)
          setMoteView({ spaceId: target.identity.mote.spaceId, section: 'discussion', detail: false }); setShowSession(true); setShowGoalWork(false)
        }
        return
      }
      chatStartDone.current = true
      setHome('mote'); setSecondary(null); setMoteDirectAgent(false)
      if (target.identity?.mote) setMoteView({ spaceId: target.identity.mote.spaceId, section: 'discussion', detail: false })
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
    ...(moteView ? { moteView: { ...moteView, directAgent: moteDirectAgent } } : {}),
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
  const terminalToggle = <IconButton className="mobile-icon-button mobile-session-view-toggle"
    aria-label={workface.panel === 'terminal' && !showGoalWork ? '查看对话' : '查看终端'}
    title={workface.panel === 'terminal' && !showGoalWork ? '查看对话' : '查看终端'}
    onClick={() => { navigationRevision.current += 1; setShowGoalWork(false); setWorkface(value => ({ ...value, panel: value.panel === 'terminal' && !showGoalWork ? 'conversation' : 'terminal' })) }}>
    {workface.panel === 'terminal' && !showGoalWork ? <ThemeObjectConversationIcon size={18} /> : <ThemeObjectTerminalIcon size={18} />}
  </IconButton>

  const exposed = sheet === null
  const moteConversation = showSession && objectIdentity?.mote && home === 'mote' && secondary === null
  const moteSection = moteView && moteView.spaceId === objectIdentity?.mote?.spaceId ? moteView.section : moteDirectAgent ? 'threads' : 'discussion'
  const threadDetail = moteSection === 'threads' && moteView && moteView.spaceId === objectIdentity?.mote?.spaceId && moteView.detail
  const threadsVisible = Boolean(moteConversation && moteSection === 'threads' && !threadDetail)
  const conversationVisible = workspaceVisible && showSession && !showGoalWork && workface.panel !== 'terminal' && !threadsVisible
  const moteTitle = objectIdentity?.mote?.name ?? 'Mote 名称未确认'
  const teamSpaceId = identityRecipient === workface.selectedSessionId ? objectIdentity?.mote?.spaceId ?? null : null
  const moteContent = identityRecipient === workface.selectedSessionId ? objectIdentity?.mote?.contentReference ?? objectIdentity?.mote?.facts?.content : undefined
  const moteTarget = useMemo(() => teamSpaceId && moteContent ? { spaceId: teamSpaceId, zoneId: moteContent.zoneId,
    expectedResource: { hostId: moteContent.hostId, workspaceId: moteContent.workspaceId, workspacePath: moteContent.workspacePath } } : undefined,
  [teamSpaceId, moteContent?.zoneId, moteContent?.hostId, moteContent?.workspaceId, moteContent?.workspacePath])
  const welcomeVisible = Boolean(moteConversation && !moteDirectAgent && (workface.selectedSessionId === null || moteStart?.spaceId === teamSpaceId))
  const historyVisible = Boolean(moteConversation && moteHistory)
  const teamReading = useMobileMoteTeam(client, teamSpaceId, connected,
    workspaceVisible && showSession && (sheet === null || sheet === 'team'))
  const readMoteDialogue = useCallback<MoteDialogueReader>(async input => {
    if (!client?.forwardRpc) throw new Error('原 Mote 对话读取端口暂不可用；原对话与草稿保留。')
    return client.forwardRpc('space.mote.dialogue.read', input)
  }, [client])
  const moteDialogue = useMoteDialogue(client ? readMoteDialogue : undefined, moteTarget,
    connected && (exposed && (conversationVisible || threadsVisible) || sheet === 'team'), teamReading.team?.facts?.quickMode.status === 'saved' ? teamReading.team.facts.quickMode.version : undefined)
  const team = useMemo(() => {
    const original = teamReading.team
    if (!original || !moteTarget) return original
    const main = moteDialogue.page?.main
    return { ...original, main: main ? main.current ? { reference: main.current, confirmed: main.status === 'ready' && !moteDialogue.unavailable } : undefined
      : original.main ? { ...original.main, confirmed: false } : undefined }
  }, [teamReading.team, moteTarget, moteDialogue.page?.main, moteDialogue.unavailable])
  const beginMoteRound = () => {
    if (!teamSpaceId) return
    navigationRevision.current++; setMoteHistory(null); setMoteStart({ spaceId: teamSpaceId, mode: 'new' }); setMoteDirectAgent(false)
    setMoteView({ spaceId: teamSpaceId, section: 'discussion', detail: false }); setWorkface(value => ({ ...value, panel: 'conversation' })); setSheet(null)
  }
  const refreshMoteConfiguration = async () => {
    const original = client, target = moteTarget, revision = navigationRevision.current, recordId = getDeviceWorkface().recordIdentity(), runtime = client?.runtimeOwnerIdentity?.()
    if (!original?.forwardRpc || !target) return
    const currentSource = () => {
      const current = original.runtimeOwnerIdentity?.()
      return navigationRevision.current === revision && originalConnection.current.client === original && originalConnection.current.connected &&
        getDeviceWorkface().recordIdentity() === recordId && runtime?.runtimeId === current?.runtimeId && runtime?.ownerInstanceId === current?.ownerInstanceId
    }
    try {
      const value = await original.forwardRpc('space.ls', { target: { spaceId: target.spaceId }, presentation: true })
      if (!currentSource()) return
      const facts = value.catalog.motePresentation?.filter(fact => fact.spaceId === target.spaceId) ?? [], fact = facts.length === 1 ? facts[0] : undefined
      const resource = fact?.content
      const qualified = resource && resource.zoneId === target.zoneId && resource.hostId === target.expectedResource.hostId && resource.workspaceId === target.expectedResource.workspaceId && resource.workspacePath === target.expectedResource.workspacePath
      setMoteEntryIssue(qualified && fact?.quickMode.status !== 'unconfirmed' ? null : { client: original, spaceId: target.spaceId, message: fact?.quickMode.status === 'unconfirmed' ? fact.quickMode.message : '原 Mote 配置来源尚未确认；原引用和草稿保留。' })
      teamReading.refresh()
    } catch (error) {
      if (currentSource()) setMoteEntryIssue({ client: original, spaceId: target.spaceId, message: error instanceof Error ? error.message : String(error) })
    }
  }
  const moteMemberName = useCallback<NonNullable<ClientUiPlatform['moteMemberName']>>((owner, memberSessionId) =>
    originalConnection.current.client === client && owner.recipientAgentSessionId === workface.selectedSessionId
      ? mobileMoteMemberName(team, client, owner, memberSessionId) : undefined, [client, team, workface.selectedSessionId])
  const openTeamMember = (id: string, identity: MobileObjectIdentity, member: MobileMoteMember, work = false) => {
    let current
    try { current = client?.agentSession(id) } catch { /* A missing projection cannot erase an original member reference. */ }
    if (!member.hostId || !current || current.agentSessionId !== id || current.hostId !== member.hostId) {
      setNotice(!member.hostId
        ? '这个成员的执行端尚未确认；本次未打开，已有讨论和工作面引用保留。可刷新团队或从原工作面继续。'
        : '当前连接尚未匹配这个成员；本次未打开，已有引用和当前讨论保留。请刷新团队或接回对应的工作环境。'); return
    }
    openSession(id, identity); setShowGoalWork(work); setSheet(null)
  }
  const returnToMoteMain = (original?: MoteDefaultConversation) => {
    const main = original ?? (moteDialogue.page?.main.status === 'ready' && !moteDialogue.unavailable ? moteDialogue.page.main.current : team?.main?.reference)
    const identity = team && main ? mobileMoteMainIdentity(original ? { ...team, main: { reference: original, confirmed: true } } : team)
      : original && objectIdentity?.mote && identityRecipient === workface.selectedSessionId
        ? { name: '原主对话', project: objectIdentity.project, mote: objectIdentity.mote } : undefined
    if (!identity || !main) { setNotice('原主对话引用尚未确认；原成员和草稿保留，可在团队中刷新或核对主 Agent。'); return }
    let current
    try { current = client?.agentSession(main.sessionId) } catch { /* Keep the saved original target, rather than selecting another Agent. */ }
    if (!current || current.agentSessionId !== main.sessionId || current.hostId !== main.hostId) { setNotice('当前连接尚未匹配原主对话；已有引用和当前讨论保留，请刷新或接回对应的工作环境。'); return }
    openSession(main.sessionId, identity); setMoteDirectAgent(false); setMoteView({ spaceId: identity.mote!.spaceId, section: 'discussion', detail: false }); setSheet(null)
  }
  const workMember = (source: MobileMoteWork) => team?.members.find(member => member.hostId === source.origin.hostId && member.sessionId === source.origin.recipientSessionId)
  const openMoteWork = (source: MobileMoteWork) => {
    const member = workMember(source)
    if (!team || !member || member.places.length !== 1) { setNotice('原工作的成员或展示位置尚未唯一确认；原对话与引用保留，请从团队核对原位置。'); return }
    openTeamMember(member.sessionId, mobileMoteMemberIdentity(team, member, member.places[0]), member)
  }
  composeScope.current = { client, sessionId: workface.selectedSessionId, visible: conversationVisible && !welcomeVisible && !historyVisible, focusComposer }
  // The visible conversation owns its connection feedback. Storage and projection
  // failures remain separate facts even when the connection is also unavailable.
  const visibleProjectionError = workspaceVisible && showSession && !welcomeVisible && !historyVisible ? projectionError : null
  const serviceNotices = [...new Set([notice, visibleProjectionError, hostAppearance.issue,
    !conversationVisible ? connection.issue ?? (hasConnected && !connected ? connection.message : null) : null
  ].filter((message): message is string => Boolean(message)))]
  return <MobileAgentMenuContext.Provider value={openAgentMenu}><MobileNoticeScope owner={client} identity={[ getDeviceWorkface().recordIdentity()]}><MobileGoalOperationSafety /><div className="mobile-app" data-connection={connection.state} data-mobile-workface={moteConversation ? 'mote' : 'workspace'} data-page-header={primaryHeader ? 'inline' : 'shell'}>
    {!primaryHeader && <header className={`mobile-header${workspaceVisible && showSession ? ' mobile-header--session' : ''}`}>
      {workspaceVisible && showSession ? <div className="mobile-session-toolbar">
        <button type="button" className="mobile-session-origin" data-mobile-back aria-label={sessionBackLabel} onClick={requestBack}><ThemeNavigationBackIcon size={16} /><span>{pageName}</span></button>
        {objectIdentity?.mote ? <button className="mobile-mote-heading mobile-session-identity" aria-label={`${moteConversation ? moteTitle : objectIdentity.name} · 查看身份与状态`} onClick={() => openProfile(objectIdentity)}><MobileIdentity identity={objectIdentity} session={selected} client={client} connected={connected} size={28} visible={exposed} /><span className="mobile-session-title">{moteConversation ? moteTitle : sessionTitle ?? objectIdentity.name}</span></button>
          : <><MobileIdentity identity={objectIdentity ?? { name: sessionTitle ?? '原会话', project: pageName }} session={selected} client={client} connected={connected} size={24} visible={exposed} /><span className="mobile-session-title">{sessionTitle ?? selected?.providerId ?? '原会话'}</span></>}
        <div ref={setConversationToolsTarget} className="mobile-session-tool-slot" hidden={!conversationVisible || welcomeVisible || historyVisible} />
        {workface.selectedSessionId && !welcomeVisible && !historyVisible && terminalToggle}
        {!welcomeVisible && !historyVisible && <IconButton className="mobile-icon-button" aria-label="当前对话操作" onClick={() => setSheet('actions')}><ThemeActionMoreIcon size={18} /></IconButton>}
      </div> : <>
        {workspaceVisible && showSession ? <IconButton className="mobile-icon-button" data-mobile-back aria-label={sessionBackLabel} onClick={requestBack}><ThemeNavigationBackIcon size={20} /></IconButton> : <span className="mobile-header-spacer" />}
        {showSession && objectIdentity?.mote ? <button className="mobile-mote-heading" aria-label={`${objectIdentity.name} · 查看身份与状态`} onClick={() => openProfile(objectIdentity)}><MobileIdentity identity={objectIdentity} session={selected} client={client} connected={connected} size={38} visible={exposed} /></button>
          : <div className="mobile-brand"><BrandIcon icon={hostAppearance.appIcon} className="mobile-brand-icon" size={24} /><span>AgentMux</span></div>}
        {showSession ? <div className="mobile-session-header-actions"><div ref={setConversationToolsTarget} className="mobile-session-tool-slot" hidden={!conversationVisible || welcomeVisible || historyVisible} />{terminalToggle}<IconButton className="mobile-icon-button" aria-label="当前对话操作" onClick={() => setSheet('actions')}><ThemeActionMoreIcon size={20} /></IconButton></div> : <span className="mobile-header-spacer" />}
      </>}
    </header>}
    {workspaceVisible && showSession && teamSpaceId && !moteConversation && <MobileMoteTeamSummary team={team} recipient={sessionTitle ?? '收件人名称未确认'}
      role={moteTarget ? !moteDialogue.unavailable && moteDialogue.page?.main.status === 'ready' && moteDialogue.page.main.current && selected?.hostId
        ? moteDialogue.page.main.current.sessionId === workface.selectedSessionId && moteDialogue.page.main.current.hostId === selected.hostId ? '主 Agent' : '成员'
        : '主角色待核对' : mobileMoteRecipient(team, workface.selectedSessionId, selected?.hostId)} issue={teamReading.issue}
      onOpen={() => setSheet('team')} onMain={() => returnToMoteMain()}
      showMain={Boolean(team?.main?.confirmed && (team.main.reference.sessionId !== workface.selectedSessionId || team.main.reference.hostId !== selected?.hostId))} />}
    {moteConversation && teamSpaceId ? <nav className="mobile-mote-navigation" aria-label="Mote 导航" role="tablist">
      <button type="button" role="tab" aria-selected={moteSection === 'discussion'} onClick={() => { setMoteStart(null); setMoteHistory(null); if (workface.selectedSessionId) returnToMoteMain() }}>Discussion</button>
      <button type="button" role="tab" aria-selected={moteSection === 'threads'} onClick={() => { navigationRevision.current++; setMoteView({ spaceId: teamSpaceId, section: 'threads', detail: false }) }}>Threads</button>
      <button type="button" className="mobile-mote-team-button" aria-label="查看本 Mote 团队" onClick={() => setSheet('team')}>团队{team?.members.some(member => member.request) ? ' · 需要你' : ''}</button>
    </nav> : null}
    <main className="mobile-main" tabIndex={-1}>
      {!workspaceVisible && <section className="mobile-connect-page"><BrandIcon icon={hostAppearance.appIcon} className="mobile-connect-dragon" size={150} alt="AgentMux" /><h1>连接你的 Mac</h1>
        <p>在 Mac 的 Phone &amp; Devices 中复制连接链接，用手机打开。两台设备连接同一 Wi-Fi。</p>
        <MobileNotice owner={client} identity={[connection.state,connection.issue]} className="mobile-spatial-notice">{connection.message}</MobileNotice>{connectionPanel}
        <button className="mobile-secondary" onClick={() => setSheet('connection')}><ThemeObjectConnectionIcon size={16} />连接详情</button>
      </section>}
      {workspaceVisible && <>
        <div hidden={showSession || secondary !== null}><MobileSpatialNavigation loadWhen={!showSession && secondary === null} onLoadReturn={returnToConversation} onCreateAgent={createAgent} visible={exposed && !showSession && secondary === null} home={home} client={client} connected={connected} openSession={openSession} openMainAgent={openMainAgent} openProfile={openProfile} onBackChange={registerSpatialBack}
          recentMoteSpaceId={recentMoteSpaceId} onSelectMote={selectMote}
          initialContext={spatialContext} onContextChange={updateSpatialContext} openHttpLink={openBrowserHttpLink} /></div>
        <div hidden={showSession || secondary !== 'topics' || Boolean(source && source.kind !== 'topic')}><MobileTopicsSurface loadWhen={!showSession && secondary === 'topics' && (!source || source.kind === 'topic')} onLoadReturn={returnToConversation} rpc={rpc} visible={exposed && !showSession && secondary === 'topics' && (!source || source.kind === 'topic')} topicId={topicId}
          client={client} connected={connected} {...(topicsRoute.knowledge ? { initialKnowledge: topicsRoute.knowledge } : {})} onKnowledgeChange={updateKnowledgeReference}
          initialContext={topicsRoute.context} onContextChange={updateTopicsContext}
          {...(source?.kind === 'topic' ? { onLeaveTopic: leaveSource, topicBackLabel: '返回知识' } : {})}
          onOpenTopic={topic => updateTopicsContext({ ...topicsRoute.context, topicId: topic.topicId, mode: 'discussion' })} openSource={openSource} openHttpLink={openBrowserHttpLink} onBackChange={registerTopicsBack}
          renderWorkface={(topic, visible) => <MobileZoneWorkface loadWhen={visible} onLoadReturn={returnToConversation} key={topic.topicId} client={client} zoneId={topic.zoneId} name={topic.title} visible={visible} onCreateAgent={createAgent}
            {...(source?.kind === 'topic' && source.topicId === topic.topicId ? { tabId: source.chatId, regionId: source.threadId } : {})} openSession={openSession} />} /></div>
        <div hidden={showSession || secondary !== 'survey'}><MobileSurveySurface loadWhen={!showSession && secondary === 'survey'} onLoadReturn={returnToConversation} client={client} connected={connected} visible={exposed && !showSession && secondary === 'survey'} openSession={openSession}
          openTopic={openSurveyTopic} initialContext={surveyContext} onContextChange={updateSurveyContext} onBackChange={registerSurveyBack} openHttpLink={openBrowserHttpLink} /></div>
        {source && source.kind !== 'topic' && <div hidden={showSession || secondary !== 'topics'}>
          {source.kind === 'space' || source.kind === 'survey' ? <>
            <button className="mobile-text-button" onClick={leaveSource}><ThemeNavigationBackIcon size={16} />返回知识</button>
            <MobileZoneWorkface loadWhen={!showSession && secondary === 'topics'} onLoadReturn={returnToConversation} key={source.zoneId} client={client} zoneId={source.zoneId} name="来源工作面" visible={exposed && !showSession && secondary === 'topics'} tabId={source.tabId} regionId={source.regionId} openSession={openSession} />
          </> : source.kind === 'file' || source.kind === 'note' || source.kind === 'notebook' ? <MobileTopicSource loadWhen={!showSession && secondary === 'topics'} onLoadReturn={returnToConversation} source={source} rpc={rpc} onBack={leaveSource} openHttpLink={openBrowserHttpLink}
            visible={exposed && !showSession && secondary === 'topics'} onBackChange={registerSourceBack}
            {...(sourceReference ? { initialReference: sourceReference } : {})} onReferenceChange={updateSourceReference}
            openScope={scope => { openSource({ kind: 'space', zoneId: scope.zoneId }) }} /> : null}
        </div>}
        <div hidden={showSession || secondary !== 'goals'}><MobileGoalsSurface loadWhen={!showSession && secondary === 'goals'} onLoadReturn={returnToConversation} client={client} connected={connected} visible={exposed && !showSession && secondary === 'goals'} openSession={openSession} onBackChange={registerGoalsBack}
          context={goalsContext} onContextChange={updateGoalsContext} copyText={platform.copyText} /></div>
      </>}
      <section className="mobile-goal-panel" hidden={!workspaceVisible || !showSession || !showGoalWork}>
        <MobileGoalWork loadWhen={workspaceVisible && showSession && showGoalWork} onLoadReturn={returnToConversation} client={client} agentSessionId={workface.selectedSessionId} connected={connected} visible={exposed && workspaceVisible && showSession && showGoalWork} />
      </section>
      <section className="mobile-mote-threads-panel" hidden={!threadsVisible}>
        <MobileMoteThreads client={client} dialogue={moteDialogue} team={team} issue={teamReading.issue} visible={exposed && threadsVisible}
          currentSessionId={workface.selectedSessionId} currentHostId={selected?.hostId} onOpen={openTeamMember} onWork={openMoteWork}
          onMain={() => returnToMoteMain()} onConfigure={() => { if (objectIdentity) openProfile(objectIdentity) }}
          onRefresh={() => { teamReading.refresh(); moteDialogue.refresh() }} />
      </section>
      <section className="mobile-conversation-panel" hidden={!workspaceVisible || !showSession || showGoalWork || workface.panel === 'terminal' || threadsVisible}>
        {!workface.selectedSessionId && !welcomeVisible && <div className="mobile-chat-start">
          <ThemeObjectConversationIcon size={24} /><h1>继续对话</h1>
          <p>{chatStartIssue ?? '正在找回原对话…'}</p>
          <div><button type="button" className="mobile-text-button" onClick={() => openPrimaryWorkface('mote')}>选择 Mote</button>
            <button type="button" className="mobile-text-button" onClick={() => openPrimaryWorkface('focus')}>已有对话</button>
            {objectIdentity?.mote && <button type="button" className="mobile-text-button" onClick={() => openProfile(objectIdentity)}>查看 Profile</button>}
            {chatStartIssue && <button type="button" className="mobile-text-button" onClick={() => { chatStartDone.current = false; chatStartExpectedRevision.current = navigationRevision.current; retryChatStart(value => value + 1) }}>重新核对</button>}</div>
        </div>}
        {welcomeVisible && moteTarget && objectIdentity && !historyVisible && <MobileMoteConversationStart key={JSON.stringify(moteTarget)} client={client} target={moteTarget} identity={{ ...objectIdentity, mote: { ...objectIdentity.mote!, appearance: team?.appearance ?? objectIdentity.mote?.appearance } }}
          platform={platform} visible={exposed && conversationVisible} appIcon={hostAppearance.appIcon} mode={moteStart?.mode ?? 'start'} dialogue={moteDialogue} automatic={moteStart?.automatic}
          onAutomaticConsumed={id => setMoteStart(current => current?.automatic?.decision.queryOperationId === id ? { spaceId: current.spaceId, mode: current.mode } : current)}
          memberName={reference => { const member = team?.members.find(member => member.hostId === reference.hostId && member.sessionId === reference.sessionId); return member && member.name !== member.sessionId ? member.name : undefined }}
          onConfigure={() => openProfile(objectIdentity)} onBound={() => { teamReading.refresh(); moteDialogue.refresh() }}
          onOpenMain={reference => openMainAgent(reference.sessionId, objectIdentity, reference.hostId)} onOpenPeriod={source => setMoteHistory(source)} />}
        {historyVisible && moteHistory && <section className="mobile-mote-period-view" aria-label="原主对话历史"><button type="button" onClick={() => setMoteHistory(null)}>返回本次对话</button>
          <ClientUiProvider platform={platform}><MotePeriodConversation source={moteHistory} client={client} visible={exposed && conversationVisible}
            name={moteTitle} onOpenOriginal={() => {
              let original
              try { original = client?.agentSession(moteHistory.reference.sessionId) } catch { /* A missing observation preserves this exact history reference. */ }
              if (!original || original.hostId !== moteHistory.reference.hostId) { setNotice('原历史的 Host 或 Agent 尚未匹配；这段引用与当前草稿保留。'); return }
              openSession(moteHistory.reference.sessionId, objectIdentity!)
            }} /></ClientUiProvider></section>}
        {!welcomeVisible && !historyVisible && moteConversation && !moteDirectAgent && moteTarget && objectIdentity && <MobileMoteStartRecovery client={client} target={moteTarget} visible={exposed && conversationVisible}
          onConfigure={() => openProfile(objectIdentity)} onBound={() => { teamReading.refresh(); moteDialogue.refresh() }} onOpenMain={reference => openMainAgent(reference.sessionId, objectIdentity, reference.hostId)} />}
        <div hidden={welcomeVisible || historyVisible} className={`mobile-conversation-slot${workface.selectedSessionId ? ' is-active' : ''}`}>

          {moteConversation && threadDetail ? <div className="mobile-mote-thread-return"><span>原 Agent 对话 · {sessionTitle ?? '成员'}</span><button type="button" onClick={() => { navigationRevision.current++; setMoteView({ spaceId: teamSpaceId!, section: 'threads', detail: false }) }}>返回 Threads</button></div> : null}
          {workface.selectedSessionId && <MobileConversationSurface client={client} agentSessionId={workface.selectedSessionId} moteMemberName={moteMemberName} moteTarget={moteTarget} moteDialogue={moteDialogue} moteDirectAgent={moteDirectAgent} moteName={moteTitle} moteAppearance={team?.appearance ?? objectIdentity?.mote?.appearance}
            moteWorkMemberName={source => workMember(source)?.name ?? source.origin.recipientSessionId} onOpenMoteWork={openMoteWork} onReturnMoteMain={returnToMoteMain}
            onMoteRolloverRequired={query => { if (teamSpaceId && moteTarget && !moteDirectAgent) { navigationRevision.current++; setMoteHistory(null); setMoteStart({ spaceId: teamSpaceId, mode: 'new', automatic: query }) } }}
            onShowMoteThreads={() => { if (teamSpaceId) { navigationRevision.current++; setMoteView({ spaceId: teamSpaceId, section: 'threads', detail: false }) } }}
            moteConfigurationIssue={moteEntryIssue?.client === client && moteEntryIssue.spaceId === teamSpaceId ? moteEntryIssue.message : null} onRefreshMoteConfiguration={() => { void refreshMoteConfiguration() }}
            moteSource={mobileMoteInputSource(objectIdentity, workface.selectedSessionId, identityRecipient)} connection={connection} platform={platform} toolbarTarget={conversationToolsTarget} {...(sessionTitle ? { displayName: sessionTitle } : {})} visible={exposed && conversationVisible && !welcomeVisible && !historyVisible} onShowTerminal={() => setWorkface(value => ({ ...value, panel: 'terminal' }))}
            onShowGoals={trigger => { goalReturn.current = { trigger, sessionId: workface.selectedSessionId }; setShowGoalWork(true) }} openHttpLink={openBrowserHttpLink} />}
        </div>
      </section><section className="mobile-terminal-panel" hidden={!workspaceVisible || !showSession || showGoalWork || workface.panel !== 'terminal'}>
        <MobileTerminalViewer loadWhen={workspaceVisible && showSession && !showGoalWork && workface.panel === 'terminal'} onLoadReturn={returnToConversation} terminalPalette={hostAppearance.terminalPalette} client={client} agentSessionId={workface.selectedSessionId} connection={connection} platform={platform} {...(sessionTitle ? { displayName: sessionTitle } : {})} inputActive={exposed} visible={workspaceVisible && showSession && !showGoalWork && workface.panel === 'terminal'} />
      </section>
    </main>
    <div className="mobile-notice-stack">
      <MobileAvatarNoticeOutlet />
      {webObservation && <MobileNotice owner={client} hidden={mobileWebUpdateStatus(webObservation) !== 'available'}
        identity={[webObservation.inspection.result?.hostInstanceId, webObservation.inspection.result?.active?.digest]} className="mobile-web-update-notice" kind="feedback">
        <span>网页有新版本</span><button type="button" onClick={() => setSheet('settings')}>前往更新</button>
      </MobileNotice>}
      {(serviceNotices.length > 0 || !canPersist) && <MobileNotice owner={client} kind="feedback" identity={[notice,visibleProjectionError,hostAppearance.issue,connection.issue,connection.state,canPersist]} className="mobile-service-notice"><span className="mobile-notice-mark"><ThemeStatusInfoIcon size={15} /></span><div>{serviceNotices.map(message => <p key={message}>{message}</p>)}{!canPersist && <button onClick={restoreNavigationStorage}>用当前工作面替换原记录</button>}</div></MobileNotice>}
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
        <div className="mobile-sheet-handle" /><div className="mobile-sheet-title"><Dialog.Title>{sheet === 'team' ? `${team?.name ?? moteTitle} · 团队` : sheet === 'agent' ? menuTarget?.identity.name ?? 'Agent' : sheet === 'notices' ? '提醒与诊断' : sheet === 'identity' ? profileIdentity?.mote ? profileIdentity.mote.name ?? 'Mote 名称未确认' : profileIdentity?.name ?? 'Mote' : sheet === 'actions' ? '当前对话' : sheet === 'settings' ? 'AgentMux' : '连接你的 Mac'}</Dialog.Title><Dialog.Close asChild><IconButton className="mobile-icon-button" aria-label="关闭面板"><ThemeActionCloseIcon size={19} /></IconButton></Dialog.Close></div>
        {sheet === 'team' ? <>
          <Dialog.Description id="mobile-sheet-description">原团队的当前工作与请求</Dialog.Description>
          <MobileMoteTeamPanel team={team} issue={teamReading.issue} currentSessionId={workface.selectedSessionId} currentHostId={selected?.hostId}
            onRefresh={() => { teamReading.refresh(); moteDialogue.refresh() }} onOpen={openTeamMember} onMain={() => returnToMoteMain()}
            onWork={(id, identity, member) => openTeamMember(id, identity, member, true)}
            onConfigure={() => { if (objectIdentity) openProfile(objectIdentity) }} />
        </> : sheet === 'settings' ? <>
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
          {projectionError && workface.selectedSessionId && <section className="mobile-session-diagnostic">
            <h3>对话信息未确认</h3><p>{projectionError}</p>
            <button type="button" className="mobile-text-button" onClick={() => setSheet('connection')}>查看 Mac 连接</button>
            <button type="button" className="mobile-text-button" onClick={returnToConversation}>返回这段对话</button>
            <details><summary>对话身份</summary><code>{workface.selectedSessionId}</code></details>
          </section>}
          <MobileGoalOperationRecovery copyText={platform.copyText} />
          <MobileNoticeRestore onRestored={() => setSheet(null)} />
        </> : sheet === 'identity' && profileIdentity ? <>
          <Dialog.Description id="mobile-sheet-description">原资料与当前工作</Dialog.Description>
          <MobileMoteProfile loadWhen={sheet === 'identity'} loadingReturn={false} onLoadReturn={requestBack} identity={profileIdentity} client={client} onOpenMain={() => { setSheet(null); void enterMote(profileIdentity?.mote?.spaceId ?? null) }} copyText={platform.copyText} visible={sheet === 'identity'} sourcePath={profileSourcePath} onSourceChange={setProfileSourcePath} onBackChange={registerProfileBack} onOpenGoals={id => {
            openSession(id, profileIdentity); setShowGoalWork(true); setSheet(null)
          }} />
        </> : sheet === 'agent' && menuTarget ? <>
          <Dialog.Description id="mobile-sheet-description">{menuTarget.identity.project}</Dialog.Description>
          {menuIssue && <MobileNotice owner={client} identity={[menuTarget.agentSessionId, menuIssue]} role="status">{menuIssue}</MobileNotice>}
          <MobileAgentActions key={menuTarget.agentSessionId} client={client} agentSessionId={menuTarget.agentSessionId} connected={connected} copyText={platform.copyText} beforeAction={validateMenuSource} statusSource={menuTarget} />
          <button className="mobile-menu-row" onClick={() => { if (validateMenuSource()) { openSession(menuTarget.agentSessionId, menuTarget.identity); setSheet(null) } }}><ThemeObjectConversationIcon size={18} /><span>打开原对话</span></button>
        </> : sheet === 'actions' ? <>
          {moteConversation && !moteDirectAgent && moteDialogue.page?.main.status === 'ready' && moteDialogue.page.main.current && <button type="button" className="mobile-menu-row" aria-label="新一轮" onClick={beginMoteRound}><ThemeObjectConversationIcon size={20} /><span>新一轮<small>保留原对话，继续同一个 Mote</small></span></button>}
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
