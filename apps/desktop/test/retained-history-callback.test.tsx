// @vitest-environment happy-dom
import { act, type ComponentProps, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { SessionActivityPresentation } from '../src/renderer/src/components/SessionActivityPresentation'
import type { ActivityView } from '../src/renderer/src/components/ActivityView'
import { workbenchSessionStageHostId } from '../src/renderer/src/lib/workbench-presentation'

// Count entry into the reading body. The real retained-view, current controls and
// placement owners run; transcript parsing and native Runtime control are outside this fixture.
type ActivityProps = ComponentProps<typeof ActivityView>
const probe = vi.hoisted(() => ({ renders: 0, latest: undefined as ActivityProps | undefined }))
vi.mock('../src/renderer/src/components/ActivityView', () => ({ ActivityView: (props: ActivityProps) => {
  probe.renders++; probe.latest = props
  return <div data-retained-history-body="">Original retained body</div>
} }))
const control = { kind: 'agent' as const, hostId: 'local', agentSessionId: 'retained-history-agent', run: { runId: 'retained-history-run' } }
const original = { displayWorkspaceId: 'retained-workspace', groupId: 'retained-group', tabId: 'retained-tab', regionId: 'retained-region' }
const resourceOrigin = { workspaceId: original.displayWorkspaceId, tabId: original.tabId, regionId: original.regionId }
const retainedHeader = <header>Original Agent</header>
const renderFrame = (content: ReactNode) => content
let root: ReturnType<typeof createClientUiRoot>
let container: HTMLDivElement
const slots = new Map<string, HTMLDivElement>()
let onCloseHistory: ReturnType<typeof vi.fn>, selectRegion: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  probe.renders = 0; probe.latest = undefined
  onCloseHistory = vi.fn(); selectRegion = vi.fn()
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  for (const slot of slots.values()) slot.remove()
  slots.clear(); vi.unstubAllGlobals()
})
async function render(visible: boolean, options: { regionId?: string; semantic?: 'active' | 'unknown'; close?: () => void; select?: () => void } = {}) {
  const regionId = options.regionId ?? original.regionId
  const target = { hostId: 'retained-focus', active: true, visible, surface: 'focus' as const, reference: { ...original, regionId } }
  const hostId = workbenchSessionStageHostId(target, regionId)
  if (!slots.has(hostId)) { const slot = document.createElement('div'); slot.id = hostId; document.body.append(slot); slots.set(hostId, slot) }
  await act(async () => root.render(<SessionActivityPresentation target={target} regionId={regionId}
    sourceKey="original-source" sessionId={control.agentSessionId} name="Original Agent" executorLabel="Executor"
    executionHost={{ configured: true, id: 'local', cwd: '', label: 'Local', kind: 'local' }} header={retainedHeader}
    historyOpen onCloseHistory={options.close ?? onCloseHistory} selectRegion={options.select ?? selectRegion}
    activity={{ sessionId: control.agentSessionId, items: [], capability: 'complete-events', activitySemantic: options.semantic ?? 'active',
      conversationReading: { reference: control, identity: control.run.runId, enabled: visible } }}
    eligible readOnly={false} resourceOrigin={resourceOrigin} renderFrame={renderFrame} />))
  return slots.get(hostId)!
}
it('keeps an opened hidden History body idle when only parent callback closures change', async () => {
  const slot = await render(true), body = slot.querySelector('[data-retained-history-body]')
  expect(body).not.toBeNull()
  await render(false)
  const before = probe.renders
  for (let i = 0; i < 8; i++) await render(false, { close: () => {}, select: () => {} })
  expect(probe.renders - before).toBe(0)
  expect(slot.querySelector('[data-retained-history-body]')).toBe(body)
  expect(probe.latest?.conversationReading?.enabled).toBe(false)
})
it('the retained Return action consumes current close and selection callbacks without waking the hidden body', async () => {
  await render(true); await render(false)
  const retainedReturn = probe.latest?.conversationReading?.onClose
  expect(retainedReturn).toBeTypeOf('function')
  const before = probe.renders, currentClose = vi.fn(), currentSelect = vi.fn()
  await render(false, { close: currentClose, select: currentSelect })
  expect(probe.renders - before).toBe(0)
  await act(async () => retainedReturn!())
  expect(currentClose).toHaveBeenCalledExactlyOnceWith()
  expect(currentSelect).toHaveBeenCalledExactlyOnceWith()
  expect(onCloseHistory).not.toHaveBeenCalled()
  expect(selectRegion).not.toHaveBeenCalled()
})
it('retained History still consumes real semantic and display placement changes', async () => {
  const originalSlot = await render(true), body = originalSlot.querySelector('[data-retained-history-body]')
  expect(body).not.toBeNull(); await render(false)
  const before = probe.renders
  await render(false, { semantic: 'unknown' })
  expect(probe.renders).toBeGreaterThan(before)
  expect(probe.latest?.activitySemantic).toBe('unknown')
  const beforeMove = probe.renders
  const movedSlot = await render(false, { semantic: 'unknown', regionId: 'moved-region' })
  expect(probe.renders).toBeGreaterThan(beforeMove)
  expect(probe.latest?.conversationReading?.consumer?.regionId).toBe('moved-region')
  expect(probe.latest?.conversationReading?.enabled).toBe(false)
  expect(probe.latest?.conversationReading?.opened).toBe(true)
  expect(movedSlot.querySelector('[data-retained-history-body]')).toBe(body)
})
