import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { MobileAssetsInspection, MobileAssetsLoadedReceipt } from '@agentmux/core/mobile-web'
import { mobileWebPageIdentity, type MobileWebPageIdentity } from './page-identity'
import { MobileWebReporter, type MobileWebReporterStatus } from './reporter'

type Read<T> = { pending: boolean; result: T | null; issue: string | null }
type ReadOwner<T> = Read<T> & { client: AgentMuxHostedClient | null }
export type MobileWebPageObservation = {
  page: MobileWebPageIdentity
  connected: boolean
  loaded: Read<MobileAssetsLoadedReceipt>
  inspection: Read<MobileAssetsInspection>
  reporter: MobileWebReporterStatus
  refresh(): Promise<void>
  retryReports(): void
}
/** A release belongs to this page only when the original authenticated receipt still joins. */
export function mobileWebUpdateStatus(value: MobileWebPageObservation | null | undefined): 'available' | 'current' | 'unknown' {
  if (!value?.connected || value.loaded.issue || value.inspection.issue) return 'unknown'
  const loaded = value.loaded.result, inspection = value.inspection.result, target = inspection?.client
  if (!loaded?.accepted || !inspection?.active || !target || target.availability !== 'found' || !target.loaded?.accepted ||
    !value.page.buildId || !value.page.namespaceDigest || loaded.buildId !== value.page.buildId ||
    loaded.namespaceDigest !== value.page.namespaceDigest || inspection.hostId !== loaded.hostId ||
    inspection.hostInstanceId !== loaded.hostInstanceId || target.target.devicePrincipalId !== loaded.producer.devicePrincipalId ||
    target.target.documentId !== loaded.producer.documentId || target.loaded.occurrenceId !== loaded.occurrenceId ||
    target.loaded.hostId !== loaded.hostId || target.loaded.hostInstanceId !== loaded.hostInstanceId ||
    target.loaded.producer.devicePrincipalId !== loaded.producer.devicePrincipalId || target.loaded.producer.documentId !== loaded.producer.documentId ||
    target.loaded.buildId !== loaded.buildId || target.loaded.namespaceDigest !== loaded.namespaceDigest) return 'unknown'
  return inspection.active.buildId === value.page.buildId && inspection.active.digest === value.page.namespaceDigest ? 'current' : 'available'
}
const emptyReporter: MobileWebReporterStatus = { inFlight: false, queuedCount: 0, queuedBytes: 0, droppedCount: 0, receipt: null, issue: null }
const emptyRead = { pending: false, result: null, issue: null }
const subscribeNothing = () => () => {}
const readEmptyReporter = () => emptyReporter
// This is one original document's observation owner, including IO surviving a React/client change.
let documentReporter: MobileWebReporter | undefined
export const MobileWebCatalogObservation = createContext<MobileWebReporter['observeCatalog'] | null>(null)
export const useMobileWebCatalogObservation = () => useContext(MobileWebCatalogObservation)

