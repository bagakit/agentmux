import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { connectRelayHostedClient } from '@agentmux/core/relay-hosted'
import { parseConnectionOffer, type ConnectionOffer } from '@agentmux/relay/offer'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import { MobileApp } from '../MobileApp'
import type { MobileConnection } from '../conversation/use-hosted-conversation'
import { getDeviceWorkface } from '../recovery/device-workface'
import { withDeviceStorageLock } from '../recovery/device-storage-lock'
import { deviceRelayIdentity, existingDeviceRelayIdentity } from './relay-identity'
import type { KeyPair } from '@agentmux/relay/e2ee'
import { MobileWebCatalogObservation, useMobileWebObservation } from '../mobile-web/use-mobile-web-observation'
import { MobileWebUpdateSafetyProvider } from '../mobile-web/update-safety'
import { finishReloadIdentity, matchesReloadIdentity, mobileUpdateFragment, prepareReloadIdentity, reloadOfferIdentity } from './reload-identity'

const OFFER_KEY = 'agentmux.connection-offer.v2'
function reloadRecordIdentity(hostId: string): string | null {
  const { record, issue } = getDeviceWorkface().snapshot()
  if (issue || record.host?.origin !== location.origin || record.host.hostId !== hostId) throw new Error('原设备工作面暂不可完整读取。')
  return record.recordId ?? null
}
export function MobileConnectionRoot({ platform, native, focusComposer, offer, linkIssue }: {
  platform: ClientUiPlatform; native: boolean; focusComposer?: () => boolean; offer?: ConnectionOffer; linkIssue?: string
}) {
  const [client, setClient] = useState<AgentMuxHostedClient | null>(null)
  const [connection, setConnection] = useState<MobileConnection>({ state: 'connecting', message: '正在连接 Mac' })
  const [updatePending, setUpdatePending] = useState(() => !native && location.hash === mobileUpdateFragment)
  const restoreWorkface = useRef(false)
  const [connectionRetry, retryConnection] = useState(0)
  const [returnIssue, setReturnIssue] = useState('')
  const binding = useRef<{ client: AgentMuxHostedClient; offer: string; hostId: string; key: KeyPair; connected: boolean } | null>(null)
  const verifyConnection = useCallback(async () => {
    const original = binding.current
    if (!original) throw new Error('Original connection unavailable')
    const key = await existingDeviceRelayIdentity()
    const equal = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((byte, index) => byte === right[index])
    if (!key || !equal(key.publicKey, original.key.publicKey) || !equal(key.secretKey, original.key.secretKey)) throw new Error('Original device identity unavailable')
    const check = () => {
      try {
        const saved = localStorage.getItem(OFFER_KEY), host = getDeviceWorkface().snapshotIdentity().host
        return binding.current === original && original.connected && !!saved && reloadOfferIdentity(parseConnectionOffer(JSON.parse(saved))) === original.offer
          && host?.origin === location.origin && host.hostId === parseConnectionOffer(JSON.parse(saved)).serverId
      } catch { return false }
    }
    if (!check()) throw new Error('Original connection unavailable')
    return check
  }, [])
  const prepareReload = useCallback(() => {
    const original = binding.current
    if (!original?.connected) throw new Error('原连接暂不可用')
    return prepareReloadIdentity(original.key, original.offer, reloadRecordIdentity(original.hostId))
  }, [])
  const mobileWeb = useMobileWebObservation(client, !native)
  useEffect(() => {
    const controller = new AbortController()
    let owned: AgentMuxHostedClient | undefined, release: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0, working = false, bindingNotice = ''
    let selected: ConnectionOffer | undefined
    try {
      if (linkIssue) throw new Error(linkIssue)
      let saved: string | null
      try { saved = localStorage.getItem(OFFER_KEY) }
      catch { throw new Error('原 Mac 连接记录暂时无法读取；请恢复这台设备的存储后重新检查，原记录保留。') }
      let original: ConnectionOffer | undefined
      if (saved) try { original = parseConnectionOffer(JSON.parse(saved)) }
      catch { throw new Error('原 Mac 连接记录无法完整读取；原记录保留，请恢复原连接记录后重新检查。') }
      selected = offer ?? original
      if (!selected) throw new Error('请在 Mac 的手机连接中复制链接，在这台设备打开。')
      const previous = getDeviceWorkface().snapshot().record.host
      if (previous && previous.hostId !== selected.serverId) throw new Error('链接属于另一台 Mac，原会话和草稿保留。请打开原 Mac 的连接链接。')
      if (offer && original && original.serverId === offer.serverId && original.daemonPublicKeyB64 !== offer.daemonPublicKeyB64) throw new Error('原 Mac 的加密身份发生变化，原连接记录保留。请恢复原 Mac 的身份。')
      if (offer && (native || location.hash !== mobileUpdateFragment)) localStorage.setItem(OFFER_KEY, JSON.stringify(offer))
    } catch (error) { setConnection({ state: 'unavailable', message: error instanceof Error ? error.message : String(error) }); return }
    const connect = async () => {
      if (controller.signal.aborted || working) return
      if (owned) { void owned.connect().catch(() => {}); return }
      working = true
      try {
        const updating = !native && location.hash === mobileUpdateFragment
        const keyPair = updating ? await existingDeviceRelayIdentity() : await deviceRelayIdentity()
        if (!keyPair || updating && !matchesReloadIdentity(keyPair, reloadOfferIdentity(selected!), reloadRecordIdentity(selected!.serverId))) throw new Error('更新后的原设备身份、工作面或 Mac 连接不匹配；原交接记录保留。请恢复原设备密钥、工作面和原 Mac 连接后重试。')
        if (controller.signal.aborted) return
        if (updating && offer) localStorage.setItem(OFFER_KEY, JSON.stringify(offer))
        if (updating) {
          // All DeviceWorkface writers take this same cross-page lock. React's
          // first read is committed inside its synchronous transaction callback.
          await withDeviceStorageLock(() => {
            if (controller.signal.aborted) return
            if (!matchesReloadIdentity(keyPair, reloadOfferIdentity(selected!), reloadRecordIdentity(selected!.serverId))) throw new Error('原工作面在重新打开期间发生变化；请恢复原工作面后重试。')
            restoreWorkface.current = true
            flushSync(() => setUpdatePending(false))
          })
          if (controller.signal.aborted) return
        }
        const name = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Android/.test(navigator.userAgent) ? 'Android' : '浏览器'
        const value = await connectRelayHostedClient({ offer: selected!, keyPair, name, signal: controller.signal })
        if (controller.signal.aborted) { await value.dispose(); return }
        if (updating) try {
          if (!matchesReloadIdentity(keyPair, reloadOfferIdentity(selected!), reloadRecordIdentity(selected!.serverId))) throw new Error('原工作面在重连期间发生变化；原身份交接保留，请恢复原工作面后重试。')
        } catch (error) { await value.dispose(); throw error }
        if (updating) {
          try {
            const offerIdentity = reloadOfferIdentity(selected!), recordId = reloadRecordIdentity(selected!.serverId)
            finishReloadIdentity(keyPair, offerIdentity, recordId)
            try { history.replaceState(null, '', location.pathname + location.search) }
            catch (error) { prepareReloadIdentity(keyPair, offerIdentity, recordId); throw error }
          }
          catch { /* Keep the handoff for the next original connection attempt. */ }
        }
        binding.current = { client: value, offer: reloadOfferIdentity(selected!), hostId: selected!.serverId, key: keyPair, connected: true }
        owned = value; setClient(value); attempt = 0
        release = value.onEvent(event => {
          if (event.type !== 'connection-state' || event.observationOrigin?.boundary !== 'consumer-core') return
          const state = (event as { state: string }).state
          if (binding.current?.client === value) binding.current.connected = state === 'restored'
          setConnection({ state: state === 'restored' ? 'connected' : 'disconnected', message: state === 'restored' ? '已连接 Mac' : '连接中断，自动重连中；原会话与草稿保留。', ...(bindingNotice ? { issue: bindingNotice } : {}) })
        })
        try { await getDeviceWorkface().confirmHost({ origin: location.origin, hostId: selected!.serverId }) }
        catch { bindingNotice = '设备工作面保存尚未确认，当前连接可继续使用；请保全工作面或恢复设备存储。' }
        if (controller.signal.aborted || binding.current?.client !== value) return
        const active = binding.current.connected
        setConnection({ state: active ? 'connected' : 'disconnected', message: active ? '已连接 Mac' : '连接中断，自动重连中；原会话与草稿保留。', ...(bindingNotice ? { issue: bindingNotice } : {}) })
      } catch (error) {
        if (controller.signal.aborted) return
        if (error && typeof error === 'object' && 'code' in error && error.code === 'AGENT_CAPABILITY_INVALID') { setConnection({ state: 'unavailable', message: '此设备的授权未通过确认；原会话和草稿保留。请重新确认设备授权后连接。' }); return }
        setConnection({ state: 'disconnected', message: `暂时无法连接，自动重试中；原会话与草稿保留。${error instanceof Error ? error.message : String(error)}` })
        timer = setTimeout(() => { void connect() }, Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)))
      } finally { working = false }
    }
    const resume = () => { if (document.visibilityState !== 'hidden') { clearTimeout(timer); void connect() } }
    window.addEventListener('online', resume); document.addEventListener('visibilitychange', resume)
    void connect()
    return () => { controller.abort(); clearTimeout(timer); release?.(); if (binding.current?.client === owned) binding.current = null; void owned?.dispose(); window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume) }
  }, [offer, linkIssue, connectionRetry])
  if (updatePending) return <main className="mobile-chat-start mobile-update-recovery" aria-live="polite">
    <strong>正在接回原工作面</strong><p>{connection.message}</p>
    <p>若无法返回上一页，请恢复这台设备的原工作面、设备身份与 Mac 连接后重新检查。</p>
    <div className="mobile-update-recovery__actions">
      <button type="button" onClick={() => retryConnection(value => value + 1)}>重新检查原连接</button>
      <button type="button" onClick={() => { if (history.length > 1) history.back(); else setReturnIssue('没有可返回的上一页；请恢复原工作面、设备身份与 Mac 连接，再重新检查。') }}>返回上一页</button>
    </div>
    {returnIssue && <p role="status">{returnIssue}</p>}
  </main>
  return <MobileWebUpdateSafetyProvider verifyConnection={verifyConnection} prepareReload={prepareReload} native={native}><MobileWebCatalogObservation.Provider value={mobileWeb.observeCatalog}>
    <MobileApp client={client} connection={connection} platform={platform} native={native} webObservation={mobileWeb.observation} restoreWorkface={restoreWorkface.current}
      {...(focusComposer ? { focusComposer } : {})} connectionPanel={<p>连接会自动恢复。Mac 和手机保持在同一局域网即可。</p>} />
  </MobileWebCatalogObservation.Provider></MobileWebUpdateSafetyProvider>
}
