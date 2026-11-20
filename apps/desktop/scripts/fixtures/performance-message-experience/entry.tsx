import { useMemo, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { PerformanceOverview } from '../../../src/renderer/src/components/performance/PerformanceOverview'
import { ToolkitPopoverSurface } from '../../../src/renderer/src/components/performance/PerformancePopover'
import { SessionMailbox } from '../../../src/renderer/src/components/SessionMailbox'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import type { ToolkitMetricsSnapshot } from '../../../src/shared/toolkit'
import type { useServiceNotices } from '../../../src/renderer/src/lib/use-service-notices'
import { performanceAttributionSnapshots } from '../performance-panel/data'
import '../../../src/renderer/src/styles/index.css'

const config = await api.config.get()
useAppStore.setState({ config, loading: false, sessions: [], noticeReadReceipts: {} })
mountThemeRuntime(window, { ...config.appearance, appAppearance: 'dark' })
const root = createRoot(document.getElementById('root')!)
const actions: string[] = []
let snapshot = structuredClone(performanceAttributionSnapshots.fresh), paused = false

function PerformanceSurface() {
  const panel = useRef<HTMLDivElement>(null)
  const surface = useMemo(() => ({ panel, setResizable() {} }), [])
  return <DesktopClientUiProvider><ToolkitPopoverSurface.Provider value={surface}>
    <div ref={panel} className="performance-popover experience-performance" role="dialog" aria-label="Performance">
      <PerformanceOverview snapshot={snapshot} paused={paused} close={() => actions.push('close')}
        onPause={() => { paused = !paused; renderPerformance() }} onConfigure={() => actions.push('configure')} onViewScript={() => actions.push('script')} />
    </div>
  </ToolkitPopoverSurface.Provider></DesktopClientUiProvider>
}
function renderPerformance() { flushSync(() => root.render(<PerformanceSurface />)) }
function publishPerformance() {
  const next = structuredClone(snapshot) as ToolkitMetricsSnapshot
  const at = (next.observedAt ?? 0) + 1000, app = next.observation!.app.data!
  next.observedAt = at; next.observation!.observedAt = at
  next.observation!.app.observedAt = at; next.observation!.app.lastSuccessAt = at
  app.cpuPercent = app.cpuPercent === null ? null : Math.max(4, app.cpuPercent - 12.4)
  app.rssKib = app.rssKib === null ? null : app.rssKib + 32768
  next.trend = [...next.trend.slice(-59), { observedAt: at, appCpuPercent: app.cpuPercent, appRssKib: app.rssKib }]
  snapshot = next; renderPerformance()
}
function missingPerformance() {
  const next = structuredClone(performanceAttributionSnapshots.fresh) as ToolkitMetricsSnapshot
  next.executionId = 'unconfirmed-reading'
  next.observation!.app = { state: 'unavailable', data: null, observedAt: next.observation!.app.observedAt, lastSuccessAt: next.observation!.app.lastSuccessAt, reason: 'The original App reading is unavailable.' }
  next.trend = next.trend.map(point => ({ ...point, appCpuPercent: null, appRssKib: null }))
  snapshot = next; paused = false; renderPerformance()
}
function restorePerformance() {
  snapshot = structuredClone(performanceAttributionSnapshots.fresh)
  paused = false
  renderPerformance()
}
const notices: ReturnType<typeof useServiceNotices> = {
  available: true, unread: ['delivery'], acknowledge: ids => actions.push(`read:${ids.join(',')}`), notices: [{
    id: 'delivery', cause: 'delivery', observedAt: 1000,
    notice: { kind: 'indeterminate', notice: { step: 'Confirming the previous turn did not complete', mode: 'Your input is retained. Delivery as a new turn is not confirmed.', restore: 'Check the original delivery result before sending again.' } },
    summary: { step: 'Delivery needs confirmation', mode: 'Your input is safe. A new turn may not have started.', restore: 'Check the original delivery result before sending again.' },
    action: { label: 'Check delivery', run: () => actions.push('check-delivery') }
  }, {
    id: 'renderer', cause: 'renderer', observedAt: 2000,
    notice: { kind: 'process-degraded', notice: { step: 'Renderer connection interrupted', mode: 'The Agent is still running. Only the output connection needs attention.', restore: 'Reconnect the original output channel.' } },
    summary: { step: 'Output connection interrupted', mode: 'Your Agent is still running. Reconnect to resume reading.', restore: 'Reconnect the original output channel.' }
  }]
}
function renderMessages() {
  flushSync(() => root.render(<DesktopClientUiProvider><div className="composer experience-composer"><SessionMailbox system={notices} queued={[]}
    timeline={{ agentSessionId: 'Design review', revision: 1, items: [] }}
    progressUnavailable={{ message: 'Automation metadata is not confirmed.', onRefresh: () => actions.push('refresh-automation') }} /></div></DesktopClientUiProvider>))
}
Object.assign(window, { experienceReview: { ready: true, actions, performance: restorePerformance, publishPerformance, missingPerformance, messages: renderMessages,
  theme: (appAppearance: 'light' | 'dark') => updateThemeSelection({ ...config.appearance, appAppearance }) } })
renderPerformance()
