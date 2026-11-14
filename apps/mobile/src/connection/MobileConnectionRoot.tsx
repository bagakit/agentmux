import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { connectRelayHostedClient } from '@agentmux/core/relay-hosted'
import { parseConnectionOffer, readPinnedConnectionOffer, type ConnectionOffer, type ConnectionPin } from '@agentmux/relay/offer'
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
  if (issue || record.host?.origin !== location.origin || record.host.hostId !== hostId) throw new Error('这台设备的工作面记录暂时无法完整读取。')
  return record.recordId ?? null
}
export function MobileConnectionRoot({ platform, native, focusComposer, offer, pin, linkIssue }: {
  platform: ClientUiPlatform; native: boolean; focusComposer?: () => boolean; offer?: ConnectionOffer; pin?: ConnectionPin; linkIssue?: string
}) {
  const [client, setClient] = useState<AgentMuxHostedClient | null>(null)
  const [connection, setConnection] = useState<MobileConnection>({ state: 'connecting', message: '正在连接 Mac' })
  const [updatePending, setUpdatePending] = useState(() => !native && location.hash === mobileUpdateFragment)
  const restoreWorkface = useRef(false)
  const [connectionRetry, retryConnection] = useState(0)
  const [returnIssue, setReturnIssue] = useState('')
  const binding = useRef<{ client: AgentMuxHostedClient; offer: string; hostId: string; key: KeyPair; state: MobileConnection['state'] } | null>(null)
  const verifyConnection = useCallback(async () => {
    const original = binding.current
    if (!original) throw new Error('Original connection unavailable')
    const key = await existingDeviceRelayIdentity()
    const equal = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((byte, index) => byte === right[index])
    if (!key || !equal(key.publicKey, original.key.publicKey) || !equal(key.secretKey, original.key.secretKey)) throw new Error('Original device identity unavailable')
    const check = () => {
      try {
        const saved = localStorage.getItem(OFFER_KEY), host = getDeviceWorkface().snapshotIdentity().host
        return binding.current === original && original.state === 'connected' && !!saved && reloadOfferIdentity(parseConnectionOffer(JSON.parse(saved))) === original.offer
          && host?.origin === location.origin && host.hostId === parseConnectionOffer(JSON.parse(saved)).serverId
      } catch { return false }
    }
    if (!check()) throw new Error('Original connection unavailable')
    return check
  }, [])
  const prepareReload = useCallback(() => {
    const original = binding.current
    if (original?.state !== 'connected') throw new Error('连接暂不可用')
    return prepareReloadIdentity(original.key, original.offer, reloadRecordIdentity(original.hostId))
  }, [])
  const mobileWeb = useMobileWebObservation(client, !native)
  useEffect(() => {
    const controller = new AbortController()
    let owned: AgentMuxHostedClient | undefined, release: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined
    let pinKey: KeyPair | undefined
    let attempt = 0, working = false, pinAwaitingRetry = false, bindingNotice = '', offerNotice = ''
    // Saving the verified link only lets this device reconnect later without opening it again.
    // A failed save is reported beside the connection; it never stops the connection itself.
    const keepOffer = (value: ConnectionOffer) => {
      try { localStorage.setItem(OFFER_KEY, JSON.stringify(value)); offerNotice = ''; return true }
      catch { offerNotice = '这次的连接链接没有保存到这台设备；当前连接可继续使用，下次请从 Mac 重新打开连接链接。'; return false }
    }
    let selected: ConnectionOffer | undefined, original: ConnectionOffer | undefined, saved: string | null = null, unpaired = false
    const pinOrigin = location.origin, pinRecord = getDeviceWorkface().recordIdentity()
    const pinSourceCurrent = () => {
      try { return !controller.signal.aborted && location.origin === pinOrigin && getDeviceWorkface().recordIdentity() === pinRecord && localStorage.getItem(OFFER_KEY) === saved }
      catch { return false }
    }
    const checkOffer = (value: ConnectionOffer) => {
      const previous = getDeviceWorkface().snapshot().record.host
      if (previous && previous.hostId !== value.serverId) throw new Error('这个链接属于另一台 Mac，请打开之前那台 Mac 的连接链接。')
      if (original && original.serverId === value.serverId && original.daemonPublicKeyB64 !== value.daemonPublicKeyB64) throw new Error('这台 Mac 的加密身份已变化，请先在 Mac 上恢复原来的身份。')
    }
    try {
      if (linkIssue) throw new Error(linkIssue)
      try { saved = localStorage.getItem(OFFER_KEY) }
      catch { throw new Error('这台设备暂时读不到 Mac 连接记录，请恢复设备存储后重新检查。') }
      if (saved) try { original = parseConnectionOffer(JSON.parse(saved)) }
      catch { throw new Error('Mac 连接记录无法完整读取，请恢复这条记录后重新检查。') }
      selected = pin ? undefined : offer ?? original
      if (!selected && !pin) { unpaired = true; throw new Error('请在 Mac 的手机连接中复制链接，在这台设备打开。') }
      if (selected) checkOffer(selected)
      if (offer && (native || location.hash !== mobileUpdateFragment)) keepOffer(offer)
    } catch (error) {
      setConnection({ state: 'unavailable', message: error instanceof Error ? error.message : String(error), ...(selected ? { paired: true } : unpaired ? { paired: false } : {}) })
      return
    }
    setConnection({ state: 'connecting', message: pin ? '正在读取连接…' : '正在连接 Mac', paired: true })
    const connect = async () => {
      if (controller.signal.aborted || working || pinAwaitingRetry) return
      if (owned) { if (binding.current?.state !== 'unavailable') void owned.connect().catch(() => {}); return }
      working = true
      try {
        if (pin && !selected) {
          const value = await readPinnedConnectionOffer(pinOrigin, pin, controller.signal)
          if (!pinSourceCurrent()) { pinAwaitingRetry = true; throw new Error('读取连接时原工作面或连接记录已变化，请核对后重新读取。') }
          checkOffer(value)
          selected = value
          setConnection({ state: 'connecting', message: '正在连接 Mac', paired: true })
        }
        const updating = !native && location.hash === mobileUpdateFragment
        const keyPair = pinKey ?? (updating ? await existingDeviceRelayIdentity() : await deviceRelayIdentity())
        if (pin && keyPair) pinKey = keyPair
        if (!keyPair || updating && !matchesReloadIdentity(keyPair, reloadOfferIdentity(selected!), reloadRecordIdentity(selected!.serverId))) throw new Error('更新网页后，设备身份、工作面或 Mac 连接对不上，请恢复后重试。')
        if (controller.signal.aborted) return
        if (pin && !pinSourceCurrent()) { pinAwaitingRetry = true; throw new Error('连接前原工作面或连接记录已变化，请核对后重新读取。') }
        if (updating && offer) keepOffer(offer)
        if (updating) {
          // All DeviceWorkface writers take this same cross-page lock. React's
          // first read is committed inside its synchronous transaction callback.
          await withDeviceStorageLock(() => {
            if (controller.signal.aborted) return
            if (!matchesReloadIdentity(keyPair, reloadOfferIdentity(selected!), reloadRecordIdentity(selected!.serverId))) throw new Error('重新打开网页期间工作面发生了变化，请恢复后重试。')
            restoreWorkface.current = true
            flushSync(() => setUpdatePending(false))
          })
          if (controller.signal.aborted) return
        }
        const name = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Android/.test(navigator.userAgent) ? 'Android' : '浏览器'
        const value = await connectRelayHostedClient({ offer: selected!, keyPair, name, signal: controller.signal, sessions: 'summary' })
        if (controller.signal.aborted) { await value.dispose(); return }
        if (pin) {
          if (!pinSourceCurrent()) { pinAwaitingRetry = true; await value.dispose(); throw new Error('连接期间原工作面或连接记录已变化，请核对后重新读取。') }
          if (keepOffer(selected!)) {
            saved = JSON.stringify(selected)
            try { history.replaceState(null, '', location.pathname + location.search) } catch { /* The original pin remains available. */ }
          }
        }
        if (updating) try {
          if (!matchesReloadIdentity(keyPair, reloadOfferIdentity(selected!), reloadRecordIdentity(selected!.serverId))) throw new Error('重新连接期间工作面发生了变化，请恢复后重试。')
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
        binding.current = { client: value, offer: reloadOfferIdentity(selected!), hostId: selected!.serverId, key: keyPair, state: 'connected' }
        owned = value; setClient(value); attempt = 0
        let observation: MobileConnection = { state: 'connected', message: '已连接 Mac' }
        const publish = () => {
          if (controller.signal.aborted || binding.current?.client !== value) return
          binding.current.state = observation.state
          const issue = [observation.issue, bindingNotice, offerNotice].filter(Boolean).join('\n')
          setConnection({ ...observation, paired: true, ...(issue ? { issue } : {}) })
        }
        release = value.onEvent(event => {
          if (event.type !== 'connection-state' || event.observationOrigin?.boundary !== 'consumer-core') return
          observation = event.state === 'restored' ? { state: 'connected', message: '已连接 Mac' }
            : event.state === 'unrecoverable' ? { state: 'unavailable', message: '连接需要处理，自动重连已暂停。',
              ...(event.diagnostic ? { issue: `${event.diagnostic.code}: ${event.diagnostic.message}` } : {}) }
              : { state: 'disconnected', message: '连接中断，正在自动重连。' }
          publish()
        })
        try { await getDeviceWorkface().confirmHost({ origin: location.origin, hostId: selected!.serverId }) }
        catch { bindingNotice = '设备工作面保存尚未确认，当前连接可继续使用；请保全工作面或恢复设备存储。' }
        publish()
      } catch (error) {
        if (controller.signal.aborted) return
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        if (pin && (!selected || pinAwaitingRetry || !pinSourceCurrent() || code === 'CONTROL_PROTOCOL_ERROR' || code === 'CONTROL_PERMISSION_DENIED' || code === 'AGENT_CAPABILITY_INVALID')) {
          pinAwaitingRetry = true; setConnection({ state: 'unavailable', message: `这次连接尚未确认。${error instanceof Error ? error.message : String(error)}。可重新读取连接或从原 Mac 重新复制。`, paired: true }); return
        }
        if (error && typeof error === 'object' && 'code' in error && error.code === 'AGENT_CAPABILITY_INVALID') { setConnection({ state: 'unavailable', message: '这台设备的授权未通过确认，请重新确认授权后连接。', paired: true }); return }
        setConnection({ state: 'disconnected', message: `暂时无法连接，正在自动重试。${error instanceof Error ? error.message : String(error)}`, paired: true })
        timer = setTimeout(() => { void connect() }, Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)))
      } finally { working = false }
    }
    const resume = () => { if (document.visibilityState !== 'hidden') { clearTimeout(timer); void connect() } }
    window.addEventListener('online', resume); document.addEventListener('visibilitychange', resume)
    void connect()
    return () => { controller.abort(); clearTimeout(timer); release?.(); if (binding.current?.client === owned) binding.current = null; void owned?.dispose(); window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume) }
  }, [offer, pin, linkIssue, connectionRetry])
  if (updatePending) return <main className="mobile-chat-start mobile-update-recovery" aria-live="polite">
    <strong>正在接回工作面</strong><p>{connection.message}</p>
    <p>如果无法返回上一页，请恢复这台设备的工作面、身份与 Mac 连接后重新检查。</p>
    <div className="mobile-update-recovery__actions">
      <button type="button" onClick={() => retryConnection(value => value + 1)}>重新检查连接</button>
      <button type="button" onClick={() => { if (history.length > 1) history.back(); else setReturnIssue('没有可返回的上一页，请恢复工作面、设备身份与 Mac 连接后重新检查。') }}>返回上一页</button>
    </div>
    {returnIssue && <p role="status">{returnIssue}</p>}
  </main>
  return <MobileWebUpdateSafetyProvider verifyConnection={verifyConnection} prepareReload={prepareReload} native={native}><MobileWebCatalogObservation.Provider value={mobileWeb.observeCatalog}>
    <MobileApp client={client} connection={connection} platform={platform} native={native} webObservation={mobileWeb.observation} restoreWorkface={restoreWorkface.current}
      {...(focusComposer ? { focusComposer } : {})} connectionPanel={connection.paired === false ? undefined : connection.state === 'unavailable'
        ? <><p>请核对 Mac 的连接与授权，修复后重新检查。</p><button type="button" onClick={() => retryConnection(value => value + 1)}>重新检查连接</button></>
        : <p>连接会自动恢复。Mac 和手机保持在同一局域网即可。</p>} />
  </MobileWebCatalogObservation.Provider></MobileWebUpdateSafetyProvider>
}