/** Supplemental observations never own connection availability, drafts or the client lifetime. */
export function useMobileWebObservation(client: AgentMuxHostedClient | null, enabled: boolean) {
  const page = useMemo(() => enabled ? mobileWebPageIdentity() : null, [enabled])
  const reporter = page ? documentReporter ??= new MobileWebReporter(page) : null
  const reporterStatus = useSyncExternalStore(reporter?.subscribe ?? subscribeNothing, reporter?.snapshot ?? readEmptyReporter)
  const requests = useMemo(() => ({
    loadedInput: page ? { ...page, occurrenceId: mintObjectId(), observedAt: Date.now() } : null,
    loaded: null as Promise<MobileAssetsLoadedReceipt> | null,
    loadedEpoch: -1,
    inspect: null as Promise<MobileAssetsInspection> | null,
    inspectEpoch: -1
  }), [client, page])
  const [loaded, setLoaded] = useState<ReadOwner<MobileAssetsLoadedReceipt>>({ client: null, ...emptyRead })
  const [inspection, setInspection] = useState<ReadOwner<MobileAssetsInspection>>({ client: null, ...emptyRead })
  const [loadRevision, retryLoad] = useState(0)
  const [consumer, setConsumer] = useState({ client, connected: client !== null })
  const connected = consumer.client === client ? consumer.connected : client !== null
  const mounted = useRef(false)
  const connectionEpoch = useRef(0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const current = useRef({ client, requests, connected, loaded })
  current.current = { client, requests, connected, loaded }
  useEffect(() => { reporter?.bindClient(client); reporter?.setConnected(client !== null); setConsumer({ client, connected: client !== null }) }, [reporter, client])
  useEffect(() => {
    if (!client || !reporter) return
    const release = client.onEvent(event => {
      if (!reporter.matchesClient(client) || event.type !== 'connection-state') return
      reporter.observeConnection(event)
      if (event.observationOrigin?.kind === 'runtime-connection' && event.observationOrigin.boundary === 'consumer-core') {
        connectionEpoch.current++
        current.current.connected = event.state === 'restored'
        setLoaded({ client, ...emptyRead })
        setInspection(previous => ({ ...previous, issue: '连接状态已变化，正在重新核对原页面版本。' }))
        setConsumer({ client, connected: event.state === 'restored' })
        if (event.state === 'restored') retryLoad(value => value + 1)
      }
    })
    return () => { release(); reporter.setConnected(false) }
  }, [client, reporter, requests])
  useEffect(() => {
    if (!client?.forwardRpc || !page || !requests.loadedInput || !connected) return
    const input = requests.loadedInput
    const epoch = connectionEpoch.current
    setLoaded(previous => ({ client, result: previous.client === client ? previous.result : null, pending: true, issue: null }))
    if (requests.loaded && requests.loadedEpoch !== epoch) {
      void requests.loaded.catch(() => {}).then(() => {
        if (mounted.current && current.current.requests === requests && current.current.connected && connectionEpoch.current === epoch) retryLoad(value => value + 1)
      })
      return
    }
    if (!requests.loaded) {
      const attempt = client.forwardRpc('app.mobile.assets.loaded', input).then(receipt => {
        if (receipt.producer.documentId !== input.documentId || receipt.buildId !== input.buildId || receipt.namespaceDigest !== input.namespaceDigest
          || receipt.occurrenceId !== input.occurrenceId || receipt.observedAt !== input.observedAt) throw new Error('Original loaded observation mismatch')
        return receipt
      }).finally(() => { if (requests.loaded === attempt) requests.loaded = null })
      requests.loaded = attempt; requests.loadedEpoch = epoch
    }
    void requests.loaded.then(result => {
      if (mounted.current && current.current.requests === requests && connectionEpoch.current === epoch) setLoaded({ client, result, pending: false, issue: result.accepted ? null : '页面版本观察未被接纳；原页面可继续使用，可稍后重试报送。' })
    }).catch(() => { if (mounted.current && current.current.requests === requests && connectionEpoch.current === epoch) setLoaded(previous => ({ client, result: previous.client === client ? previous.result : null,
      pending: false, issue: '页面版本报送未确认；原页面可继续使用，可重试原报送。' })) })
  }, [client, page, requests, connected, loadRevision])
  const refresh = useCallback(async () => {
    if (!mounted.current || current.current.requests !== requests) return
    const source = current.current, receipt = source.loaded.client === client ? source.loaded.result : null
    if (!client?.forwardRpc || !page || !receipt?.accepted || !source.connected) {
      setInspection(previous => ({ client, result: previous.client === client ? previous.result : null, pending: false,
        issue: '尚无准确的页面报送回执或连接暂不可用；原页面保留，未猜测设备或版本。' })); return
    }
    const target = receipt.producer
    const epoch = connectionEpoch.current
    setInspection(previous => ({ client, result: previous.client === client ? previous.result : null, pending: true, issue: null }))
    try {
      if (requests.inspect && requests.inspectEpoch !== epoch) {
        await requests.inspect.catch(() => {})
        if (mounted.current && current.current.requests === requests && current.current.connected && connectionEpoch.current === epoch) await refresh()
        return
      }
      if (!requests.inspect) {
        const attempt = client.forwardRpc('app.mobile.assets.inspect', { hostId: receipt.hostId, client: target })
          .finally(() => { if (requests.inspect === attempt) requests.inspect = null })
        requests.inspect = attempt; requests.inspectEpoch = epoch
      }
      const result = await requests.inspect
      if (!mounted.current || current.current.requests !== requests || !current.current.connected || connectionEpoch.current !== epoch) return
      if (result.hostId !== receipt.hostId || result.client?.target.devicePrincipalId !== target.devicePrincipalId || result.client.target.documentId !== target.documentId) throw new Error('Original inspection target mismatch')
      setInspection({ client, result, pending: false, issue: null })
    } catch {
      if (mounted.current && current.current.requests === requests && connectionEpoch.current === epoch) setInspection(previous => ({ client, result: previous.client === client ? previous.result : null,
        pending: false, issue: '版本查询未确认；已知观察保留，可刷新同一页面状态。' }))
    }
  }, [client, page, requests])
  useEffect(() => {
    if (!client || !connected || loaded.client !== client || !loaded.result?.accepted) return
    const check = () => { if (document.visibilityState !== 'hidden') void refresh() }
    check()
    const timer = setInterval(check, 60_000)
    document.addEventListener('visibilitychange', check)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', check) }
  }, [client, connected, loaded.client, loaded.result?.occurrenceId, loaded.result?.accepted, refresh])
  const retryReports = useCallback(() => {
    if (!mounted.current || current.current.requests !== requests) return
    reporter?.retry(); retryLoad(value => value + 1)
  }, [reporter, requests])
  const observation: MobileWebPageObservation | null = page ? { page, connected,
    loaded: loaded.client === client ? loaded : emptyRead,
    inspection: inspection.client === client ? inspection : emptyRead,
    reporter: reporterStatus, refresh, retryReports } : null
  const observeCatalog = useCallback<MobileWebReporter['observeCatalog']>(catalog => {
    if (client && reporter?.matchesClient(client)) reporter.observeCatalog(catalog)
  }, [reporter, client])
  return { observation, observeCatalog: reporter ? observeCatalog : null }
}
