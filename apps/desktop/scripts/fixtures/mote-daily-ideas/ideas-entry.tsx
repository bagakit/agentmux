import '../mote-companion-workflows/persona-entry'
import { createRoot } from 'react-dom/client'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { AgentSessionComposer } from '../../../src/renderer/src/components/AgentSessionComposer'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import type { ContinuousProgressLoop, ScheduleParamsMap } from '@agentmux/core'

let schedules: ContinuousProgressLoop[] = [], lostReceipt = false, notFound = false
const calls: { method: string; params: unknown }[] = []
const listeners = new Set<(schedule: ContinuousProgressLoop) => void>()
api.schedule.list = async params => { calls.push({ method: 'schedule.list', params }); return { schedules, executionScope: 'connected-host' } }
api.schedule.onChanged = listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
api.schedule.create = async (params: ScheduleParamsMap['schedule.create']) => {
  calls.push({ method: 'schedule.create', params })
  const previous = schedules.find(item => item.creationOperationId === params.operationId)
  const schedule = previous ?? { ...params.target, calendar: params.calendar, prompt: params.prompt, creationOperationId: params.operationId,
    loopId: 'fixture-original-arrangement', intervalMs: 60000, revision: 1, status: 'active' as const, nextCheckAt: Date.now() + 3600000 }
  schedules = [schedule]
  if (lostReceipt) { lostReceipt = false; throw new Error('The saved arrangement receipt is unavailable. Your original request is kept.') }
  return { schedule, diskDurability: 'confirmed', executionScope: 'connected-host' }
}
api.schedule.inspect = async params => {
  calls.push({ method: 'schedule.inspect', params })
  return { schedule: notFound ? null : schedules.find(item => item.creationOperationId === params.operationId) ?? null, executionScope: 'connected-host' }
}
const mutate = (action: 'pause' | 'resume' | 'cancel') => async (params: ScheduleParamsMap['schedule.pause']) => {
  calls.push({ method: 'schedule.' + action, params })
  const previous = schedules.find(item => item.loopId === params.scheduleId)!
  const schedule = { ...previous, status: action === 'cancel' ? 'stopped' as const : action === 'pause' ? 'paused' as const : 'active' as const,
    revision: (previous.revision ?? 0) + 1, lastMutation: { ...params, action } }
  schedules = [schedule]; listeners.forEach(listener => listener(schedule))
  return { schedule, diskDurability: 'confirmed' as const, executionScope: 'connected-host' as const }
}
api.schedule.pause = mutate('pause'); api.schedule.resume = mutate('resume'); api.schedule.cancel = mutate('cancel')
const sessionId = 'renderer-fixture-context'
Object.assign(window, { moteIdeaScene: {
  attachComposer: () => {
    const host = document.createElement('section'); host.dataset.originalComposer = ''; host.style.marginTop = 'auto'
    document.querySelector('.persona-scene__work')!.append(host)
    useAppStore.getState().setAgentComposerDraft(sessionId, 'My later ordinary message stays editable.')
    createRoot(host).render(<DesktopClientUiProvider><AgentSessionComposer sessionId={sessionId} /></DesktopClientUiProvider>)
  }, loseReceipt: () => { lostReceipt = true; notFound = true }, confirmOriginal: () => { notFound = false },
  unknownSaved: () => { schedules = schedules.map(schedule => ({ ...schedule, status: 'paused', lastOutcome: 'unknown', revision: (schedule.revision ?? 0) + 1,
    lastDecision: 'The original input receipt is unconfirmed. Manual messages remain available.' })); schedules.forEach(schedule => listeners.forEach(listener => listener(schedule))) },
  facts: () => ({ calls, schedules, draft: useAppStore.getState().agentComposerDrafts[sessionId] })
} })
