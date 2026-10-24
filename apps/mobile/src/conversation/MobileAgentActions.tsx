import { MobileNotice } from '../notices/MobileNotice'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { formatSessionAddress } from '@agentmux/core/sharing'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { ClientUiPlatform } from '@agentmux/client-ui'
import { getDeviceWorkface } from '../recovery/device-workface'
import { recoverMobileAgent, pendingMobileAgentRecovery, mobileAgentRecoveryBusy, subscribeMobileAgentRecovery } from './mobile-agent-recovery'
import { MobileAgentUsage } from './MobileAgentUsage'

/** Explicit actions on the persistent Agent. Reading or reconnecting never submits a recovery. */
export function MobileAgentActions({ client, agentSessionId, connected, copyText, visible = true, beforeAction }: {
  client: AgentMuxHostedClient | null; agentSessionId: string; connected: boolean
  copyText: ClientUiPlatform['copyText']; visible?: boolean; beforeAction?(): boolean
}) {
  const [notice, setNotice] = useState(''), [showLink, setShowLink] = useState(false)
  const busy = useSyncExternalStore(useCallback(notify => subscribeMobileAgentRecovery(client, agentSessionId, notify), [client, agentSessionId]),
    useCallback(() => mobileAgentRecoveryBusy(client, agentSessionId), [client, agentSessionId]), () => false)
  const [, redraw] = useState(0)
  const current = useRef({ client, agentSessionId, visible, connected })
  current.current = { client, agentSessionId, visible, connected }
  const owner = getDeviceWorkface()
  const pending = pendingMobileAgentRecovery(client, agentSessionId)
  useEffect(() => () => { current.current.visible = false }, [])
  useEffect(() => { setNotice(''); setShowLink(false); redraw(value => value + 1) }, [client, agentSessionId])
  const link = formatSessionAddress(agentSessionId)
  async function copy() {
    const source = { client, agentSessionId }, recordId = owner.recordIdentity()
    const unchanged = () => current.current.visible && current.current.client === source.client && current.current.agentSessionId === source.agentSessionId && owner.recordIdentity() === recordId
    try { const copied = await copyText(link, () => {}); if (!unchanged()) return; if (!copied) throw new Error('浏览器未确认复制。'); setNotice('已复制 Agent 身份链接。'); setShowLink(false) }
    catch (error) { if (!unchanged()) return; setShowLink(true); setNotice(`${error instanceof Error ? error.message : String(error)} 可选取下方原链接。`) }
  }
  async function recover(mode: 'new' | 'inspect' | 'continue') {
    if (beforeAction && !beforeAction() || !client || !connected || !visible) return
    const original = { client, agentSessionId, visible }
    const unchanged = () => (!beforeAction || beforeAction()) && current.current.client === original.client &&
      current.current.agentSessionId === original.agentSessionId && current.current.visible === original.visible && current.current.connected
    try { await recoverMobileAgent({ client, agentSessionId, mode, isCurrent: unchanged, onNotice: setNotice }) }
    finally { if (current.current.client === client && current.current.agentSessionId === agentSessionId) { redraw(value => value + 1) } }
  }

  return <div className="mobile-agent-actions">
    <button className="mobile-menu-row" onClick={() => void copy()}><SemanticIcon name="action.copy" size={18} /><span>复制 Agent 身份链接</span></button>
    {showLink && <input aria-label="Agent 身份链接" value={link} readOnly onFocus={event => event.target.select()} />}
    <MobileAgentUsage client={client} agentSessionId={agentSessionId} connected={connected} beforeRead={beforeAction} />
    <button className="mobile-menu-row" disabled={busy || !connected || !client} onClick={() => void recover(pending ? 'inspect' : 'new')}><SemanticIcon name="action.refresh" size={18} /><span>{busy ? '正在核对原会话…' : pending ? '核对原恢复操作' : '恢复原 Agent'}</span></button>
    {pending && <button className="mobile-menu-row" disabled={busy || !connected || !client} onClick={() => void recover('continue')}><span>继续同一恢复操作</span></button>}
    {notice && <MobileNotice kind="feedback" owner={client} identity={[agentSessionId,pending?.input.operationId,notice]} className="mobile-spatial-notice" role="status">{notice}</MobileNotice>}
  </div>
}
