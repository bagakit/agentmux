import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Check, ChevronRight, File, Link2, List, MessageSquare, Pencil, ShieldCheck, Layers, ArrowLeft, MoreHorizontal, Smartphone, SquareTerminal, Wifi, X } from 'lucide-react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import { MobileConversationSurface, type MobileConnection } from './conversation/MobileConversationSurface'
import { MobileTerminalViewer } from './terminal/MobileTerminalViewer'
import { bindMobileViewport, bindNativeDevice, pickLocalAttachment, type LocalAttachment } from './platform/native/device'
import { openBrowserHttpLink } from './platform/browser'
import './mobile.css'
import { getDeviceWorkface, type Navigation } from './recovery/device-workface'
import { MobileRecoveryPanel } from './recovery/MobileRecoveryPanel'
import { exportNativeWorkfaceFile } from './platform/native/workface-file'

import brandIcon from './assets/agentmux.png'
import { MoteMark } from './navigation/MoteMark'
import { MobileSpatialNavigation } from './navigation/MobileSpatialNavigation'
import { readMobileHome, saveMobileHome, type MobileHome } from './navigation/home-preference'

type Workface = Navigation

function loadWorkface(): { workface: Workface; issue: string | null } {
  const empty: Workface = { selectedSessionId: null, hostUrl: '', panel: 'conversation' }
  try {
    const { record, issue } = getDeviceWorkface().snapshot()
    return { issue, workface: { selectedSessionId: record.selectedSessionId, hostUrl: record.hostUrl, panel: record.panel } }
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
  const [hasConnected, setHasConnected] = useState(connection.state === 'connected')
  useEffect(() => { if (connection.state === 'connected') setHasConnected(true) }, [connection.state])
  const initial = useRef<ReturnType<typeof loadWorkface> | null>(null)
  initial.current ??= loadWorkface()
  const [workface, setWorkface] = useState<Workface>(initial.current.workface)
  const [canPersist, setCanPersist] = useState(initial.current.issue === null)
  const initialHome = useRef(readMobileHome())
  const [home, setHome] = useState<MobileHome>(initialHome.current.home)
  const [defaultHome, setDefaultHome] = useState<MobileHome>(initialHome.current.home)
  const [homeIssue, setHomeIssue] = useState(initialHome.current.issue)
  const [showSession, setShowSession] = useState(false)
  const [sessionTitle, setSessionTitle] = useState<string | null>(null)
  const [sheet, setSheet] = useState<'connection' | 'attachments' | 'settings' | null>(null)
  const [notice, setNotice] = useState<string | null>(initial.current.issue)
  const [attachment, setAttachment] = useState<LocalAttachment | null>(null)
  const [choosingFile, setChoosingFile] = useState(false)
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
      onBack: () => { setSheet(null); setShowSession(false) }
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
  useEffect(() => {
    if (workface === initial.current?.workface) return
    try {
      getDeviceWorkface().updateNavigation(workface)
    } catch {
      setNotice('这台设备暂时无法保存导航位置。地址与导航仅临时采用；当前阅读和 Mac 上的原会话仍保留，原存储记录尚未覆盖。')
    }
  }, [workface])

  const restoreNavigationStorage = () => {
    try {
      const owner = getDeviceWorkface()
      owner.replaceUnreadableWithCurrent(workface)
      setCanPersist(true)
      setNotice('已用当前工作面替换这台设备无法读取的原记录。导航、草稿和未确认输入一起保存；Mac 上的原会话保持不变。')
    } catch { setNotice('这台设备仍无法保存导航。原记录尚未覆盖；当前仍按临时导航继续阅读。') }
  }


  const chooseAttachment = async () => {
    if (choosingFile) return
    setChoosingFile(true)
    try { const value = await pickLocalAttachment(); if (value) { setAttachment(value); setSheet('attachments') } }
    catch (error) { reportError(error) }
    finally { setChoosingFile(false) }
  }
  const connected = connection.state === 'connected'
  const workspaceVisible = connected || hasConnected
  const label = connected ? '已连接' : connection.state === 'connecting' ? '连接中' : connection.state === 'disconnected' ? '连接中断' : '尚未连接'

  return <div className="mobile-app" data-connection={connection.state}>
    <header className="mobile-header">
      <div className="mobile-brand"><img className="mobile-brand-icon" src={brandIcon} width={28} height={28} alt="" /><span>AgentMux</span></div>
      <div className="mobile-header-actions"><span className="mobile-status-dot" aria-label={label} />
        <button className="mobile-icon-button" onClick={() => setSheet(workspaceVisible ? 'settings' : 'connection')} aria-label={workspaceVisible ? '手机设置与连接' : '连接你的 Mac'}><MoreHorizontal size={20} /></button></div>
    </header>
    {workspaceVisible && showSession && <div className="mobile-session-toolbar">
      <button className="mobile-text-button" onClick={() => setShowSession(false)}><ArrowLeft size={16} />{home === 'mote' ? 'Mote' : home === 'space' ? 'Space' : 'Focus'}</button>
      <span>{sessionTitle ?? selected?.providerId ?? '原会话'}</span>
      <button className="mobile-icon-button" aria-label={workface.panel === 'terminal' ? '查看对话' : '查看终端'} onClick={() => setWorkface(value => ({ ...value, panel: value.panel === 'terminal' ? 'conversation' : 'terminal' }))}>{workface.panel === 'terminal' ? <MessageSquare size={18} /> : <SquareTerminal size={18} />}</button>
      {native && selected && workface.panel !== 'terminal' && <button className="mobile-icon-button" aria-label="撰写消息" onClick={() => { if (!focusComposer()) setNotice('输入区暂时未准备好。原草稿保留。') }}><Pencil size={17} /></button>}
    </div>}
    <main className="mobile-main">
      {!workspaceVisible && <section className="mobile-connect-page"><span className="mobile-connect-mark"><Smartphone size={28} /></span><h1>连接你的 Mac</h1>
        <p>在 Mac 的 Phone &amp; Devices 中复制连接链接，用手机打开。两台设备连接同一 Wi-Fi。</p>
        <p className="mobile-spatial-notice" role="status">{connection.message}</p>{connectionPanel}
        <button className="mobile-secondary" onClick={() => setSheet('connection')}><Link2 size={16} />连接详情</button>
      </section>}
      {workspaceVisible && !showSession && <MobileSpatialNavigation home={home} client={client} connected={connected} sessions={sessions} openSession={(id, title) => {
        setSessionTitle(title)
        setWorkface(value => ({ ...value, selectedSessionId: id, panel: 'conversation' })); setShowSession(true)
      }} />}
      <section className="mobile-conversation-panel" hidden={!workspaceVisible || !showSession || workface.panel === 'terminal'}>
        {!workface.selectedSessionId && <p className="mobile-spatial-empty">从 {home === 'mote' ? 'Mote' : home === 'space' ? 'Space' : 'Focus'} 选择已有 Agent。</p>}
        <div className={`mobile-conversation-slot${workface.selectedSessionId ? ' is-active' : ''}`}>
          <MobileConversationSurface client={client} agentSessionId={workface.selectedSessionId} connection={connection} platform={platform} {...(sessionTitle ? { displayName: sessionTitle } : {})} visible={workspaceVisible && showSession && workface.panel !== 'terminal'} onShowTerminal={() => setWorkface(value => ({ ...value, panel: 'terminal' }))} openHttpLink={openBrowserHttpLink} onAttach={() => { void chooseAttachment() }} />
        </div>
      </section><section className="mobile-terminal-panel" hidden={!workspaceVisible || !showSession || workface.panel !== 'terminal'}>
        <MobileTerminalViewer client={client} agentSessionId={workface.selectedSessionId} connection={connection} platform={platform} {...(sessionTitle ? { displayName: sessionTitle } : {})} visible={workspaceVisible && showSession && workface.panel === 'terminal'} />
      </section>
    </main>
    {(notice || projectionError || connection.issue || hasConnected && !connected || !canPersist) && <aside className="mobile-service-notice" role="status"><span className="mobile-notice-mark"><ShieldCheck size={15} /></span><div><p>{notice ?? projectionError ?? connection.issue ?? connection.message}</p>{!canPersist && <button onClick={restoreNavigationStorage}>用当前工作面替换原记录</button>}</div></aside>}
    {workspaceVisible && <nav className="mobile-navigation" aria-label="手机导航">
      <button aria-current={!showSession && home === 'mote' ? 'page' : undefined} onClick={() => { setHome('mote'); setShowSession(false) }}><MoteMark size={20} /><span>Mote</span></button>
      <button aria-current={!showSession && home === 'focus' ? 'page' : undefined} onClick={() => { setHome('focus'); setShowSession(false) }}><List size={20} /><span>Focus</span></button>
      <button aria-current={!showSession && home === 'space' ? 'page' : undefined} onClick={() => { setHome('space'); setShowSession(false) }}><Layers size={20} /><span>Space</span></button>
    </nav>}
    <Dialog.Root open={sheet !== null} onOpenChange={open => { if (!open) setSheet(null) }}>
      <Dialog.Portal container={platform.overlayContainer()}><Dialog.Overlay className="mobile-sheet-backdrop" /><Dialog.Content className="mobile-sheet" aria-describedby="mobile-sheet-description">
        <div className="mobile-sheet-handle" /><div className="mobile-sheet-title"><Dialog.Title>{sheet === 'attachments' ? '本地附件' : sheet === 'settings' ? '手机设置' : '连接你的 Mac'}</Dialog.Title><Dialog.Close className="mobile-icon-button" aria-label="关闭面板"><X size={19} /></Dialog.Close></div>
        {sheet === 'settings' ? <>
          <Dialog.Description id="mobile-sheet-description">这台手机的显示偏好</Dialog.Description>
          <fieldset className="mobile-home-settings"><legend>连接后的默认主页</legend>
            {(['mote', 'focus', 'space'] as const).map(value => <label key={value}><span><strong>{value === 'mote' ? 'Mote' : value === 'focus' ? 'Focus' : 'Space'}</strong><small>{value === 'mote' ? '协调与长期讨论' : value === 'focus' ? '执行状态与待处理事项' : '工作空间与已有 Agent'}</small></span><input type="radio" name="mobile-default-home" value={value} aria-label={value === 'mote' ? 'Mote' : value === 'focus' ? 'Focus' : 'Space'} checked={defaultHome === value} onChange={() => {
              try { saveMobileHome(value); setDefaultHome(value); setHomeIssue(null) }
              catch { setHomeIssue('默认主页未保存。当前会话和草稿保留，请稍后重试。') }
            }} /></label>)}
          </fieldset>
          {homeIssue && <p className="mobile-spatial-notice" role="status">{homeIssue}</p>}
          <button className="mobile-menu-row" onClick={() => setSheet('connection')}><Wifi size={18} /><span>连接与设备<small>{label} · {location.host}</small></span><ChevronRight size={16} /></button>
        </> : sheet === 'attachments' ? <>
          <Dialog.Description id="mobile-sheet-description">系统已选中附件，文件仍在这台设备上。</Dialog.Description>
          {attachment && <div className="mobile-selected-file"><File size={22} /><div><strong>{attachment.name}</strong><small>{attachment.mimeType} · {(attachment.size / 1024).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} KB</small></div><Check size={17} /></div>}
          <p className="mobile-sheet-note">尚未上传至 Mac，发送消息不会附带这个本地文件。文件传输能力未确认前，原草稿和会话保持不变。</p>
          <button className="mobile-secondary" onClick={() => { setAttachment(null); setSheet(null) }}>移除本地选择</button>
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
