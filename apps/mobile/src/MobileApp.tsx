import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ChevronRight, Link2, MessageSquare, MoreHorizontal, Pencil, ShieldCheck, ArrowLeft, Menu, SquareTerminal, Wifi, X, Compass, Target } from 'lucide-react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { TopicKnowledgeSource } from '@agentmux/core/control'
import { MobileTopicSource } from './topics/MobileTopicSource'
import { MobileTopicsSurface } from './topics/MobileTopicsSurface'
import { MobileSurveySurface } from './survey/MobileSurveySurface'
import { MobileGoalsSurface } from './goals/MobileGoalsSurface'
import { MobileZoneWorkface } from './navigation/MobileZoneWorkface'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import { MobileConversationSurface, type MobileConnection } from './conversation/MobileConversationSurface'
import { MobileTerminalViewer } from './terminal/MobileTerminalViewer'
import { bindMobileViewport, bindNativeDevice } from './platform/native/device'
import { openBrowserHttpLink } from './platform/browser'
import './mobile.css'
import { getDeviceWorkface, type Navigation } from './recovery/device-workface'
import { MobileRecoveryPanel } from './recovery/MobileRecoveryPanel'
import { exportNativeWorkfaceFile } from './platform/native/workface-file'

import brandIcon from './assets/dragon.png'
import { MobileIdentity, type MobileObjectIdentity } from './navigation/MobileIdentity'
import { MobilePrimaryNavigation } from './navigation/MobilePrimaryNavigation'
import { MobileSpatialNavigation } from './navigation/MobileSpatialNavigation'
import { readMobileHome, saveMobileHome, type MobileHome, type MobilePrimaryWorkface } from './navigation/home-preference'
import { MobileGoalWork } from './navigation/MobileGoalWork'
import { MobileMoteProfile } from './navigation/MobileMoteProfile'
import { useMobileBack } from './navigation/useMobileBack'
import { retainObjectReference, type MobilePresentationRoute } from './recovery/presentation-route'

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

