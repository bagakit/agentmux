import { fixtureClock as _hygiene_fixtureClock, fixtureIso as _hygiene_fixtureIso, fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import type { ContinuousProgressLoop } from '@agentmux/core'
import { ContinuousProgressControl } from '../../../src/renderer/src/components/ContinuousProgressControl'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { ComposerTextarea } from '../../../src/renderer/src/components/ComposerTextarea'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import '../../../src/renderer/src/styles/tokens.css'
import '../../../src/renderer/src/styles/base.css'
import '../../../src/renderer/src/styles/agent.css'
import './ui-scene.css'

const target = { hostId: 'local', agentSessionId: 'private-calendar-agent', providerId: 'codex', workspacePath: _hygiene_fixturePath("private/design-project") }
const session = { id: 'display-region', kind: 'agent' as const, ...target, label: 'Design partner', executorId: 'codex', promptSubmissionPredecessor: null, agentSessionUpdatedAt: 1, createdAt: 1, updatedAt: 1, latestOutputBytes: 0, processState: 'running' as const, status: { state: 'idle' as const, source: 'native-protocol' as const, observedAt: 1 }, capabilities: { terminal: true as const, timeline: 'complete-events' as const, permission: 'observe' as const, providerResume: true, replyCorrelation: 'none' as const }, control: { kind: 'agent' as const, hostId: target.hostId, agentSessionId: target.agentSessionId, run: { runId: 'private-run' } } }
let schedule: ContinuousProgressLoop = { ...target, loopId: 'saved-calendar', intervalMs: 60000, prompt: '明早一起看一下设计方案：先问我今天最需要确认的一件事。\n保留本会话中的决定，不要替我承诺未确认的进度。', calendar: { kind: 'daily', timezone: 'Asia/Shanghai', time: _hygiene_fixtureClock(9, 0), policies: { gap: 'skip', fold: 'earlier', monthEnd: 'clamp', overdue: 'latest' } }, status: 'active', revision: 1, creationOperationId: 'private-original', futureIntentId: 'saved-calendar-1', nextCheckAt: Date.parse(_hygiene_fixtureIso(24195600000, "minute")) }
const listeners = new Set<(loop: ContinuousProgressLoop) => void>(), operations: unknown[] = []
const receipt = () => ({ schedule, diskDurability: 'confirmed' as const, executionScope: 'connected-host' as const })
api.continuousProgress.list = async () => []
api.continuousProgress.onChanged = () => () => {}
api.schedule.list = async () => ({ schedules: [schedule], executionScope: 'connected-host' })
api.schedule.onChanged = listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
api.schedule.create = async params => { operations.push({ method: 'create', params }); throw new Error('The connected Host receipt is unavailable. The original operation has been retained.') }
api.schedule.inspect = async params => { operations.push({ method: 'inspect', params }); return receipt() }
api.schedule.pause = async params => { operations.push({ method: 'pause', params }); schedule = { ...schedule, status: 'paused', revision: params.expectedRevision + 1, lastMutation: { ...params, action: 'pause' }, lastDecision: 'Paused by you.' }; listeners.forEach(listener => listener(schedule)); return receipt() }
api.schedule.resume = async params => { operations.push({ method: 'resume', params }); schedule = { ...schedule, status: 'active', revision: params.expectedRevision + 1, lastMutation: { ...params, action: 'resume' } }; return receipt() }
api.schedule.cancel = async params => { operations.push({ method: 'cancel', params }); schedule = { ...schedule, status: 'stopped', revision: params.expectedRevision + 1, lastMutation: { ...params, action: 'cancel' } }; return receipt() }
useAppStore.setState({ config: { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], executors: {}, workspaces: [{ id: 'private-project', name: 'Design project', hostId: 'local', path: target.workspacePath, kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }, sessions: [session], error: null })
function Scene() {
  const [draft, setDraft] = useState('这段手动消息还没发，请保留。')
  return <DesktopClientUiProvider><main className="schedule-scene"><header>Design partner <span>Progress</span></header><div className="schedule-scene__body"><ContinuousProgressControl session={session} /></div><footer><label>Manual message<ComposerTextarea aria-label="Manual message" value={draft} onValueChange={setDraft} /></label></footer></main></DesktopClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Scene />)
Object.assign(window, { scheduleScene: { operations } })
