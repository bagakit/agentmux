import { mobileMemberDraftScope, mobileMemberSelection } from './navigation/mobile-member-target'
import { hasMobileTerminal } from './conversation/mobile-conversation-client'
import { useMobileMember } from './conversation/mobile-member'
import { IconButton } from '@agentmux/client-ui/components/IconButton'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxSpaceCatalog, TopicKnowledgeSource } from '@agentmux/core/control'

import { useTopicsNavigation } from './topics/use-topics-navigation'
import type { MobileSurveyContext } from './survey/MobileSurveySurface'

import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import { MobileAgentCreate, type MobileAgentCreateTarget } from './navigation/MobileAgentCreate'
import { MobileAgentActions } from './conversation/MobileAgentActions'
import { MobileConversationStatusDetails, mobileConversationStatusLabel, type MobileConversationStatus } from './conversation/MobileConversationStatus'
import { recoverMobileAgent } from './conversation/mobile-agent-recovery'
import { MobileAgentLocations } from './navigation/MobileAgentLocations'
import { MobileAgentMenuContext, type MobileAgentMenuTarget } from './navigation/MobileAgentRow'
import { MobileConversationSurface, type MobileConnection } from './conversation/MobileConversationSurface'
import { mobileMoteInputSource } from './conversation/mote-input-source'
import { ClientUiProvider } from '@agentmux/client-ui/platform'
import { MotePeriodConversation } from '@agentmux/client-ui/components/MoteConversationThreads'
import { MobileMoteConversationStart, MobileMoteStartRecovery } from './navigation/MobileMoteConversationStart'
import type { MobileMoteRolloverQuery } from './conversation/mote-main-input'
import type { MoteDialogueLink } from '@agentmux/core/mote-dialogue'
import { MobileMoteThreads } from './navigation/MobileMoteThreads'
import { MobileMoteGroups, type MoteGroupReadingPositions } from './navigation/MobileMoteGroups'
import { MobileMoteContext, MobileMoteTeamPanel, mobileMoteRecipient } from './navigation/MobileMoteTeam'
import { useMobileMoteTeam } from './navigation/use-mobile-mote-team'
import { mobileMoteMainIdentity, mobileMoteMemberName, type MobileMoteMember } from './navigation/mobile-mote-team'
import { mobileMoteMemberIdentity } from './navigation/mobile-mote-team'
import type { MobileMoteWork } from './conversation/MobileMoteConversation'
import type { MoteDefaultConversation } from '@agentmux/core/mote-preferences'
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
import { MobileHeaderMenuContext } from './navigation/MobileHeaderMenu'
import { mobileNeedsYouElsewhere } from './navigation/needs-you'
import { useMobileAttentionCatalog } from './navigation/use-mobile-attention-catalog'
import { MobileAttentionNotice } from './navigation/MobileAttentionNotice'
import { useMobileScreenMotion } from './navigation/use-mobile-screen-motion'
import './navigation/shell.css'
import './conversation/chrome.css'
import { MobileConnectPage, MobileDrawerConnection } from './connection/MobileConnectionStatus'
import type { MobileSpatialContext } from './navigation/MobileSpatialNavigation'
import { readMobileHome, saveMobileHome, type MobileHome, type MobilePrimaryWorkface } from './navigation/home-preference'

import { mobileChatStart, mobileMoteOwner } from './navigation/chat-start'
import { useMobileBack } from './navigation/useMobileBack'
import { retainObjectReference, type MobilePresentationRoute, type MobileGoalsContext } from './recovery/presentation-route'
import type { MobileTopicSourceContentReference } from './topics/source-reference'
import { MobileAvatarNoticeOutlet, MobileNotice, MobileNoticeProvider, MobileNoticeRestore, MobileNoticeScope, useMobileNotices } from './notices/MobileNotice'
import { MobileGoalOperationRecovery, MobileGoalOperationSafety } from './goals/goal-operation-recovery'
import { MobileWebDiagnostics } from './mobile-web/MobileWebDiagnostics'
import { MobileWebUpdateSettings } from './mobile-web/MobileWebUpdate'
import { mobileWebUpdateStatus } from './mobile-web/use-mobile-web-observation'
import type { MobileWebPageObservation } from './mobile-web/use-mobile-web-observation'

import { deferMobileSurface } from './navigation/defer-mobile-surface'
import { MobileLocalDraftsOwner } from './conversation/local-drafts-owner'
import { useMobileWebAttachmentOwner } from './mobile-web/update-safety'
import { MobileMoteComposer, mobileSessionComposerSource, mobileWelcomeComposerSource } from './conversation/mote-composer'
import { useEdgeBack } from './navigation/use-edge-back'
import { MobileSheetHeader } from './navigation/MobileSheetHeader'
import { useMobileWorkfaceLayout } from './layout/use-mobile-workface-layout'
import { MobileWorkfaceFrame, MobileWorkfacePane } from './layout/MobileWorkfaceFrame'
import { workfacePanes } from './layout/workface-presentation'
import { currentMobileWorkface } from './navigation/current-workface'

const MobileTerminalViewer = deferMobileSurface('终端', async () => ({ default: (await import('./terminal/MobileTerminalViewer')).MobileTerminalViewer }))
const MobileSpatialNavigation = deferMobileSurface('目录', async () => ({ default: (await import('./navigation/MobileSpatialNavigation')).MobileSpatialNavigation }), { menu: true })
const MobileTopicsSurface = deferMobileSurface('Topics', async () => ({ default: (await import('./topics/MobileTopicsSurface')).MobileTopicsSurface }), { menu: true })
const MobileSurveySurface = deferMobileSurface('Survey', async () => ({ default: (await import('./survey/MobileSurveySurface')).MobileSurveySurface }), { menu: true })
const MobileGoalsSurface = deferMobileSurface('Goals', async () => ({ default: (await import('./goals/MobileGoalsSurface')).MobileGoalsSurface }), { menu: true })
const MobileGoalWork = deferMobileSurface('当前目标', async () => ({ default: (await import('./navigation/MobileGoalWork')).MobileGoalWork }))
const MobileMoteProfile = deferMobileSurface('Profile', async () => ({ default: (await import('./navigation/MobileMoteProfile')).MobileMoteProfile }))
const MobileTopicSource = deferMobileSurface('知识来源', async () => ({ default: (await import('./topics/MobileTopicSource')).MobileTopicSource }), { menu: true })
const MobileZoneWorkface = deferMobileSurface('来源工作面', async () => ({ default: (await import('./navigation/MobileZoneWorkface')).MobileZoneWorkface }))

const ThemeNavigationSubmenuIcon = semanticIconComponent('navigation.submenu')
const ThemeObjectConversationIcon = semanticIconComponent('object.conversation')
const ThemeObjectGoalIcon = semanticIconComponent('object.goal')
const ThemeActionMoreIcon = semanticIconComponent('action.more')
const ThemeActionComposeIcon = semanticIconComponent('action.compose')
const ThemeStatusInfoIcon = semanticIconComponent('status.info')
const ThemeNavigationBackIcon = semanticIconComponent('navigation.back')
const ThemeActionMenuIcon = semanticIconComponent('action.menu')
const ThemeObjectTerminalIcon = semanticIconComponent('object.terminal')
const ThemeOpenSidebarIcon = semanticIconComponent('layout.open-left')
const ThemeCloseSidebarIcon = semanticIconComponent('layout.close-left')
const ThemeNavigationSurveyIcon = semanticIconComponent('navigation.survey')

type Workface = Navigation

function loadWorkface(): { workface: Workface; presentation?: MobilePresentationRoute; issue: string | null } {
  const empty: Workface = { selectedSessionId: null, hostUrl: '', panel: 'conversation' }
  try {
    return getDeviceWorkface().snapshotNavigation()
  } catch {
    return { workface: empty, issue: '这台设备暂时读不到导航记录，Mac 上的对话不受影响。' }
  }
}