export function MobileApp({ client, connection, platform, native = false, focusComposer = () => false,
  connectionPanel }: {
  client: AgentMuxHostedClient | null; connection: MobileConnection; platform: ClientUiPlatform
  native?: boolean; focusComposer?: () => boolean
  connectionPanel?: ReactNode
}) {
  const initial = useRef<ReturnType<typeof loadWorkface> | null>(null)
  initial.current ??= loadWorkface()
  const [hasConnected, setHasConnected] = useState(connection.state === 'connected' || initial.current.workface.selectedSessionId !== null || initial.current.presentation !== undefined)
  useEffect(() => { if (connection.state === 'connected') setHasConnected(true) }, [connection.state])
  const [workface, setWorkface] = useState<Workface>(initial.current.workface)
  const [canPersist, setCanPersist] = useState(initial.current.issue === null)
  const initialHome = useRef(readMobileHome())
  const initialPrimary = initial.current.presentation?.primary ?? initialHome.current.home
  const [home, setHome] = useState<MobileHome>(initialPrimary === 'mote' || initialPrimary === 'space' ? initialPrimary : 'focus')
  const [defaultHome, setDefaultHome] = useState<MobilePrimaryWorkface>(initialHome.current.home)
  const [homeIssue, setHomeIssue] = useState(initialHome.current.issue)
  const [secondary, setSecondary] = useState<'topics' | 'survey' | 'goals' | null>(initialPrimary === 'goals' || initialPrimary === 'topics' || initialPrimary === 'survey' ? initialPrimary : null)
  const [topicId, setTopicId] = useState<string | null>(null)
  const [source, setSource] = useState<TopicKnowledgeSource | null>(null)
  const pageName = secondary === 'topics' ? 'Topics' : secondary === 'survey' ? 'Survey' : secondary === 'goals' ? 'Goals' : home === 'mote' ? 'Mote' : home === 'space' ? 'Space' : 'Focus'
  const rpc = useCallback<NonNullable<AgentMuxHostedClient['forwardRpc']>>((method, params) => {
    if (!client?.forwardRpc) return Promise.reject(new Error('连接暂不可用，原工作面保留。'))
    return client.forwardRpc(method, params)
  }, [client])
  const [showSession, setShowSession] = useState(initial.current.presentation?.showSession ?? (initial.current.workface.selectedSessionId !== null && initial.current.workface.panel !== 'sessions'))
  const [showGoalWork, setShowGoalWork] = useState(initial.current.presentation?.showGoalWork ?? false)
  const [objectIdentity, setObjectIdentity] = useState<MobileObjectIdentity | null>(initial.current.presentation?.identity ?? null)
  const [profileIdentity, setProfileIdentity] = useState<MobileObjectIdentity | null>(initial.current.presentation?.profile?.identity ?? null)
  const [profileSourcePath, setProfileSourcePath] = useState<string | null>(initial.current.presentation?.profile?.sourcePath ?? null)
  const navigationRevision = useRef(0)
  const openSession = (id: string, identity: MobileObjectIdentity) => {
    navigationRevision.current += 1
    setObjectIdentity(identity); setShowGoalWork(false)
    setWorkface(value => ({ ...value, selectedSessionId: id, panel: 'conversation' }))
    setShowSession(true)
  }
  const openSource = (value: TopicKnowledgeSource) => {
    navigationRevision.current += 1
    if (value.kind === 'url') { openBrowserHttpLink(value.url); return }
    if (value.kind === 'topic') { setTopicId(value.topicId); setSecondary('topics') }
    setSource(value)
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
      if (topic) { setTopicId(topic); setSource(null); setSecondary('topics') }
      else setNotice('原 Topic 身份尚未确认，研究与资料保留。')
    }).catch(error => setNotice(error instanceof Error ? error.message : String(error)))
  }
  const sessionTitle = objectIdentity?.name ?? null
  const [sheet, setSheet] = useState<'connection' | 'settings' | 'identity' | 'actions' | null>(initial.current.presentation?.profile ? 'identity' : null)
  const openProfile = (identity: MobileObjectIdentity) => {
    navigationRevision.current += 1
    setProfileIdentity(identity); setProfileSourcePath(null); setSheet('identity')
  }
  const [profileBack, setProfileBack] = useState<(() => void) | null>(null)
  const [spatialBack, setSpatialBack] = useState<(() => void) | null>(null)
  const [topicsBack, setTopicsBack] = useState<(() => void) | null>(null)
  const [goalsBack, setGoalsBack] = useState<(() => void) | null>(null)
  const registerProfileBack = useCallback((back: (() => void) | null) => setProfileBack(() => back), [])
  const registerSpatialBack = useCallback((back: (() => void) | null) => setSpatialBack(() => back), [])
  const registerTopicsBack = useCallback((back: (() => void) | null) => setTopicsBack(() => back), [])
  const registerGoalsBack = useCallback((back: (() => void) | null) => setGoalsBack(() => back), [])
  const familyBack = secondary === 'topics' ? topicsBack : secondary === 'goals' ? goalsBack : secondary === null ? spatialBack : null
  const hasBack = sheet !== null || showSession || source !== null || familyBack !== null
  const requestBack = useMobileBack(hasBack, () => {
    navigationRevision.current += 1
    if (sheet !== null) {
      if (sheet === 'identity' && profileBack) profileBack()
      else setSheet(null)
    } else if (showSession) {
      if (showGoalWork) setShowGoalWork(false)
      else if (workface.panel === 'terminal') setWorkface(value => ({ ...value, panel: 'conversation' }))
      else setShowSession(false)
    } else if (source) setSource(null)
    else familyBack?.()
  })
  const backRef = useRef(requestBack)
  backRef.current = requestBack
  const [notice, setNotice] = useState<string | null>(initial.current.issue)
  const [, setRevision] = useState(0)
  let sessions: ReturnType<AgentMuxHostedClient['agentSessions']> = [], projectionError: string | null = null
  try { sessions = client?.agentSessions() ?? [] }
  catch { projectionError = 'Host 会话目录尚未核实。原会话引用与草稿仍保留；请恢复原 Mac 的连接。' }
  const selected = sessions.find(value => value.agentSessionId === workface.selectedSessionId)
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
    if (event.type === 'agent-session' || event.type === 'run-removed' || event.type === 'connection-state') {
      setRevision(value => value + 1)
    }
    // Keep the local reading reference, including after retirement. The original Core determines
    // whether its history remains readable; unknown/old-Run events cannot erase a saved workface.
  }), [client])
  const presentation: MobilePresentationRoute = { primary: secondary ?? home, showSession, showGoalWork,
    identity: retainObjectReference(objectIdentity), profile: sheet === 'identity' && profileIdentity
      ? { identity: retainObjectReference(profileIdentity)!, sourcePath: profileSourcePath } : null }
  const presentationBytes = JSON.stringify(presentation)
  const savedPresentation = useRef(JSON.stringify(initial.current.presentation ?? presentation))
  useEffect(() => {
    if (workface === initial.current?.workface && savedPresentation.current === presentationBytes) return
    try {
      void getDeviceWorkface().updatePresentation(workface, JSON.parse(presentationBytes) as MobilePresentationRoute).then(() => { savedPresentation.current = presentationBytes }).catch(() => { setNotice('这台设备暂时无法保存导航位置。地址与导航仅临时采用；当前阅读和 Mac 上的原会话仍保留，原存储记录尚未覆盖。') })
    } catch {
      setNotice('这台设备暂时无法保存导航位置。地址与导航仅临时采用；当前阅读和 Mac 上的原会话仍保留，原存储记录尚未覆盖。')
    }
  }, [workface, presentationBytes])

  const restoreNavigationStorage = async () => {
    try {
      const owner = getDeviceWorkface()
      await owner.replaceUnreadableWithCurrent(workface)
      setCanPersist(true)
      setNotice('已用当前工作面替换这台设备无法读取的原记录。导航、草稿和未确认输入一起保存；Mac 上的原会话保持不变。')
    } catch { setNotice('这台设备仍无法保存导航。原记录尚未覆盖；当前仍按临时导航继续阅读。') }
  }


  const connected = connection.state === 'connected'
  const workspaceVisible = connected || hasConnected
  const label = connected ? '已连接' : connection.state === 'connecting' ? '连接中' : connection.state === 'disconnected' ? '连接中断' : '尚未连接'

  const exposed = sheet === null
  const moteConversation = showSession && objectIdentity?.mote && home === 'mote' && secondary === null
  return <div className="mobile-app" data-connection={connection.state} data-drawer={sheet === 'settings' ? 'open' : 'closed'} data-mobile-workface={moteConversation ? 'mote' : 'workspace'}>
    <header className="mobile-header">
      <button className="mobile-settings-button" onClick={() => setSheet(workspaceVisible ? 'settings' : 'connection')} aria-label={workspaceVisible ? '手机设置与连接' : '连接你的 Mac'}><Menu size={18} /><span className="mobile-status-dot" aria-label={label} /></button>
      {showSession && objectIdentity?.mote ? <button className="mobile-mote-heading" aria-label={`${objectIdentity.name} · 查看身份与状态`} onClick={() => openProfile(objectIdentity)}><MobileIdentity identity={objectIdentity} session={selected} client={client} connected={connected} size={38} visible={exposed} /></button>
        : <div className="mobile-brand"><img className="mobile-brand-icon" src={brandIcon} width={24} height={24} alt="" /><span>AgentMux</span></div>}
      {showSession && objectIdentity?.mote ? <button className="mobile-icon-button" aria-label="当前对话操作" onClick={() => setSheet('actions')}><MoreHorizontal size={20} /></button> : <span className="mobile-header-spacer" />}
    </header>
    {workspaceVisible && showSession && <div className="mobile-session-toolbar">
      <button className="mobile-text-button" onClick={() => setShowSession(false)}><ArrowLeft size={16} />{pageName}</button>
      <span>{sessionTitle ?? selected?.providerId ?? '原会话'}</span>
      <button className="mobile-icon-button" aria-label={showGoalWork ? '返回原对话' : '目标与结果'} aria-pressed={showGoalWork} onClick={() => setShowGoalWork(value => !value)}><Target size={18} /></button>
      {!objectIdentity?.mote && <button className="mobile-icon-button" aria-label={workface.panel === 'terminal' ? '查看对话' : '查看终端'} onClick={() => { setShowGoalWork(false); setWorkface(value => ({ ...value, panel: value.panel === 'terminal' ? 'conversation' : 'terminal' })) }}>{workface.panel === 'terminal' ? <MessageSquare size={18} /> : <SquareTerminal size={18} />}</button>}
      {native && selected && !showGoalWork && workface.panel !== 'terminal' && <button className="mobile-icon-button" aria-label="撰写消息" onClick={() => { if (!focusComposer()) setNotice('输入区暂时未准备好。原草稿保留。') }}><Pencil size={17} /></button>}
    </div>}
    <main className="mobile-main">
      {!workspaceVisible && <section className="mobile-connect-page"><img className="mobile-connect-dragon" src={brandIcon} alt="AgentMux 龙" /><h1>连接你的 Mac</h1>
        <p>在 Mac 的 Phone &amp; Devices 中复制连接链接，用手机打开。两台设备连接同一 Wi-Fi。</p>
        <p className="mobile-spatial-notice" role="status">{connection.message}</p>{connectionPanel}
        <button className="mobile-secondary" onClick={() => setSheet('connection')}><Link2 size={16} />连接详情</button>
      </section>}
      {workspaceVisible && <>
        <div hidden={showSession || secondary !== null}><MobileSpatialNavigation visible={exposed && !showSession && secondary === null} home={home} client={client} connected={connected} sessions={sessions} openSession={openSession} openProfile={openProfile} onBackChange={registerSpatialBack} /></div>
        <div hidden={showSession || secondary !== 'topics' || Boolean(source && source.kind !== 'topic')}><MobileTopicsSurface rpc={rpc} visible={exposed && !showSession && secondary === 'topics' && (!source || source.kind === 'topic')} topicId={topicId}
          onOpenTopic={topic => { setTopicId(topic.topicId); if (source?.kind === 'topic' && source.topicId !== topic.topicId) setSource(null) }} openSource={openSource} openHttpLink={openBrowserHttpLink} onBackChange={registerTopicsBack}
          renderWorkface={(topic, visible) => <MobileZoneWorkface key={topic.topicId} client={client} zoneId={topic.zoneId} name={topic.title} visible={visible}
            {...(source?.kind === 'topic' && source.topicId === topic.topicId ? { tabId: source.chatId, regionId: source.threadId } : {})} openSession={openSession} />} /></div>
        <div hidden={showSession || secondary !== 'survey'}><MobileSurveySurface client={client} connected={connected} visible={exposed && !showSession && secondary === 'survey'} openSession={openSession}
          openTopic={openSurveyTopic} /></div>
        {source && source.kind !== 'topic' && <div hidden={showSession || secondary !== 'topics'}>
          {source.kind === 'space' || source.kind === 'survey' ? <>
            <button className="mobile-text-button" onClick={() => setSource(null)}><ArrowLeft size={16} />返回知识</button>
            <MobileZoneWorkface key={source.zoneId} client={client} zoneId={source.zoneId} name="来源工作面" visible={exposed && !showSession && secondary === 'topics'} tabId={source.tabId} regionId={source.regionId} openSession={openSession} />
          </> : source.kind === 'file' || source.kind === 'note' || source.kind === 'notebook' ? <MobileTopicSource source={source} rpc={rpc} onBack={() => setSource(null)} openHttpLink={openBrowserHttpLink}
            openScope={scope => { setSource({ kind: 'space', zoneId: scope.zoneId }) }} /> : null}
        </div>}
        <div hidden={showSession || secondary !== 'goals'}><MobileGoalsSurface client={client} connected={connected} visible={exposed && !showSession && secondary === 'goals'} openSession={openSession} onBackChange={registerGoalsBack} /></div>
      </>}
      <section className="mobile-goal-panel" hidden={!workspaceVisible || !showSession || !showGoalWork}>
        <MobileGoalWork client={client} agentSessionId={workface.selectedSessionId} connected={connected} visible={exposed && workspaceVisible && showSession && showGoalWork} />
      </section>
      <section className="mobile-conversation-panel" hidden={!workspaceVisible || !showSession || showGoalWork || workface.panel === 'terminal'}>
        {!workface.selectedSessionId && <p className="mobile-spatial-empty">从 {pageName} 选择已有 Agent。</p>}
        <div className={`mobile-conversation-slot${workface.selectedSessionId ? ' is-active' : ''}`}>
          <MobileConversationSurface client={client} agentSessionId={workface.selectedSessionId} connection={connection} platform={platform} {...(sessionTitle ? { displayName: sessionTitle } : {})} visible={exposed && workspaceVisible && showSession && !showGoalWork && workface.panel !== 'terminal'} onShowTerminal={() => setWorkface(value => ({ ...value, panel: 'terminal' }))} openHttpLink={openBrowserHttpLink} />
        </div>
      </section><section className="mobile-terminal-panel" hidden={!workspaceVisible || !showSession || showGoalWork || workface.panel !== 'terminal'}>
        <MobileTerminalViewer client={client} agentSessionId={workface.selectedSessionId} connection={connection} platform={platform} {...(sessionTitle ? { displayName: sessionTitle } : {})} visible={exposed && workspaceVisible && showSession && !showGoalWork && workface.panel === 'terminal'} />
      </section>
    </main>
    {(notice || projectionError || connection.issue || hasConnected && !connected || !canPersist) && <aside className="mobile-service-notice" role="status"><span className="mobile-notice-mark"><ShieldCheck size={15} /></span><div><p>{notice ?? projectionError ?? connection.issue ?? connection.message}</p>{!canPersist && <button onClick={restoreNavigationStorage}>用当前工作面替换原记录</button>}</div></aside>}
    {workspaceVisible && <MobilePrimaryNavigation current={secondary === 'survey' ? null : secondary ?? home} onSelect={openPrimaryWorkface} />}
    <Dialog.Root open={sheet !== null} onOpenChange={open => { if (!open) setSheet(null) }}>
      <Dialog.Portal container={platform.overlayContainer()}><Dialog.Overlay className={sheet === 'settings' ? 'mobile-drawer-backdrop' : 'mobile-sheet-backdrop'} /><Dialog.Content className={sheet === 'settings' ? 'mobile-drawer' : 'mobile-sheet'} aria-describedby="mobile-sheet-description">
        <div className="mobile-sheet-handle" /><div className="mobile-sheet-title"><Dialog.Title>{sheet === 'identity' ? profileIdentity?.name ?? 'Mote' : sheet === 'actions' ? '当前对话' : sheet === 'settings' ? 'AgentMux' : '连接你的 Mac'}</Dialog.Title><Dialog.Close className="mobile-icon-button" aria-label="关闭面板"><X size={19} /></Dialog.Close></div>
        {sheet === 'settings' ? <>
          <Dialog.Description id="mobile-sheet-description">工作面与手机设置</Dialog.Description>

          <nav className="mobile-drawer-workfaces" aria-label="其他工作面">
            <button className="mobile-menu-row" aria-current={secondary === 'survey' ? 'page' : undefined} onClick={() => { navigationRevision.current += 1; setSecondary('survey'); setShowSession(false); setSheet(null) }}><Compass size={20} /><span>Survey<small>研究与笔记</small></span></button>
          </nav>
          <div className="mobile-drawer-settings">
          {showSession && <button className="mobile-menu-row" onClick={() => { setShowSession(false); setSheet(null) }}><ArrowLeft size={18} /><span>返回 {pageName}</span></button>}
          <label className="mobile-home-select">默认主页<select aria-label="连接后的默认主页" value={defaultHome} onChange={event => {
            const value = event.target.value as MobilePrimaryWorkface
            try { saveMobileHome(value); setDefaultHome(value); setHomeIssue(null) }
            catch { setHomeIssue('默认主页未保存；原设置和草稿保留。') }
          }}><option value="goals">Goals</option><option value="topics">Topics</option><option value="mote">Mote</option><option value="focus">Focus</option><option value="space">Space</option></select></label>
          {homeIssue && <p className="mobile-spatial-notice" role="status">{homeIssue}</p>}
          <button className="mobile-menu-row" onClick={() => setSheet('connection')}><Wifi size={18} /><span>连接与设备<small>{label} · {location.host}</small></span><ChevronRight size={16} /></button></div>
        </> : sheet === 'identity' && profileIdentity ? <>
          <Dialog.Description id="mobile-sheet-description">原资料与当前工作</Dialog.Description>
          <MobileMoteProfile identity={profileIdentity} client={client} visible={sheet === 'identity'} sourcePath={profileSourcePath} onSourceChange={setProfileSourcePath} onBackChange={registerProfileBack} onOpenGoals={id => {
            openSession(id, profileIdentity); setShowGoalWork(true); setSheet(null)
          }} />
        </> : sheet === 'actions' ? <>
          <Dialog.Description id="mobile-sheet-description">{sessionTitle ?? '原 Agent'} · {objectIdentity?.project ?? '项目未确认'}</Dialog.Description>
          <button className="mobile-menu-row" onClick={() => { setShowGoalWork(value => !value); setSheet(null) }}><Target size={18} /><span>{showGoalWork ? '返回原对话' : '目标与结果'}</span></button>
          <button className="mobile-menu-row" onClick={() => { setShowGoalWork(false); setWorkface(value => ({ ...value, panel: value.panel === 'terminal' ? 'conversation' : 'terminal' })); setSheet(null) }}><SquareTerminal size={18} /><span>{workface.panel === 'terminal' ? '查看对话' : '查看终端'}</span></button>
          <button className="mobile-menu-row" onClick={() => { setShowSession(false); setShowGoalWork(false); setSheet(null) }}><ArrowLeft size={18} /><span>返回 {pageName}</span></button>
        </> : <>
          <Dialog.Description id="mobile-sheet-description">连接同一私网里的 Mac。Agent 与会话由 Mac 管理。</Dialog.Description>
          <p>Mac：{location.origin} · {label}</p>
          <p className="mobile-sheet-note">Mac 保持在线即可继续使用原会话。</p>
          {connectionPanel}
          <MobileRecoveryPanel {...(native ? { exportFile: exportNativeWorkfaceFile } : {})} />
          <p className="mobile-sheet-note">连接会自动恢复。{connection.message}</p>
        </>}
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </div>
}
