import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowUpRight, Check, ChevronRight, File, Link2, List, MessageSquare, Monitor, Pencil, ShieldCheck, Smartphone, SquareTerminal, Wifi, X } from 'lucide-react'
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

export function validatedHostAddress(value: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('请输入 Mac 的 HTTPS 地址，不要包含账号、授权码或页面路径。')
  }
  return url.origin
}

export function MobileApp({ client, connection, platform, native = false, focusComposer = () => false,
  onHostAddressSaved, connectionPanel }: {
  client: AgentMuxHostedClient | null; connection: MobileConnection; platform: ClientUiPlatform
  native?: boolean; focusComposer?: () => boolean
  onHostAddressSaved?: (address: string) => void; connectionPanel?: ReactNode
}) {
  const initial = useRef<ReturnType<typeof loadWorkface> | null>(null)
  initial.current ??= loadWorkface()
  const [workface, setWorkface] = useState<Workface>(initial.current.workface)
  const [canPersist, setCanPersist] = useState(initial.current.issue === null)
  const addressSaveRequested = useRef(false)
  const [sheet, setSheet] = useState<'connection' | 'attachments' | null>(null)
  const [hostDraft, setHostDraft] = useState(workface.hostUrl)
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
      onBack: () => { setSheet(null); setWorkface(value => ({ ...value, panel: 'conversation' })) }
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
      if (addressSaveRequested.current) {
        addressSaveRequested.current = false
        setNotice(onHostAddressSaved ? null : 'Mac 地址已保存在这台设备。连接与设备授权尚未确认，请在 Mac 上完成授权。')
      }
    } catch {
      addressSaveRequested.current = false
      setNotice('这台设备暂时无法保存导航位置。地址与导航仅临时采用；当前阅读和 Mac 上的原会话仍保留，原存储记录尚未覆盖。')
    }
  }, [workface, onHostAddressSaved])

  const restoreNavigationStorage = () => {
    try {
      const owner = getDeviceWorkface()
      owner.replaceUnreadableWithCurrent(workface)
      setCanPersist(true)
      setNotice('已用当前工作面替换这台设备无法读取的原记录。导航、草稿和未确认输入一起保存；Mac 上的原会话保持不变。')
    } catch { setNotice('这台设备仍无法保存导航。原记录尚未覆盖；当前仍按临时导航继续阅读。') }
  }

  const saveAddress = () => {
    try {
      const address = validatedHostAddress(hostDraft)
      addressSaveRequested.current = canPersist
      setWorkface(value => ({ ...value, hostUrl: address })); setHostDraft(address)
      setNotice(canPersist ? 'Mac 地址已临时采用，设备保存尚待确认。'
        : 'Mac 地址仅临时采用；设备原记录尚未覆盖。当前仍可尝试连接，导航存储尚需恢复。')
      onHostAddressSaved?.(address)
    } catch (error) { reportError(error) }
  }
  const chooseAttachment = async () => {
    if (choosingFile) return
    setChoosingFile(true)
    try { const value = await pickLocalAttachment(); if (value) { setAttachment(value); setSheet('attachments') } }
    catch (error) { reportError(error) }
    finally { setChoosingFile(false) }
  }
  const connected = connection.state === 'connected'
  const label = connected ? '已连接' : connection.state === 'connecting' ? '连接中' : connection.state === 'disconnected' ? '连接中断' : '尚未连接'

  return <div className="mobile-app" data-connection={connection.state}>
    <header className="mobile-header">
      <div className="mobile-brand"><span className="mobile-brand-mark"><SquareTerminal size={22} strokeWidth={1.6} /></span><span>AgentMux</span></div>
      <button className="mobile-status" onClick={() => setSheet('connection')} aria-label={`连接状态：${label}`}><span className="mobile-status-dot" />{label}<ChevronRight size={13} /></button>
    </header>
    <div className="mobile-context"><span>{selected?.workspacePath.split('/').filter(Boolean).at(-1) ?? '你的 Mac'}</span><span className="mobile-context-divider">/</span><span>{workface.panel === 'sessions' ? '已有会话' : workface.panel === 'terminal' ? '终端阅读' : selected ? '对话' : '继续原会话'}</span>
      {native && selected && workface.panel === 'conversation' && <button aria-label="撰写消息" onClick={() => {
        if (!focusComposer()) setNotice('输入区暂时未准备好。原草稿仍保留；可点按输入框继续编辑。')
      }}><Pencil size={17} /></button>}
    </div>
    <main className="mobile-main">
      <section className="mobile-session-panel" hidden={workface.panel !== 'sessions'}>
        <div className="mobile-section-heading"><h1>已有会话</h1><span>{connected && !projectionError ? `${sessions.length} 个` : '待核实'}</span></div>
        {sessions.length ? <ul className="mobile-session-list">{sessions.map(session => <li key={session.agentSessionId}><button onClick={() => setWorkface(value => ({ ...value, selectedSessionId: session.agentSessionId, panel: 'conversation' }))}>
          <span className="mobile-session-icon"><MessageSquare size={19} /></span><span><strong>{session.workspacePath.split('/').filter(Boolean).at(-1) ?? session.providerId}</strong><small>{session.providerId} · {session.agentSessionId.slice(0, 8)}</small></span><ChevronRight size={16} />
        </button></li>)}</ul> : <div className="mobile-list-empty"><List size={28} strokeWidth={1.4} /><h2>会话由 Mac 管理</h2><p>设备授权后，这里会显示同一个 Host 的已有会话。连接未知时不会创建替代会话。</p><button className="mobile-text-button" onClick={() => setSheet('connection')}>查看连接<ArrowUpRight size={15} /></button></div>}
      </section><section className="mobile-conversation-panel" hidden={workface.panel !== 'conversation'}>
        {!workface.selectedSessionId && <section className="mobile-welcome">
          <div className="mobile-connection-illustration" aria-hidden="true"><span><Monitor size={34} strokeWidth={1.25} /></span><i /><span><Smartphone size={30} strokeWidth={1.25} /></span></div>
          <span className="mobile-eyebrow">AGENTMUX · 随身继续</span>
          <h1>让对话继续</h1><p>连接你的 Mac，查看会话。<br />Agent 与会话由 Mac 管理。</p>
          <button className="mobile-primary" onClick={() => setSheet('connection')}><Link2 size={17} />设置连接<ArrowUpRight size={17} /></button>
          <div className="mobile-onboarding-steps"><div><span>01</span><p><strong>Mac 保持在线</strong><small>手机与 Mac 在同一私网</small></p></div><div><span>02</span><p><strong>确认这台设备</strong><small>在 Mac 上批准独立授权</small></p></div><div><span>03</span><p><strong>继续原会话</strong><small>阅读、撰写与回应请求</small></p></div></div>
        </section>}
        <div className={`mobile-conversation-slot${workface.selectedSessionId ? ' is-active' : ''}`}>
          <MobileConversationSurface client={client} agentSessionId={workface.selectedSessionId} connection={connection} platform={platform} openHttpLink={openBrowserHttpLink} onAttach={() => { void chooseAttachment() }} />
        </div>
      </section><section className="mobile-terminal-panel" hidden={workface.panel !== 'terminal'}>
        <MobileTerminalViewer client={client} agentSessionId={workface.selectedSessionId} connection={connection} platform={platform} visible={workface.panel === 'terminal'} />
      </section>
    </main>
    <aside className="mobile-service-notice" role="status"><span className="mobile-notice-mark"><ShieldCheck size={15} /></span><div><p>{notice ?? projectionError ?? connection.message}</p>{!canPersist && <button onClick={restoreNavigationStorage}>用当前工作面替换原记录</button>}</div></aside>
    <nav className="mobile-navigation" aria-label="手机导航">
      <button aria-current={workface.panel === 'conversation' ? 'page' : undefined} onClick={() => setWorkface(value => ({ ...value, panel: 'conversation' }))}><MessageSquare size={20} /><span>对话</span></button>
      <button aria-current={workface.panel === 'sessions' ? 'page' : undefined} onClick={() => setWorkface(value => ({ ...value, panel: 'sessions' }))}><List size={21} /><span>会话</span></button>
      <button aria-current={workface.panel === 'terminal' ? 'page' : undefined} onClick={() => setWorkface(value => ({ ...value, panel: 'terminal' }))}><SquareTerminal size={20} /><span>终端</span></button>
      <button onClick={() => setSheet('connection')}><Wifi size={20} /><span>连接</span></button>
    </nav>
    <Dialog.Root open={sheet !== null} onOpenChange={open => { if (!open) setSheet(null) }}>
      <Dialog.Portal container={platform.overlayContainer()}><Dialog.Overlay className="mobile-sheet-backdrop" /><Dialog.Content className="mobile-sheet" aria-describedby="mobile-sheet-description">
        <div className="mobile-sheet-handle" /><div className="mobile-sheet-title"><Dialog.Title>{sheet === 'attachments' ? '本地附件' : '连接你的 Mac'}</Dialog.Title><Dialog.Close className="mobile-icon-button" aria-label="关闭面板"><X size={19} /></Dialog.Close></div>
        {sheet === 'attachments' ? <>
          <Dialog.Description id="mobile-sheet-description">系统已选中附件，文件仍在这台设备上。</Dialog.Description>
          {attachment && <div className="mobile-selected-file"><File size={22} /><div><strong>{attachment.name}</strong><small>{attachment.mimeType} · {(attachment.size / 1024).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} KB</small></div><Check size={17} /></div>}
          <p className="mobile-sheet-note">尚未上传至 Mac，发送消息不会附带这个本地文件。文件传输能力未确认前，原草稿和会话保持不变。</p>
          <button className="mobile-secondary" onClick={() => { setAttachment(null); setSheet(null) }}>移除本地选择</button>
        </> : <>
          <Dialog.Description id="mobile-sheet-description">连接同一私网里的 Mac。Agent 与会话由 Mac 管理。</Dialog.Description>
          <label className="mobile-address-label" htmlFor="mobile-host-address">Mac 的 HTTPS 地址</label>
          <input id="mobile-host-address" className="mobile-address-input" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="https://192.168.1.20:端口" value={hostDraft} onChange={event => setHostDraft(event.target.value)} />
          <p>使用 Mac 显示的局域网 IP 与端口；手机与 Mac 需在同一 Wi-Fi。</p>
          <button className="mobile-primary" onClick={saveAddress}>{canPersist ? '保存地址' : '临时采用地址'}<ChevronRight size={17} /></button>
          <div className="mobile-sheet-checks"><p><ShieldCheck size={17} /><span>保存地址只记录这台 Mac；设备授权要在 Mac 上确认。</span></p><p><Monitor size={17} /><span>Mac 需要保持在线。睡眠或离线不会被当成 Agent 已退出。</span></p></div>
          {connectionPanel}
          <MobileRecoveryPanel {...(native ? { exportFile: exportNativeWorkfaceFile } : {})} />
          <p className="mobile-sheet-note">{connectionPanel ? '设备授权和会话连接分别核实。' : '此处只记录 Mac 地址，设备授权需要独立确认。'}重新安装后需要重新确认 Mac 和设备授权。{connection.message}</p>
        </>}
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </div>
}
