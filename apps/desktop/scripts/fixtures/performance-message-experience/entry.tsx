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
import type { SessionMailReading } from '../../../src/renderer/src/lib/use-session-messages'
import type { AgentMuxMessageMetadata, DurableAgentMuxMessage } from '@agentmux/core'
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
const reference = { hostId: 'local', agentSessionId: 'Design review' }
const originalMessages: DurableAgentMuxMessage[] = [{
  sequence: 2,
  envelope: { schema: 'agentmux.a2a.v1', messageId: 'agent-inbox', operationId: 'operation-agent-inbox', createdAt: 2000,
    sender: { kind: 'agent-session', agentSessionId: 'Research reviewer' }, recipient: { kind: 'agent-session', agentSessionId: reference.agentSessionId },
    senderSessionId: 'Research reviewer', recipientSessionId: reference.agentSessionId, senderRunId: 'run-research', recipientRunId: 'run-design',
    threadId: 'thread-design', correlationId: 'correlation-design', replyTo: null, workspaceId: null,
    body: 'The revised hierarchy is much clearer. I would keep the selected sample visible and let the supporting details stay quiet.' },
  delivery: { state: 'delivered', at: 2100 }
}, {
  sequence: 1,
  envelope: { schema: 'agentmux.a2a.v1', messageId: 'agent-outbox', operationId: 'operation-agent-outbox', createdAt: 1000,
    sender: { kind: 'agent-session', agentSessionId: reference.agentSessionId }, recipient: { kind: 'agent-session', agentSessionId: 'Research reviewer' },
    senderSessionId: reference.agentSessionId, recipientSessionId: 'Research reviewer', senderRunId: 'run-design', recipientRunId: 'run-research',
    threadId: 'thread-design', correlationId: 'correlation-design', replyTo: null, workspaceId: null,
    body: 'Please review the original interaction receipts and keep the reading layout stable while the selection moves.' },
  delivery: { state: 'accepted', at: 1100 }
}]
function metadata(value: DurableAgentMuxMessage): AgentMuxMessageMetadata {
  const { body, ...envelope } = value.envelope
  return { sequence: value.sequence, envelope, delivery: value.delivery, bodyPreview: body.slice(0, 240), bodyBytes: new TextEncoder().encode(body).byteLength }
}
const originalMail: SessionMailReading = {
  identity: 'controlled-design-review', runtimeId: 'runtime-design-review', reference,
  list: async ({ direction }) => ({ hostId: reference.hostId, participantSessionId: reference.agentSessionId, direction,
    messages: originalMessages.filter(message => direction === 'incoming' ? message.envelope.recipientSessionId === reference.agentSessionId && message.envelope.senderSessionId !== reference.agentSessionId
      : message.envelope.senderSessionId === reference.agentSessionId && message.envelope.recipientSessionId !== reference.agentSessionId).map(metadata), nextBeforeSequence: null }),
  read: async messageId => ({ hostId: reference.hostId, message: structuredClone(originalMessages.find(message => message.envelope.messageId === messageId)!) }),
  dispatches: async () => ({ hostId: reference.hostId, participantSessionId: reference.agentSessionId, dispatches: [], nextSourceMessageId: null }),
  dispatch: async () => { throw Error('This controlled reading has no Dispatch record.') }
}
function renderMessages() {
  flushSync(() => root.render(<DesktopClientUiProvider><div className="composer experience-composer"><SessionMailbox system={notices} originalMail={originalMail}
    queued={[{ id: 'hierarchy-pass', text: 'Tighten the visual hierarchy once more, then keep this exact input available for review.', enqueuedAt: 3000,
      status: 'queued', deliverable: true, editable: true, awaitingExplicitSend: true }]}
    onSendQueued={id => actions.push(`send:${id}`)} onCopyQueued={async text => { actions.push(`copy:${text.length}`); return true }}
    timeline={{ agentSessionId: 'Design review', revision: 1, items: [] }}
    progressUnavailable={{ message: 'Automation metadata is not confirmed.', onRefresh: () => actions.push('refresh-automation') }} /></div></DesktopClientUiProvider>))
}
Object.assign(window, { experienceReview: { ready: true, actions, performance: restorePerformance, publishPerformance, missingPerformance, messages: renderMessages,
  theme: (appAppearance: 'light' | 'dark') => updateThemeSelection({ ...config.appearance, appAppearance }) } })
renderPerformance()
