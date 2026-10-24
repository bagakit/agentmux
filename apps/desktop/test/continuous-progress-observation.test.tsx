// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render.js'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture.js'
import { ContinuousProgressControl } from '../src/renderer/src/components/ContinuousProgressControl.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { api } from '../src/renderer/src/lib/api.js'
import type { ContinuousProgressLoop } from '@agentmux/core/continuous-progress-scheduler'

const initial = useAppStore.getState(), original = composerSession()
const session = { ...original, control: { ...original.control, agentSessionId: 'observed-agent' } }
const other = { ...original, id: 'unrelated-session', control: { ...original.control, agentSessionId: 'unrelated-agent' } }
const target = { hostId: session.control.hostId, agentSessionId: session.control.agentSessionId, providerId: session.providerId, workspacePath: session.workspacePath }
const active: ContinuousProgressLoop = { ...target, loopId: 'original-loop', intervalMs: 60_000, prompt: 'Original arrangement', status: 'active', nextCheckAt: 1 }
let root: Root, container: HTMLDivElement, hidden: boolean
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  hidden = false; vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  useAppStore.setState(initial, true); useAppStore.setState({ config: structuredClone(composerConfig) })
  vi.spyOn(api.schedule, 'list').mockResolvedValue({ schedules: [] })
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([active])
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.useRealTimers(); useAppStore.setState(initial, true) })
async function render(visible: boolean) { await act(async () => root.render(<><ContinuousProgressControl session={session} presented visible={visible} /><ContinuousProgressControl session={other} presented visible={false} /></>)) }
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

it('only the visible Session reads periodically, retains hidden state and refreshes immediately when presented or foregrounded', async () => {
  await render(false); await advance(15_000)
  expect(api.continuousProgress.list).not.toHaveBeenCalled(); expect(api.schedule.list).not.toHaveBeenCalled()
  await render(true)
  expect(api.continuousProgress.list).toHaveBeenCalledExactlyOnceWith(target)
  await advance(5000); expect(api.continuousProgress.list).toHaveBeenCalledTimes(2)
  await render(false); await advance(15_000)
  expect(api.continuousProgress.list).toHaveBeenCalledTimes(2)
  expect(container.querySelector('[data-progress-state]')?.getAttribute('data-progress-state')).toBe('active')
  await render(true); expect(api.continuousProgress.list).toHaveBeenCalledTimes(3)
  hidden = true; await act(async () => document.dispatchEvent(new Event('visibilitychange'))); await advance(15_000)
  expect(api.continuousProgress.list).toHaveBeenCalledTimes(3)
  hidden = false; await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(api.continuousProgress.list).toHaveBeenCalledTimes(4)
  expect(vi.mocked(api.continuousProgress.list).mock.calls.every(([scope]) => scope.agentSessionId === target.agentSessionId)).toBe(true)
})

it('one target read stays in flight and its late snapshot cannot overwrite the actual action receipt or a reopened consumer', async () => {
  await render(true)
  let complete!: (value: ContinuousProgressLoop[]) => void
  vi.mocked(api.continuousProgress.list).mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  await advance(5000); await advance(15_000)
  expect(api.continuousProgress.list).toHaveBeenCalledTimes(2)
  const paused = { ...active, status: 'paused' as const }
  vi.spyOn(api.continuousProgress, 'action').mockResolvedValue(paused)
  await act(async () => (container.querySelector('[aria-label="Pause continuous progress"]') as HTMLButtonElement).click())
  expect(container.querySelector('[data-progress-state]')?.getAttribute('data-progress-state')).toBe('paused')
  let finishNext!: (value: ContinuousProgressLoop[]) => void
  vi.mocked(api.continuousProgress.list).mockImplementationOnce(() => new Promise(resolve => { finishNext = resolve }))
  await act(async () => complete([active]))
  expect(api.continuousProgress.list).toHaveBeenCalledTimes(3)
  expect(container.querySelector('[data-progress-state]')?.getAttribute('data-progress-state')).toBe('paused')
  await render(false); await render(true)
  expect(api.continuousProgress.list).toHaveBeenCalledTimes(3)
  vi.mocked(api.continuousProgress.list).mockResolvedValue([paused])
  await act(async () => finishNext([active]))
  expect(api.continuousProgress.list).toHaveBeenCalledTimes(4)
  expect(container.querySelector('[data-progress-state]')?.getAttribute('data-progress-state')).toBe('paused')
})