type MobileAppProps = {
  client: AgentMuxHostedClient | null; connection: MobileConnection; platform: ClientUiPlatform
  native?: boolean; focusComposer?: () => boolean
  gatewayEndpoint?: string
  connectionPanel?: ReactNode
  webObservation?: MobileWebPageObservation | null
  /** First presentation only, after the connection owner verifies the original reload handoff. */
  restoreWorkface?: boolean
}
export function MobileApp(props: MobileAppProps) {
  return <MobileNoticeProvider><MobileAppContent {...props} /></MobileNoticeProvider>
}
function MobileAppContent({ client, connection, platform: basePlatform, native = false, focusComposer = () => false, connectionPanel, gatewayEndpoint, webObservation, restoreWorkface = false }: MobileAppProps) {
  const attachmentOwner = useMobileWebAttachmentOwner()
  const composeAfterClose = useRef<{ client: MobileAppProps['client']; sessionId: string } | null>(null)
  const composeScope = useRef({ client, sessionId: null as string | null, visible: false, focusComposer })
  const connected = connection.state === 'connected'
  const notices = useMobileNotices()
  const initial = useRef<ReturnType<typeof loadWorkface> | null>(null)
  initial.current ??= loadWorkface()
  const navigationRecord = useRef<{ recordId: string | null } | null>(null)
  navigationRecord.current ??= { recordId: getDeviceWorkface().recordIdentity() }
  const [hasConnected, setHasConnected] = useState(connection.state === 'connected' || initial.current.workface.selectedSessionId !== null || initial.current.presentation !== undefined)
  const workspaceVisible = connected || hasConnected
  const hostAppearance = useHostAppearance(client, connection.state)
  const platform = useMemo(() => ({ ...basePlatform, conversationDetailLevel: hostAppearance.conversationDetailLevel,
    conversationShowSendReceipts: hostAppearance.conversationShowSendReceipts,
    conversationConfirmedSendReceipt: hostAppearance.conversationConfirmedSendReceipt
  }), [basePlatform, hostAppearance.conversationDetailLevel, hostAppearance.conversationShowSendReceipts, hostAppearance.conversationConfirmedSendReceipt])
  useEffect(() => { if (connection.state === 'connected') setHasConnected(true) }, [connection.state])
  const [workface, setWorkface] = useState<Workface>(() => restoreWorkface ? initial.current!.workface : { ...initial.current!.workface, panel: 'conversation' })
  const [canPersist, setCanPersist] = useState(initial.current.issue === null)
  const initialHome = useRef(readMobileHome())
  const initialPrimary = initial.current.presentation?.primary ?? initialHome.current.home
  const [home, setHome] = useState<MobileHome>(initialPrimary === 'mote' || initialPrimary === 'space' ? initialPrimary : 'focus')
  const [defaultHome, setDefaultHome] = useState<MobilePrimaryWorkface>(initialHome.current.home)
  const [homeIssue, setHomeIssue] = useState(initialHome.current.issue)
  const [secondary, setSecondary] = useState<'topics' | 'survey' | 'goals' | null>(initialPrimary === 'goals' || initialPrimary === 'topics' || initialPrimary === 'survey' ? initialPrimary : null)
  const primary = secondary ?? home
  const topicsNavigation = useTopicsNavigation(initial.current.presentation?.topics, client)
  const topicsRoute = topicsNavigation.route
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
  const source = topicsRoute.sources.at(-1)?.source ?? null
  const sourceReference = topicsRoute.sources.at(-1)?.content
  const sourceFrame = topicsNavigation.state.sources.at(-1)
  const updateSourceReference = useCallback((content: MobileTopicSourceContentReference) => {
    if (sourceFrame) topicsNavigation.observe({ type: 'source-content', frameToken: sourceFrame.token, source: sourceFrame.value.source, content })
  }, [topicsNavigation.observe, sourceFrame?.token])
  const leaveSource = useCallback(() => topicsNavigation.send({ type: 'source-leave' }), [topicsNavigation.send])
  const pageName = primary === 'topics' ? 'Topics' : primary === 'survey' ? 'Survey' : primary === 'goals' ? 'Goals' : primary === 'mote' ? 'Mote' : primary === 'space' ? 'Space' : 'Focus'
  const rpc = useCallback<NonNullable<AgentMuxHostedClient['forwardRpc']>>((method, params) => {
    if (!client?.forwardRpc) return Promise.reject(new Error('连接暂不可用，连上 Mac 后可继续。'))
    return client.forwardRpc(method, params)
  }, [client])
  const [showSession, setShowSession] = useState(restoreWorkface ? initial.current.presentation?.showSession ?? true : true)
  const [showGoalWork, setShowGoalWork] = useState(restoreWorkface && (initial.current.presentation?.showGoalWork ?? false))
  const [conversationToolsTarget, setConversationToolsTarget] = useState<HTMLDivElement | null>(null)
  const [conversationStatusTarget, setConversationStatusTarget] = useState<HTMLSpanElement | null>(null)
  const [moteNoticeTarget, setMoteNoticeTarget] = useState<HTMLSpanElement | null>(null)
  const [recentMoteSpaceId, setRecentMoteSpaceId] = useState(initial.current.presentation?.recentMoteSpaceId ?? initial.current.presentation?.identity?.mote?.spaceId ?? null)
  const startupProfile = useRef(restoreWorkface ? null : initial.current.presentation?.profile ?? null)
  const goalReturn = useRef<{ trigger: HTMLButtonElement; sessionId: string | null } | null>(null)
  const sessionActionsButton = useRef<HTMLButtonElement | null>(null)
  const showConversationGoals = (trigger: HTMLButtonElement) => {
    navigationRevision.current++
    goalReturn.current = { trigger, sessionId: workface.selectedSessionId }
    setShowGoalWork(true)
  }
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
  const memberSelection = identityRecipient === workface.selectedSessionId ? objectIdentity?.member : undefined
  const member = useMobileMember(client, memberSelection, workface.selectedSessionId)
  const conversationClient = member.client
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
    const foreign = hostId !== 'local', source = client
    const retained = identity.member ?? (foreign ? { sourceRuntimeId: source?.runtimeOwnerIdentity?.()?.runtimeId ?? null,
      issue: '正在核对原主对话的成员位置；未改用本机同名对话。' } : undefined)
    openSession(id, retained ? { ...identity, member: retained } : identity)
    setMoteDirectAgent(false)
    if (identity.mote) setMoteView({ spaceId: identity.mote.spaceId, section: 'discussion', detail: false })
    const revision = navigationRevision.current
    if (!source || !connected) { setNotice('连接暂不可用，连上 Mac 后可以恢复主 Agent。'); return }
    if (retained) {
      // A member route is never a Source-local recovery or input grant.
      if (!identity.member && foreign) {
        const spaceId = identity.mote?.spaceId ?? identity.context?.spaceId
        if (!spaceId || !source.forwardRpc) { setNotice('原主对话的位置尚未确认，原引用和草稿保持不变。'); return }
        void source.forwardRpc('space.ls', { target: { spaceId } }).then(({ catalog }) => {
          if (originalConnection.current.client !== source || navigationRevision.current !== revision || source.runtimeOwnerIdentity?.()?.runtimeId !== retained.sourceRuntimeId) return
          const member = mobileMemberSelection(source, catalog, id, identity.context, hostId)
          setObjectIdentity(current => current ? { ...current, member: member ?? retained } : current)
        }).catch(error => { if (originalConnection.current.client === source && navigationRevision.current === revision) setNotice(error instanceof Error ? error.message : String(error)) })
      }
      return
    }
    void recoverMobileAgent({ client: source, agentSessionId: id, expectedHostId: hostId, mode: 'open',
      isCurrent: () => originalConnection.current.client === source && originalConnection.current.connected && navigationRevision.current === revision,
      onNotice: setNotice, quietWhenConfirmed: true })
  }, [client, connected, openSession])
  const openSource = (value: TopicKnowledgeSource) => {
    navigationRevision.current += 1
    if (value.kind === 'url') { openBrowserHttpLink(value.url); return }
    topicsNavigation.send({ type: 'source-open', source: value })
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
      if (topic) { topicsNavigation.send({ type: 'topic', topicId: topic, categoryId: null }); setSecondary('topics') }
      else setNotice('这项研究对应的 Topic 还没确认，请刷新后重试。')
    }).catch(error => setNotice(error instanceof Error ? error.message : String(error)))
  }
  const sessionTitle = objectIdentity?.name ?? null
  const [sheet, updateSheet] = useState<'connection' | 'settings' | 'identity' | 'actions' | 'agent' | 'create' | 'notices' | 'team' | 'groups' | null>(restoreWorkface && initial.current.presentation?.profile ? 'identity' : null)
  const [groupMoteId, setGroupMoteId] = useState<string | null>(null)
  const [groupBack, setGroupBack] = useState<(() => void) | null>(null)
  const registerGroupBack = useCallback((back: (() => void) | null) => setGroupBack(() => back), [])
  const groupTrigger = useRef<HTMLButtonElement | null>(null)
  const [groupReadingPositions] = useState<MoteGroupReadingPositions>(() => new Map())
  const [positionOverlay, setPositionOverlay] = useState(false)
  const setSheet = useCallback((value: typeof sheet) => {
    if (value !== 'agent') setPositionOverlay(false)
    if (value !== null) navigationRevision.current += 1
    updateSheet(value)
  }, [])
  const openGroups = useCallback((moteId: string | null, trigger: HTMLButtonElement) => {
    groupTrigger.current = trigger
    setGroupMoteId(moteId)
    setSheet('groups')
  }, [setSheet])
  const openGroupDirectory = useCallback((trigger: HTMLButtonElement) => openGroups(null, trigger), [openGroups])
  const menuSource = () => {
    const runtime = client?.runtimeOwnerIdentity?.(), { recordId, host } = getDeviceWorkface().snapshotIdentity()
    return JSON.stringify([runtime?.runtimeId, runtime?.ownerInstanceId, recordId, host?.hostId, host?.origin])
  }
  const [rowMenu, setRowMenu] = useState<{ client: typeof client; target: MobileAgentMenuTarget; source: string } | null>(null)
  const [menuIssue, setMenuIssue] = useState('')
  const openAgentMenu = useCallback((target: MobileAgentMenuTarget) => { setRowMenu({ client, target, source: menuSource() }); setMenuIssue(''); setSheet('agent') }, [client])
  const menuTarget = rowMenu?.client === client ? rowMenu?.target : null
  const menuMember = useMobileMember(client, menuTarget?.identity.member, menuTarget?.agentSessionId)
  const validateMenuSource = useCallback(() => {
    if (rowMenu && rowMenu.client === client && rowMenu.source === menuSource() && (!rowMenu.target.beforeAction || rowMenu.target.beforeAction())) return true
    setMenuIssue('菜单打开后连接或位置已变化，请关闭后重新打开。')
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
    const showDirectory = (issue: string) => {
      setHome('mote'); setSecondary(null); setShowSession(false); setShowGoalWork(false); setNotice(issue)
    }
    const isCurrent = () => {
      const current = source?.runtimeOwnerIdentity?.()
      return navigationRevision.current === revision && originalConnection.current.client === source && originalConnection.current.connected &&
        current?.runtimeId === runtime?.runtimeId && current?.ownerInstanceId === runtime?.ownerInstanceId && getDeviceWorkface().recordIdentity() === recordId
    }
    if (!source?.forwardRpc || !connected) { showDirectory('暂时无法核对 Mote 主对话，可以从 Mote 目录继续对话。'); return }
    try {
      let discovered: AgentMuxSpaceCatalog['spaces'][number] | undefined
      if (!spaceId) {
        const { catalog } = await source.forwardRpc('space.ls', { target: {} })
        if (!isCurrent()) return
        discovered = mobileMoteOwner(catalog, null)
        if (!discovered) { showDirectory('还没确认是哪个 Mote，请在 Mote 目录中选择。'); return }
        spaceId = discovered.spaceId
      }
      const { catalog } = await source.forwardRpc('space.ls', { target: { spaceId }, presentation: true })
      if (!isCurrent()) return
      const owner = mobileMoteOwner(catalog, spaceId, discovered)
      if (!owner) { showDirectory('还没确认是哪个 Mote，请在 Mote 目录中选择。'); return }
      // This entry is for one exact object; an unbound Mote cannot borrow another Main.
      const target = mobileChatStart({ ...catalog, spaces: [owner] }, owner.spaceId)
      const facts = target.identity?.mote?.facts
      const main = facts?.quickMode.status === 'saved' ? facts.quickMode.defaults.conversation : undefined
      setHome('mote'); setSecondary(null); setShowGoalWork(false); setRecentMoteSpaceId(owner.spaceId)
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
    } catch (error) { if (isCurrent()) showDirectory(`Mote 主对话核对未完成：${error instanceof Error ? error.message : String(error)}。可以从 Mote 目录重试。`) }
  }, [client, connected, openMainAgent, objectIdentity, identityRecipient, workface.selectedSessionId])
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
  const moteSection = moteView && moteView.spaceId === objectIdentity?.mote?.spaceId ? moteView.section : moteDirectAgent ? 'threads' : 'discussion'
  const threadDetail = Boolean(moteSection === 'threads' && moteView && moteView.spaceId === objectIdentity?.mote?.spaceId && moteView.detail)
  const current = currentMobileWorkface({ primary, showSession, showGoalWork, panel: workface.panel,
    mote: Boolean(objectIdentity?.mote), section: moteSection, threadDetail, sourceKind: source?.kind })
  const { moteConversation, moteRoot, workPanel } = current
  const familyBack = primary === 'topics' ? topicsBack : primary === 'goals' ? goalsBack : primary === 'survey' ? surveyBack : spatialBack
  const hasBack = sheet !== null || current.session || current.source || familyBack !== null
  const requestBack = useMobileBack(hasBack, () => {
    navigationRevision.current += 1
    if (sheet === 'agent' && positionOverlay) setPositionOverlay(false)
    else if (sheet !== null) {
      if (sheet === 'identity' && profileBack) profileBack()
      else if (sheet === 'groups' && groupBack) groupBack()
      else setSheet(null)
    } else if (current.session) {
      if (current.goal) setShowGoalWork(false)
      else if (current.terminal) setWorkface(value => ({ ...value, panel: 'conversation' }))
      // A thread opened inside Mote returns to its Threads list, one layer up.
      else if (current.kind === 'thread') setMoteView({ spaceId: objectIdentity!.mote!.spaceId, section: 'threads', detail: false })
      else closeSession()
    } else if (current.source && source) {
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
  // Left-edge swipe back runs the same Back as the header button, only while something is behind.
  const mainRef = useRef<HTMLElement>(null)
  const moteDirectoryRef = useRef<HTMLElement>(null)
  const [moteDirectoryTarget, setMoteDirectoryTarget] = useState<HTMLElement | null>(null)
  const attachMoteDirectory = useCallback((element: HTMLElement | null) => {
    moteDirectoryRef.current = element; setMoteDirectoryTarget(element)
  }, [])
  const swipeBack = useCallback(() => backRef.current(), [])
  useEdgeBack(mainRef, (connected || hasConnected) && hasBack, swipeBack, navigationRevision.current)
  useEdgeBack(moteDirectoryRef, (connected || hasConnected) && hasBack && current.directory === 'mote', swipeBack, navigationRevision.current)
  backRef.current = requestBack
  const [notice, setNoticeValue] = useState<string | null>(initial.current.issue)
  const [noticeDetail, setNoticeDetail] = useState<string | undefined>()
  const setNotice = useCallback((message: string | null, technical?: string) => { setNoticeValue(message); setNoticeDetail(technical) }, [])
  const [chatStartIssue, setChatStartIssue] = useState<string | null>(restoreWorkface && !initial.current.workface.selectedSessionId ? '已回到上次的位置，可以选择 Mote 或已有对话。' : null)
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
        originalConnection.current.client === client && originalConnection.current.connected &&
        owner?.runtimeId === currentOwner?.runtimeId && owner?.ownerInstanceId === currentOwner?.ownerInstanceId
    }
    void (async () => {
      let recentCatalog: AgentMuxSpaceCatalog | undefined
      if (recentMoteSpaceId) {
        const { catalog } = await client.forwardRpc!('space.ls', { target: { spaceId: recentMoteSpaceId }, presentation: true })
        if (!isCurrent()) return
        const recent = mobileMoteOwner(catalog, recentMoteSpaceId)
        recentCatalog = { ...catalog, spaces: recent ? [recent] : [] }
        const target = mobileChatStart(recentCatalog, recentMoteSpaceId)
        const facts = target.identity?.mote?.facts
        // Only a confirmed unconfigured recent Mote may fall through to the primary.
        if (!facts || facts.quickMode.status === 'unconfirmed' || target.sessionId) return target
      }
      const { catalog: discovery } = await client.forwardRpc!('space.ls', { target: {} })
      if (!isCurrent()) return
      const primary = mobileMoteOwner(discovery, null)
      if (!primary || primary.spaceId === recentMoteSpaceId) {
        return mobileChatStart({ ...discovery, motePresentation: recentCatalog?.motePresentation ?? [] }, recentMoteSpaceId)
      }
      const { catalog } = await client.forwardRpc!('space.ls', { target: { spaceId: primary.spaceId }, presentation: true })
      if (!isCurrent()) return
      const confirmed = mobileMoteOwner(catalog, primary.spaceId, primary)
      return mobileChatStart({ ...catalog, spaces: confirmed ? [confirmed] : [] }, primary.spaceId)
    })().then(target => {
      if (!target || !isCurrent()) return
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
  // The mounted Reader is the sole owner of this exact conversation's metadata.
  const [conversationObservation, setConversationObservation] = useState<MobileConversationStatus | null>(null)
  const conversationScope = useRef({ client: conversationClient, id: workface.selectedSessionId })
  conversationScope.current = { client: conversationClient, id: workface.selectedSessionId }
  const reportConversationStatus = useCallback((value: MobileConversationStatus) => {
    if (conversationScope.current.client !== value.client || conversationScope.current.id !== value.agentSessionId) return
    setConversationObservation(previous => previous === value ? previous : value)
  }, [])
  const conversationStatus = conversationObservation?.client === conversationClient && conversationObservation.agentSessionId === workface.selectedSessionId ? conversationObservation : null
  const selected = conversationStatus?.session ?? undefined
  const conversationStatusLabel = mobileConversationStatusLabel(conversationStatus)
  const conversationStatusMark = conversationStatusLabel ? conversationStatus?.metadata.state === 'retired' && !conversationStatus.connection.issue && conversationStatus.connection.state === 'connected' && !conversationStatus.readingIssue && !conversationStatus.agentIssue ? 'history' : 'issue' : undefined
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
  const retainTopics = initial.current.presentation?.topics !== undefined || topicsRoute.context.categoryId !== null || topicsRoute.context.topicId !== null
    || topicsRoute.context.mode !== 'discussion' || topicsRoute.sources.length > 0
  const presentation: MobilePresentationRoute = { ...current.route, ...(retainTopics ? { topics: topicsRoute } : {}),
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
      void getDeviceWorkface().updatePresentation(workface, JSON.parse(presentationBytes) as MobilePresentationRoute, navigationRecord.current!.recordId).then(() => { savedPresentation.current = presentationBytes }).catch(() => { setNotice('这台设备暂时无法保存导航位置，当前阅读不受影响。') })
    } catch {
      setNotice('这台设备暂时无法保存导航位置，当前阅读不受影响。')
    }
  }, [workface, presentationBytes])

  const restoreNavigationStorage = async () => {
    try {
      const owner = getDeviceWorkface()
      await owner.replaceUnreadableWithCurrent(workface)
      navigationRecord.current = { recordId: owner.recordIdentity() }
      setCanPersist(true)
      setNotice('已用当前工作面替换导航记录，Mac 上的对话不受影响。')
    } catch { setNotice('这台设备仍无法保存导航，可以继续阅读，稍后再试。') }
  }


  const label = connected ? '已连接' : connection.state === 'connecting' ? '连接中' : connection.state === 'disconnected' ? '连接中断' : '尚未连接'
  const primaryHeader = workspaceVisible && current.inlineHeader
  const sessionBackLabel = showGoalWork && workface.panel === 'terminal' ? '返回终端' : showGoalWork || workface.panel === 'terminal' ? '返回对话'
    : moteConversation && threadDetail ? '返回 Threads' : `返回 ${pageName}`
  const menuButton = <button type="button" className="mobile-header-menu mobile-settings-button" onClick={() => setSheet(workspaceVisible ? 'settings' : 'connection')} aria-label={workspaceVisible ? '手机设置与连接' : '连接你的 Mac'}><ThemeActionMenuIcon size={22} /><span className="mobile-status-dot" aria-label={label} /></button>
  const terminalToggle = <IconButton className="mobile-icon-button mobile-session-view-toggle"
    aria-label={workface.panel === 'terminal' && !showGoalWork ? '查看对话' : '查看终端'}
    title={workface.panel === 'terminal' && !showGoalWork ? '查看对话' : '查看终端'}
    onClick={() => { navigationRevision.current += 1; setShowGoalWork(false); setWorkface(value => ({ ...value, panel: value.panel === 'terminal' && !showGoalWork ? 'conversation' : 'terminal' })) }}>
    {workface.panel === 'terminal' && !showGoalWork ? <ThemeObjectConversationIcon size={18} /> : <ThemeObjectTerminalIcon size={18} />}
  </IconButton>

  const exposed = sheet === null
  const rootPage = workspaceVisible && current.root
  const screenMotion = useMobileScreenMotion(current.motionLayer, current.depth, navigationRevision.current)
  // The tab bar animates only when an explicit navigation brings it back; restores and automatic entries do not.
  const tabBar = useRef({ root: rootPage, revision: navigationRevision.current, entering: false })
  if (tabBar.current.root !== rootPage) tabBar.current = { root: rootPage, revision: navigationRevision.current, entering: rootPage && tabBar.current.revision !== navigationRevision.current }
  const layout = useMobileWorkfaceLayout()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [focusTarget, setFocusTarget] = useState<HTMLElement | null>(null)
  const wideShell = layout.split && workspaceVisible
  const wideWorkface = wideShell && current.session
  const focusRoot = workspaceVisible && current.directory === 'focus'
  const moteDirectoryRoot = workspaceVisible && current.directory === 'mote'
  const sidebarShown = wideWorkface && !sidebarCollapsed
  const focusShown = focusRoot || sidebarShown && !moteConversation
  const moteDirectoryShown = moteDirectoryRoot || sidebarShown && moteConversation
  const focusVisible = exposed && focusShown
  const spatialPresented = current.directory === 'mote' || current.directory === 'space' || current.directory === 'focus'
  const directoryVisible = exposed && (spatialPresented || moteDirectoryShown)
  const openFocusSession = useCallback((id: string, identity: MobileObjectIdentity) => {
    setHome('focus'); setSecondary(null); openSession(id, identity)
  }, [openSession])
  const focusSelected = useMemo(() => selected ? { hostId: selected.hostId, agentSessionId: selected.agentSessionId } : null, [selected?.hostId, selected?.agentSessionId])
  const attention = useMobileAttentionCatalog(client, connected && workspaceVisible, directoryVisible || focusVisible || !exposed)
  const needsYou = attention.items
  const needsYouElsewhere = mobileNeedsYouElsewhere(needsYou, current.session ? workface.selectedSessionId : null)
  const threadsVisible = current.threads
  const conversationVisible = workspaceVisible && current.conversation
  const moteTitle = objectIdentity?.mote?.name ?? 'Mote 名称未确认'
  const teamSpaceId = identityRecipient === workface.selectedSessionId ? objectIdentity?.mote?.spaceId ?? null : null
  const moteContent = identityRecipient === workface.selectedSessionId ? objectIdentity?.mote?.contentReference ?? objectIdentity?.mote?.facts?.content : undefined
  const moteTarget = useMemo(() => teamSpaceId && moteContent ? { spaceId: teamSpaceId, zoneId: moteContent.zoneId,
    expectedResource: { hostId: moteContent.hostId, workspaceId: moteContent.workspaceId, workspacePath: moteContent.workspacePath } } : undefined,
  [teamSpaceId, moteContent?.zoneId, moteContent?.hostId, moteContent?.workspaceId, moteContent?.workspacePath])
  const welcomeVisible = Boolean(moteConversation && !moteDirectAgent && (workface.selectedSessionId === null || moteStart?.spaceId === teamSpaceId))
  const historyVisible = Boolean(moteConversation && moteHistory)
  const teamReading = useMobileMoteTeam(client, teamSpaceId, connected,
    workspaceVisible && current.session && (sheet === null || sheet === 'team'))
  const readMoteDialogue = useCallback<MoteDialogueReader>(async input => {
    if (!client?.forwardRpc) throw new Error('连接暂不可用，暂时读不到 Mote 对话。')
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
      setMoteEntryIssue(qualified && fact?.quickMode.status !== 'unconfirmed' ? null : { client: original, spaceId: target.spaceId, message: fact?.quickMode.status === 'unconfirmed' ? fact.quickMode.message : 'Mote 配置来源还没确认，可以刷新重试。' })
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
        ? '这个成员的执行端尚未确认，暂时无法打开；可以刷新团队后重试。'
        : '当前连接尚未匹配这个成员，暂时无法打开；可以刷新团队后重试。'); return
    }
    openSession(id, identity); setShowGoalWork(work); setSheet(null)
  }
  const returnToMoteMain = (original?: MoteDefaultConversation) => {
    const main = original ?? (moteDialogue.page?.main.status === 'ready' && !moteDialogue.unavailable ? moteDialogue.page.main.current : team?.main?.reference)
    const identity = team && main ? mobileMoteMainIdentity(original ? { ...team, main: { reference: original, confirmed: true } } : team)
      : original && objectIdentity?.mote && identityRecipient === workface.selectedSessionId
        ? { name: '主对话', project: objectIdentity.project, mote: objectIdentity.mote } : undefined
    if (!identity || !main) { setNotice('主对话还没确认，可以在团队中刷新或核对主 Agent。'); return }
    let current
    try { current = client?.agentSession(main.sessionId) } catch { /* Keep the saved original target, rather than selecting another Agent. */ }
    if (!current || current.agentSessionId !== main.sessionId || current.hostId !== main.hostId) { setNotice('当前连接尚未匹配主对话，请刷新后重试。'); return }
    openSession(main.sessionId, identity); setMoteDirectAgent(false); setMoteView({ spaceId: identity.mote!.spaceId, section: 'discussion', detail: false }); setSheet(null)
  }
  const workMember = (source: MobileMoteWork) => team?.members.find(member => member.hostId === source.origin.hostId && member.sessionId === source.origin.recipientSessionId)
  const openMoteWork = (source: MobileMoteWork) => {
    const member = workMember(source)
    if (!team || !member || member.places.length !== 1) { setNotice('这项工作的成员或位置还没确认，请在团队中查看。'); return }
    openTeamMember(member.sessionId, mobileMoteMemberIdentity(team, member, member.places[0]), member)
  }
  composeScope.current = { client, sessionId: workface.selectedSessionId, visible: conversationVisible && !welcomeVisible && !historyVisible, focusComposer }
  // Conversation diagnostics live in its fixed action entry, outside the reading layout.
  const serviceNotices = [...new Set([notice, hostAppearance.issue,
    !conversationVisible ? connection.issue ?? (hasConnected && !connected ? connection.message : null) : null
  ].filter((message): message is string => Boolean(message)))]
  // Root pages carry the needs-you count on the tab bar; drilled pages carry it on back.
  const backBadge = !rootPage && (attention.unconfirmed || needsYouElsewhere > 0)
  const headerName = moteConversation && !threadDetail ? moteTitle : sessionTitle ?? selected?.providerId ?? '对话'
  const headerContext = moteConversation && !threadDetail ? null : objectIdentity?.mote ? moteTitle
    : objectIdentity?.project && objectIdentity.project !== headerName ? objectIdentity.project : null
  const sessionHeading = <>
    <MobileIdentity identity={objectIdentity ?? { name: sessionTitle ?? '对话', project: pageName }} session={selected} client={client} connected={connected} size={30} visible={exposed} />
    <span className="mobile-session-heading"><span className="mobile-session-title">{headerName}</span>
      <span className="mobile-session-meta"><span ref={setConversationStatusTarget} className="mobile-session-status" hidden={!conversationVisible || welcomeVisible || historyVisible} />
        {headerContext ? <span className="mobile-session-context">{headerContext}</span> : null}</span></span>
  </>
  // The source reader stays independent of the deferred directory module, including on cold entry.
  const topicSourceActive = Boolean(source && source.kind !== 'topic')
  const topicsPresented = workspaceVisible && current.directory === 'topics'
  const sourcePanes = workfacePanes({ active: exposed && topicsPresented, split: wideShell && topicSourceActive, hasSelection: topicSourceActive })
  const topicsSourceContent = source && source.kind !== 'topic' ? <div className="mobile-topic-source-content">
          {source.kind === 'space' || source.kind === 'survey' ? <>
            <button className="mobile-text-button" onClick={leaveSource}><ThemeNavigationBackIcon size={16} />返回知识</button>
            <MobileZoneWorkface loadWhen={topicsPresented} onLoadReturn={returnToConversation} key={source.zoneId} client={client} zoneId={source.zoneId} name="来源工作面" visible={sourcePanes.content.observed} tabId={source.tabId} regionId={source.regionId} openSession={openSession} />
          </> : source.kind === 'file' || source.kind === 'note' || source.kind === 'notebook' ? <MobileTopicSource loadWhen={topicsPresented} onLoadReturn={returnToConversation} source={source} rpc={rpc} onBack={leaveSource} openHttpLink={openBrowserHttpLink}
            presentation={sourcePanes.content} onBackChange={registerSourceBack}
            {...(sourceReference ? { initialReference: sourceReference } : {})} onReferenceChange={updateSourceReference}
            openScope={scope => { openSource({ kind: 'space', zoneId: scope.zoneId }) }} /> : null}
  </div> : null
  const moteTabsId = useId()
  const moteContext = workspaceVisible && current.session && teamSpaceId && !workPanel ? moteRoot ? 'main' as const : 'member' as const : null
  const spatialRoot = focusRoot || moteDirectoryRoot
  const sidebarLabel = moteConversation ? ' Mote 目录' : '会话列表'
  return <MobileLocalDraftsOwner><MobileHeaderMenuContext.Provider value={menuButton}><MobileAgentMenuContext.Provider value={openAgentMenu}><MobileNoticeScope owner={client} identity={[ getDeviceWorkface().recordIdentity()]}><MobileGoalOperationSafety /><div className="mobile-app" data-wide-shell={wideShell || undefined} data-wide-workface={wideWorkface || undefined} data-short={layout.short || undefined} data-sidebar-collapsed={sidebarCollapsed || undefined} data-focus-root={focusRoot || undefined} data-spatial-root={spatialRoot || undefined} data-connection={connection.state} data-mobile-workface={moteConversation ? 'mote' : 'workspace'} data-page-header={primaryHeader ? 'inline' : 'shell'}>
    <aside ref={setFocusTarget} className="mobile-companion-pane mobile-focus-pane" role={focusRoot ? 'main' : undefined} aria-label="Focus 会话列表" hidden={!focusShown} />
    <aside ref={attachMoteDirectory} className="mobile-companion-pane mobile-mote-pane" role={moteDirectoryRoot ? 'main' : undefined} aria-label="Mote 目录" hidden={!moteDirectoryShown} />
    <div className="mobile-primary-pane">
    {wideWorkface && <button type="button" className="mobile-sidebar-toggle mobile-icon-button" aria-label={`${sidebarCollapsed ? '展开' : '收起'}${sidebarLabel}`} aria-expanded={!sidebarCollapsed} onClick={() => setSidebarCollapsed(value => !value)}>{sidebarCollapsed ? <ThemeOpenSidebarIcon size={18} /> : <ThemeCloseSidebarIcon size={18} />}</button>}
    {!primaryHeader && <header className={`mobile-header${workspaceVisible && current.session ? ' mobile-header--session' : ''}`}>
      {workspaceVisible && current.session ? <div className="mobile-session-toolbar">
        <button type="button" className="mobile-session-origin" data-mobile-back aria-label={sessionBackLabel} title={sessionBackLabel} {...(backBadge ? { 'aria-description': attention.unconfirmed ? '需要你列表尚未确认，可打开 Focus 重新读取' : `另有 ${needsYouElsewhere} 个需要你` } : {})} onClick={requestBack}><ThemeNavigationBackIcon size={20} />{backBadge ? <span className="mobile-back-badge" aria-hidden="true" data-count={attention.unconfirmed ? undefined : needsYouElsewhere} data-unconfirmed={attention.unconfirmed || undefined}>{attention.unconfirmed ? '?' : needsYouElsewhere > 99 ? '99+' : needsYouElsewhere}</span> : null}</button>
        {objectIdentity?.mote ? <button type="button" className="mobile-mote-heading mobile-session-identity" aria-label={`${headerName} · 查看身份与状态`} onClick={() => openProfile(objectIdentity)}>{sessionHeading}</button>
          : <div className="mobile-session-identity">{sessionHeading}</div>}
        <div ref={setConversationToolsTarget} className="mobile-session-tool-slot" hidden={!conversationVisible || welcomeVisible || historyVisible} />
        {workface.selectedSessionId && !welcomeVisible && !historyVisible && terminalToggle}
        {!welcomeVisible && !historyVisible && workface.selectedSessionId ? <IconButton className="mobile-icon-button mobile-session-actions" aria-label="当前对话操作" aria-description={conversationStatusLabel ?? undefined} data-conversation-status={conversationStatusMark} ref={sessionActionsButton} onClick={() => setSheet('actions')}><ThemeActionMoreIcon size={18} /></IconButton> : menuButton}
      </div> : <>
        {menuButton}
        {showSession && objectIdentity?.mote ? <button className="mobile-mote-heading" aria-label={`${objectIdentity.name} · 查看身份与状态`} onClick={() => openProfile(objectIdentity)}><MobileIdentity identity={objectIdentity} session={selected} client={client} connected={connected} size={38} visible={exposed} /></button>
          : workspaceVisible ? <div className="mobile-brand"><BrandIcon icon={hostAppearance.appIcon} className="mobile-brand-icon" size={24} /><span>AgentMux</span></div> : <span />}
        {workspaceVisible && current.session ? <div className="mobile-session-header-actions"><div ref={setConversationToolsTarget} className="mobile-session-tool-slot" hidden={!conversationVisible || welcomeVisible || historyVisible} />{terminalToggle}<IconButton className="mobile-icon-button mobile-session-actions" aria-label="当前对话操作" aria-description={conversationStatusLabel ?? undefined} data-conversation-status={conversationStatusMark} ref={sessionActionsButton} onClick={() => setSheet('actions')}><ThemeActionMoreIcon size={20} /></IconButton></div> : <span className="mobile-header-spacer" />}
      </>}
    </header>}
    {moteContext && teamSpaceId ? <MobileMoteContext tabsId={moteTabsId} variant={moteContext} team={team} issue={teamReading.issue} noticeRef={setMoteNoticeTarget}
      section={moteSection} onDiscussion={() => { setMoteStart(null); setMoteHistory(null); if (workface.selectedSessionId) returnToMoteMain() }}
      onThreads={() => { navigationRevision.current++; setMoteView({ spaceId: teamSpaceId, section: 'threads', detail: false }) }}
      role={moteTarget ? !moteDialogue.unavailable && moteDialogue.page?.main.status === 'ready' && moteDialogue.page.main.current && selected?.hostId
        ? moteDialogue.page.main.current.sessionId === workface.selectedSessionId && moteDialogue.page.main.current.hostId === selected.hostId ? '主 Agent' : '成员'
        : '主角色待核对' : mobileMoteRecipient(team, workface.selectedSessionId, selected?.hostId)}
      onTeam={() => setSheet('team')} onMain={() => returnToMoteMain()}
      showMain={Boolean(team?.main?.confirmed && (team.main.reference.sessionId !== workface.selectedSessionId || team.main.reference.hostId !== selected?.hostId))} /> : null}
    <main ref={mainRef} aria-hidden={spatialRoot || undefined} className="mobile-main" tabIndex={-1} {...(screenMotion ? { 'data-motion': screenMotion.kind, 'data-motion-phase': screenMotion.key % 2 } : {})}>
      {!workspaceVisible && <MobileConnectPage {...(gatewayEndpoint ? { gatewayEndpoint } : {})} connection={connection} appIcon={hostAppearance.appIcon} panel={connectionPanel} onDetails={() => setSheet('connection')} />}
      {workspaceVisible && <>
        <div className="mobile-spatial-host" hidden={!spatialPresented}><MobileSpatialNavigation wide={wideShell} loadingLabel={focusShown ? 'Focus' : home === 'mote' ? 'Mote' : 'Space'} loadWhen={spatialPresented || moteDirectoryShown || focusVisible} focusTarget={focusTarget} moteDirectoryTarget={moteDirectoryTarget} fallbackTarget={focusShown ? focusTarget : moteDirectoryShown ? moteDirectoryTarget : null} focusVisible={focusVisible} focusSelected={focusSelected} openFocusSession={openFocusSession} onLoadReturn={returnToConversation} onCreateAgent={createAgent} visible={directoryVisible} home={home} client={client} connected={connected} openSession={openSession} onPresentation={attention.publish} needsYou={needsYou} openMainAgent={openMainAgent} openProfile={openProfile} onBackChange={registerSpatialBack}
          recentMoteSpaceId={recentMoteSpaceId} onSelectMote={selectMote} onOpenGroups={openGroupDirectory}
          initialContext={spatialContext} onContextChange={updateSpatialContext} openHttpLink={openBrowserHttpLink} /></div>
        <MobileWorkfaceFrame className="mobile-topics-host" presentation={sourcePanes} data-source-active={topicSourceActive || undefined} hidden={!topicsPresented}><MobileWorkfacePane className="mobile-topics-directory-host" pane="navigation" presentation={sourcePanes.navigation}><MobileTopicsSurface wide={wideShell} navigation={topicsNavigation} loadWhen={topicsPresented && sourcePanes.navigation.presented} onLoadReturn={returnToConversation} rpc={rpc} visible={sourcePanes.navigation.observed}
          client={client} connected={connected} openSource={openSource} openHttpLink={openBrowserHttpLink} onBackChange={registerTopicsBack}
          renderWorkface={(topic, visible) => <MobileZoneWorkface loadWhen={visible} onLoadReturn={returnToConversation} key={topic.topicId} client={client} zoneId={topic.zoneId} name={topic.title} visible={visible} onCreateAgent={createAgent}
            {...(source?.kind === 'topic' && source.topicId === topic.topicId ? { tabId: source.chatId, regionId: source.threadId } : {})} openSession={openSession} />} /></MobileWorkfacePane><MobileWorkfacePane className="mobile-source-host" pane="content" presentation={sourcePanes.content}>{topicsSourceContent}</MobileWorkfacePane></MobileWorkfaceFrame>
        <div hidden={current.directory !== 'survey'}><MobileSurveySurface loadWhen={current.directory === 'survey'} onLoadReturn={returnToConversation} client={client} connected={connected} visible={exposed && current.directory === 'survey'} openSession={openSession}
          openTopic={openSurveyTopic} initialContext={surveyContext} onContextChange={updateSurveyContext} onBackChange={registerSurveyBack} openHttpLink={openBrowserHttpLink} /></div>
        <div className="mobile-goals-host" hidden={current.directory !== 'goals'}><MobileGoalsSurface wide={wideShell} loadWhen={current.directory === 'goals'} onLoadReturn={returnToConversation} client={client} connected={connected} visible={exposed && current.directory === 'goals'} openSession={openSession} onBackChange={registerGoalsBack}
          context={goalsContext} onContextChange={updateGoalsContext} copyText={platform.copyText} /></div>
      </>}
      <section className="mobile-goal-panel" hidden={!workspaceVisible || !current.goal}>
        {memberSelection && current.goal && <p role="status">原成员的目标安排能力尚未确认，原对话和草稿保持不变。</p>}<MobileGoalWork loadWhen={!memberSelection && workspaceVisible && current.goal} onLoadReturn={returnToConversation} client={memberSelection ? null : client} agentSessionId={workface.selectedSessionId} connected={connected} visible={exposed && workspaceVisible && current.goal} />
      </section>
      <section className="mobile-mote-threads-panel" hidden={!threadsVisible}
        {...(moteContext === 'main' ? { id: `${moteTabsId}-threads`, role: 'tabpanel', 'aria-labelledby': `${moteTabsId}-threads-tab` } : {})}>
        {teamSpaceId && <button type="button" className="mobile-text-button mobile-mote-groups-entry" onClick={event => openGroups(teamSpaceId, event.currentTarget)}>
          <ThemeObjectConversationIcon size={18} />群聊
        </button>}
        <MobileMoteThreads client={client} dialogue={moteDialogue} team={team} issue={teamReading.issue} visible={exposed && threadsVisible}
          currentSessionId={workface.selectedSessionId} currentHostId={selected?.hostId} onOpen={openTeamMember} onWork={openMoteWork}
          onMain={() => returnToMoteMain()} onConfigure={() => { if (objectIdentity) openProfile(objectIdentity) }}
          onRefresh={() => { teamReading.refresh(); moteDialogue.refresh() }} />
      </section>
      <section className="mobile-conversation-panel" hidden={!conversationVisible}
        {...(moteContext === 'main' ? { id: `${moteTabsId}-discussion`, role: 'tabpanel', 'aria-labelledby': `${moteTabsId}-discussion-tab` } : {})}>
        <MobileMoteComposer client={client} target={moteTarget} platform={platform} enabled={Boolean(moteConversation && !moteDirectAgent && moteTarget)}
          active={exposed && conversationVisible && !historyVisible}
          sourceKey={welcomeVisible ? mobileWelcomeComposerSource(moteStart?.mode ?? 'start')
            : (moteDialogue.page?.main.current ?? team?.main?.reference)?.sessionId === workface.selectedSessionId
              ? mobileSessionComposerSource(workface.selectedSessionId) : 'unconfirmed-main'}>
        {!workface.selectedSessionId && !welcomeVisible && <div className="mobile-chat-start">
          <ThemeObjectConversationIcon size={24} /><h1>继续对话</h1>
          <p>{chatStartIssue ?? '正在找回对话…'}</p>
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
        {historyVisible && moteHistory && <section className="mobile-mote-period-view" aria-label="主对话历史"><button type="button" onClick={() => setMoteHistory(null)}>返回本次对话</button>
          <ClientUiProvider platform={platform}><MotePeriodConversation source={moteHistory} client={client} visible={exposed && conversationVisible}
            name={moteTitle} onOpenOriginal={() => {
              let original
              try { original = client?.agentSession(moteHistory.reference.sessionId) } catch { /* A missing observation preserves this exact history reference. */ }
              if (!original || original.hostId !== moteHistory.reference.hostId) { setNotice('这段历史对应的 Mac 或 Agent 还没匹配上，暂时无法打开。'); return }
              openSession(moteHistory.reference.sessionId, objectIdentity!)
            }} /></ClientUiProvider></section>}
        {!welcomeVisible && !historyVisible && moteConversation && !moteDirectAgent && moteTarget && objectIdentity && <MobileMoteStartRecovery client={client} target={moteTarget} visible={exposed && conversationVisible}
          onConfigure={() => openProfile(objectIdentity)} onBound={() => { teamReading.refresh(); moteDialogue.refresh() }} onOpenMain={reference => openMainAgent(reference.sessionId, objectIdentity, reference.hostId)} />}
        <div hidden={welcomeVisible || historyVisible} className={`mobile-conversation-slot${workface.selectedSessionId ? ' is-active' : ''}`}>

          {workface.selectedSessionId && <MobileConversationSurface client={conversationClient} draftScope={memberSelection ? mobileMemberDraftScope(memberSelection, workface.selectedSessionId, objectIdentity?.context) : undefined} memberIssue={memberSelection ? member.issue : undefined} onRetryMember={member.issue ? member.retry : undefined} attachmentOwner={attachmentOwner} agentSessionId={workface.selectedSessionId} onStatusChange={reportConversationStatus} moteMemberName={moteMemberName} moteTarget={moteTarget} moteDialogue={moteDialogue} moteDirectAgent={moteConversation ? moteDirectAgent : undefined} moteName={moteTitle} moteAppearance={team?.appearance ?? objectIdentity?.mote?.appearance}
            moteWorkMemberName={source => workMember(source)?.name ?? source.origin.recipientSessionId} onOpenMoteWork={openMoteWork} onReturnMoteMain={returnToMoteMain}
            onMoteRolloverRequired={query => { if (teamSpaceId && moteTarget && !moteDirectAgent) { navigationRevision.current++; setMoteHistory(null); setMoteStart({ spaceId: teamSpaceId, mode: 'new', automatic: query }) } }}
            onShowMoteThreads={() => { if (teamSpaceId) { navigationRevision.current++; setMoteView({ spaceId: teamSpaceId, section: 'threads', detail: false }) } }}
            moteConfigurationIssue={moteEntryIssue?.client === client && moteEntryIssue.spaceId === teamSpaceId ? moteEntryIssue.message : null} onRefreshMoteConfiguration={() => { void refreshMoteConfiguration() }}
            moteSource={mobileMoteInputSource(objectIdentity, workface.selectedSessionId, identityRecipient)} connection={connection} platform={platform} toolbarTarget={conversationToolsTarget} statusTarget={conversationStatusTarget} noticeTarget={moteNoticeTarget} {...(sessionTitle ? { displayName: sessionTitle } : {})} visible={exposed && conversationVisible && !welcomeVisible && !historyVisible} onShowTerminal={() => { navigationRevision.current++; setWorkface(value => ({ ...value, panel: 'terminal' })) }}
            onShowGoals={showConversationGoals} openHttpLink={openBrowserHttpLink} />}
        </div>
        </MobileMoteComposer>
      </section><section className="mobile-terminal-panel" hidden={!workspaceVisible || !current.terminal}>
        <MobileTerminalViewer loadWhen={workspaceVisible && current.terminal} onLoadReturn={returnToConversation} terminalPalette={hostAppearance.terminalPalette} client={hasMobileTerminal(conversationClient) ? conversationClient : null} agentSessionId={workface.selectedSessionId} connection={connection} platform={platform} {...(sessionTitle ? { displayName: sessionTitle } : {})} inputActive={exposed} visible={workspaceVisible && current.terminal} />
        {memberSelection && !hasMobileTerminal(conversationClient) && current.terminal && <p role="status">原成员的终端能力尚未确认；原对话和草稿仍保留。</p>}
      </section>
    </main>
    <div className="mobile-notice-stack">
      {webObservation && <MobileNotice owner={client} hidden={mobileWebUpdateStatus(webObservation) !== 'available'}
        identity={[webObservation.inspection.result?.hostInstanceId, webObservation.inspection.result?.active?.digest]} className="mobile-web-update-notice" kind="feedback">
        <span>网页有新版本</span><button type="button" onClick={() => setSheet('settings')}>前往更新</button>
      </MobileNotice>}
      {!directoryVisible && !focusVisible && attention.issue && <MobileAttentionNotice owner={client} issue={attention.issue} retry={attention.refresh} />}
      {!primaryHeader && !focusVisible && !moteDirectoryShown && <MobileAvatarNoticeOutlet />}
      {(serviceNotices.length > 0 || !canPersist) && <MobileNotice owner={client} kind="feedback" identity={[notice,noticeDetail,hostAppearance.issue,connection.issue,connection.state,canPersist]} className="mobile-service-notice"><span className="mobile-notice-mark"><ThemeStatusInfoIcon size={15} /></span><div>{serviceNotices.map(message => <p key={message}>{message}</p>)}{notice && noticeDetail && <details><summary>技术信息</summary><p>{noticeDetail}</p></details>}{!canPersist && <button onClick={restoreNavigationStorage}>用当前工作面替换记录</button>}</div></MobileNotice>}
    </div>
    {rootPage && <footer className="mobile-navigation-bar" {...(tabBar.current.entering ? { 'data-motion': 'enter' } : {})}><MobilePrimaryNavigation current={primary === 'survey' ? null : primary} onSelect={openPrimaryWorkface} needsYou={needsYou.length} needsYouUnconfirmed={attention.unconfirmed} /></footer>}
    </div>
    <MobileAgentCreate client={client} connected={connected} visible={sheet === 'create'} target={createTarget} platform={platform} onClose={() => setSheet(null)} openSession={id => openSession(id, { name: 'Agent', project: '项目未确认' })} />
    <Dialog.Root open={sheet !== null && sheet !== 'create'} onOpenChange={open => { if (!open) setSheet(null) }}>
      <Dialog.Portal container={platform.overlayContainer()}><Dialog.Overlay className={sheet === 'settings' ? 'mobile-drawer-backdrop' : `mobile-sheet-backdrop${positionOverlay ? ' mobile-sheet-backdrop--underlay' : ''}`} /><Dialog.Content className={sheet === 'settings' ? 'mobile-drawer' : `mobile-sheet${sheet === 'agent' || sheet === 'actions' ? ' mobile-sheet--agent' : sheet === 'groups' ? ' mobile-sheet--mote-groups' : ''}${positionOverlay ? ' mobile-sheet--underlay' : ''}`} aria-describedby="mobile-sheet-description" onCloseAutoFocus={event => {
        const trigger = groupTrigger.current
        if (trigger) {
          groupTrigger.current = null
          if (trigger.isConnected && !trigger.closest('[hidden], [inert]')) {
            event.preventDefault()
            trigger.focus({ preventScroll: true })
          }
          return
        }
        const original = composeAfterClose.current
        if (!original) return
        composeAfterClose.current = null
        event.preventDefault()
        const current = composeScope.current
        if (current.client !== original.client || current.sessionId !== original.sessionId || !current.visible) {
          setNotice('已切换到其他位置，未聚焦输入区。')
          return
        }
        if (!current.focusComposer()) setNotice('输入区暂时未准备好，请稍后再试。')
      }}>
        <MobileSheetHeader onClose={() => setSheet(null)} title={sheet === 'groups' ? '群聊' : sheet === 'team' ? `${team?.name ?? moteTitle} · 团队` : sheet === 'agent' ? menuTarget?.identity.name ?? 'Agent' : sheet === 'notices' ? '提醒与诊断' : sheet === 'identity' ? profileIdentity?.mote ? profileIdentity.mote.name ?? 'Mote 名称未确认' : profileIdentity?.name ?? 'Mote' : sheet === 'actions' ? '当前对话' : sheet === 'settings' ? 'AgentMux' : workspaceVisible ? '连接与设备' : '连接你的 Mac'} closeLabel="关闭面板" />
        {sheet === 'groups' ? <>
          <Dialog.Description id="mobile-sheet-description" className="mobile-mote-groups-description">{groupMoteId ? '查看这个 Mote 参与的群聊' : '打开或创建群聊'}</Dialog.Description>
          <ClientUiProvider platform={platform}><MobileMoteGroups client={client} connected={connected} positions={groupReadingPositions} openHttpLink={openBrowserHttpLink} onBackChange={registerGroupBack} {...(groupMoteId ? { moteId: groupMoteId } : {})} /></ClientUiProvider>
        </> : sheet === 'team' ? <>
          <Dialog.Description id="mobile-sheet-description">团队的当前工作与请求</Dialog.Description>
          <MobileMoteTeamPanel team={team} issue={teamReading.issue} currentSessionId={workface.selectedSessionId} currentHostId={selected?.hostId}
            onRefresh={() => { teamReading.refresh(); moteDialogue.refresh() }} onOpen={openTeamMember} onMain={() => returnToMoteMain()}
            onWork={(id, identity, member) => openTeamMember(id, identity, member, true)}
            onConfigure={() => { if (objectIdentity) openProfile(objectIdentity) }} />
        </> : sheet === 'settings' ? <>
          <Dialog.Description id="mobile-sheet-description">工作面与手机设置</Dialog.Description>
          <MobileDrawerConnection connection={connection} label={label} appIcon={hostAppearance.appIcon} address={location.host} onOpen={() => setSheet('connection')} />
          <nav className="mobile-drawer-workfaces" aria-label="其他工作面">
            <button className="mobile-menu-row" aria-current={secondary === 'survey' ? 'page' : undefined} onClick={() => { navigationRevision.current += 1; setSecondary('survey'); setShowSession(false); setSheet(null) }}><ThemeNavigationSurveyIcon size={20} /><span>Survey<small>研究与笔记</small></span></button>
          </nav>
          <div className="mobile-drawer-settings">
          <label className="mobile-home-select">默认目录<select aria-label="退出对话后的默认目录" value={defaultHome} onChange={event => {
            const value = event.target.value as MobilePrimaryWorkface
            try { saveMobileHome(value); setDefaultHome(value); setHomeIssue(null) }
            catch { setHomeIssue('默认主页未保存，请重试。') }
          }}><option value="goals">Goals</option><option value="topics">Topics</option><option value="mote">Mote</option><option value="focus">Focus</option><option value="space">Space</option></select></label>
          {homeIssue && <MobileNotice identity={[homeIssue]} className="mobile-spatial-notice">{homeIssue}</MobileNotice>}
          {webObservation && <MobileWebUpdateSettings observation={webObservation} />}
          <button className="mobile-menu-row" aria-label="提醒与诊断" onClick={() => setSheet('notices')}><ThemeStatusInfoIcon size={18} /><span>提醒与诊断<small>{notices?.hasDismissed ? '有已收起的提醒' : '收起或恢复提醒'}</small></span><ThemeNavigationSubmenuIcon size={16} /></button></div>
        </> : sheet === 'notices' ? <>
          <Dialog.Description id="mobile-sheet-description">本设备的提醒呈现</Dialog.Description>
          {webObservation && <MobileWebDiagnostics observation={webObservation} copyText={platform.copyText} />}
          {conversationStatus && <><MobileConversationStatusDetails status={conversationStatus} onConnection={() => setSheet('connection')} /><button type="button" className="mobile-text-button" onClick={returnToConversation}>返回这段对话</button></>}
          <MobileGoalOperationRecovery copyText={platform.copyText} />
          <MobileNoticeRestore onRestored={() => setSheet(null)} />
        </> : sheet === 'identity' && profileIdentity ? <>
          <Dialog.Description id="mobile-sheet-description">资料与当前工作</Dialog.Description>
          <MobileMoteProfile loadWhen={sheet === 'identity'} loadingReturn={false} onLoadReturn={requestBack} identity={profileIdentity} client={client} onOpenMain={() => { setSheet(null); void enterMote(profileIdentity?.mote?.spaceId ?? null) }} copyText={platform.copyText} visible={sheet === 'identity'} sourcePath={profileSourcePath} onSourceChange={setProfileSourcePath} onBackChange={registerProfileBack} onOpenGoals={id => {
            openSession(id, profileIdentity); setShowGoalWork(true); setSheet(null)
          }} />
        </> : sheet === 'agent' && menuTarget ? <>
          <Dialog.Description id="mobile-sheet-description">{menuTarget.identity.project}</Dialog.Description>
          {menuIssue && <MobileNotice owner={client} identity={[menuTarget.agentSessionId, menuIssue]} role="status">{menuIssue}</MobileNotice>}
          {menuTarget.location && <MobileAgentLocations client={client} catalog={menuTarget.location.catalog} locations={menuTarget.location.group} agentSessionId={menuTarget.agentSessionId} name={menuTarget.identity.name} visible={sheet === 'agent'} open={positionOverlay} onOpenChange={setPositionOverlay}
            beforeChoose={() => validateMenuSource() && (menuTarget.location?.current?.() ?? false)} onChoose={choice => { menuTarget.location?.onChoose(choice); setSheet(null) }} />}
          <MobileAgentActions key={menuTarget.agentSessionId} client={menuMember.client} agentSessionId={menuTarget.agentSessionId} connected={connected} copyText={platform.copyText} beforeAction={validateMenuSource} statusSource={menuTarget} />
          <button className="mobile-menu-row" onClick={() => { if (validateMenuSource()) { openSession(menuTarget.agentSessionId, menuTarget.identity); setSheet(null) } }}><ThemeObjectConversationIcon size={18} /><span>打开对话</span></button>
        </> : sheet === 'actions' ? <>
          {moteConversation && !moteDirectAgent && moteDialogue.page?.main.status === 'ready' && moteDialogue.page.main.current && <button type="button" className="mobile-menu-row" aria-label="新一轮" onClick={beginMoteRound}><ThemeObjectConversationIcon size={20} /><span>新一轮<small>旧对话保留，继续同一个 Mote</small></span></button>}
          <Dialog.Description id="mobile-sheet-description">{sessionTitle ?? 'Agent'} · {objectIdentity?.project ?? '项目未确认'}</Dialog.Description>
          {conversationStatus && <MobileConversationStatusDetails status={conversationStatus} onConnection={() => setSheet('connection')} />}
          {workface.selectedSessionId && <button type="button" className="mobile-menu-row mobile-goal-menu-entry" aria-label="目标与结果" onClick={event => { showConversationGoals(sessionActionsButton.current ?? event.currentTarget); setSheet(null) }}><ThemeObjectGoalIcon size={18} /><span>目标与结果</span></button>}
          {native && selected && !showGoalWork && workface.panel !== 'terminal' && <button className="mobile-menu-row" aria-label="撰写消息" onClick={() => { composeAfterClose.current = { client, sessionId: selected.agentSessionId }; setSheet(null) }}><ThemeActionComposeIcon size={17} /><span>撰写消息</span></button>}
          {workface.selectedSessionId && <MobileAgentActions client={conversationClient} agentSessionId={workface.selectedSessionId} connected={connected} copyText={platform.copyText} />}
          <button type="button" className="mobile-menu-row mobile-sheet-app-menu" aria-label="手机设置、提醒与诊断" onClick={() => setSheet('settings')}><ThemeActionMenuIcon size={18} /><span>手机设置、提醒与诊断<small>{label}{notices?.hasDismissed ? ' · 有已收起的提醒' : ''}</small></span><ThemeNavigationSubmenuIcon size={16} /></button>
        </> : <>
          <Dialog.Description id="mobile-sheet-description">连接同一私网里的 Mac。Agent 与会话由 Mac 管理。</Dialog.Description>
          <p>{gatewayEndpoint ? '网关：' + gatewayEndpoint : 'Mac：' + location.origin} · {label}</p>
          <p className="mobile-sheet-note">Mac 保持在线即可继续使用对话。</p>
          {connectionPanel}
          <MobileRecoveryPanel {...(native ? { exportFile: exportNativeWorkfaceFile } : {})} />
          <button className="mobile-menu-row" aria-label="提醒与诊断" onClick={() => setSheet('notices')}><ThemeStatusInfoIcon size={18} /><span>提醒与诊断</span><ThemeNavigationSubmenuIcon size={16} /></button>
          <p className="mobile-sheet-note">连接会自动恢复。{connection.message}</p>
        </>}
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </div></MobileNoticeScope></MobileAgentMenuContext.Provider></MobileHeaderMenuContext.Provider></MobileLocalDraftsOwner>
}
