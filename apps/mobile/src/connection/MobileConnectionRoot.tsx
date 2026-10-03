import { useEffect, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { connectRelayHostedClient } from '@agentmux/core/relay-hosted'
import { parseConnectionOffer, type ConnectionOffer } from '@agentmux/relay/offer'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import { MobileApp } from '../MobileApp'
import type { MobileConnection } from '../conversation/use-hosted-conversation'
import { getDeviceWorkface } from '../recovery/device-workface'
import { deviceRelayIdentity } from './relay-identity'

const OFFER_KEY = 'agentmux.connection-offer.v2'
export function MobileConnectionRoot({ platform, native, focusComposer, offer, linkIssue }: {
  platform: ClientUiPlatform; native: boolean; focusComposer?: () => boolean; offer?: ConnectionOffer; linkIssue?: string
}) {
  const [client, setClient] = useState<AgentMuxHostedClient | null>(null)
  const [connection, setConnection] = useState<MobileConnection>({ state: 'connecting', message: '正在连接 Mac' })
  useEffect(() => {
    const controller = new AbortController()
    let owned: AgentMuxHostedClient | undefined, release: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0, working = false, bindingNotice = ''
    let selected: ConnectionOffer | undefined
    try {
      if (linkIssue) throw new Error(linkIssue)
      const saved = localStorage.getItem(OFFER_KEY)
      selected = offer ?? (saved ? parseConnectionOffer(JSON.parse(saved)) : undefined)
      if (!selected) throw new Error('请在 Mac 的手机连接中复制链接，在这台设备打开。')
      const previous = getDeviceWorkface().snapshot().record.host
      if (previous && previous.hostId !== selected.serverId) throw new Error('链接属于另一台 Mac，原会话和草稿保留。请打开原 Mac 的连接链接。')
      if (offer && saved) { const original = parseConnectionOffer(JSON.parse(saved)); if (original.serverId === offer.serverId && original.daemonPublicKeyB64 !== offer.daemonPublicKeyB64) throw new Error('原 Mac 的加密身份发生变化，原连接记录保留。请恢复原 Mac 的身份。') }
      if (offer) localStorage.setItem(OFFER_KEY, JSON.stringify(offer))
    } catch (error) { setConnection({ state: 'unavailable', message: error instanceof Error ? error.message : String(error) }); return }
    const connect = async () => {
      if (controller.signal.aborted || working) return
      if (owned) { void owned.connect().catch(() => {}); return }
      working = true
      try {
        const keyPair = await deviceRelayIdentity()
        const name = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Android/.test(navigator.userAgent) ? 'Android' : '浏览器'
        const value = await connectRelayHostedClient({ offer: selected!, keyPair, name, signal: controller.signal })
        if (controller.signal.aborted) { await value.dispose(); return }
        owned = value; setClient(value); attempt = 0
        try { getDeviceWorkface().confirmHost({ origin: location.origin, hostId: selected!.serverId }) }
        catch { bindingNotice = '设备工作面保存尚未确认，当前连接可继续使用；请保全工作面或恢复设备存储。' }
        setConnection({ state: 'connected', message: ['已连接 Mac', bindingNotice].filter(Boolean).join(' ') })
        release = value.onEvent(event => {
          if (event.type !== 'connection-state') return
          const state = (event as { state: string }).state
          setConnection({ state: state === 'restored' ? 'connected' : 'disconnected', message: [state === 'restored' ? '已连接 Mac' : '连接中断，自动重连中；原会话与草稿保留。', bindingNotice].filter(Boolean).join(' ') })
        })
      } catch (error) {
        if (controller.signal.aborted) return
        if (error && typeof error === 'object' && 'code' in error && error.code === 'AGENT_CAPABILITY_INVALID') { setConnection({ state: 'unavailable', message: '此设备授权已撤销；原会话和草稿保留。' }); return }
        setConnection({ state: 'disconnected', message: `暂时无法连接，自动重试中；原会话与草稿保留。${error instanceof Error ? error.message : String(error)}` })
        timer = setTimeout(() => { void connect() }, Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)))
      } finally { working = false }
    }
    const resume = () => { if (document.visibilityState !== 'hidden') { clearTimeout(timer); void connect() } }
    window.addEventListener('online', resume); document.addEventListener('visibilitychange', resume)
    void connect()
    return () => { controller.abort(); clearTimeout(timer); release?.(); void owned?.dispose(); window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume) }
  }, [offer, linkIssue])
  return <MobileApp client={client} connection={connection} platform={platform} native={native}
    {...(focusComposer ? { focusComposer } : {})} connectionPanel={<p>连接会自动恢复。Mac 和手机保持在同一局域网即可。</p>} />
}
