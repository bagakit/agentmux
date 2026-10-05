// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { expect, it, vi } from 'vitest'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { StableWorkbenchView } from '../src/renderer/src/components/StableWorkbenchView'
import { tabSwitchObservation } from '../src/renderer/src/lib/tab-switch-observation'

const reference = { displayWorkspaceId: 'placement-workspace', groupId: 'left', tabId: 'tab', regionId: 'region' }
const target = { ...reference, presentationId: 'space' }
const terminal = { sessionId: 'session', runId: 'run', readySinceAt: 1, visible: true, revealed: true,
  liveReady: false, acceptsInput: false, readOnly: false, replaying: true }

it.each(['address', 'host'] as const)('retains the actual placement owner on reveal but terminates on %s replacement', async replacement => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const frames = new Map<number, FrameRequestCallback>(); let serial = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++serial, callback); return serial })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  const home = document.createElement('div'), slot = document.createElement('div'), destination = document.createElement('div')
  slot.id = 'placement-home'; destination.id = 'placement-destination'; document.body.append(home, slot, destination)
  const root = createRoot(home), release = tabSwitchObservation.registerTerminal(target, () => terminal)
  const render = (visible: boolean, changed = false, moved = false) => act(async () => root.render(createElement(StableWorkbenchView, {
    key: changed && replacement === 'host' ? 'replacement-host' : 'original-host', homeId: slot.id,
    targetId: moved ? destination.id : null, active: false, visible, retainedRegionId: reference.regionId,
    reference: changed && replacement === 'address' ? { ...reference, regionId: 'replacement-region' } : reference,
    children: createElement('output', { 'data-placement-content': true }, 'retained content')
  })))
  const frame = () => { const [id, callback] = frames.entries().next().value!; frames.delete(id); callback(performance.now()) }
  try {
    await render(false)
    const content = slot.querySelector('output')
    expect(content).not.toBeNull()
    tabSwitchObservation.begin(target, 'terminal', performance.now()); tabSwitchObservation.selected(target)
    expect(tabSwitchObservation.snapshot().at(-1)).toMatchObject({ state: 'pending', pendingStage: 'placement' })
    await render(true)
    expect(slot.querySelector('output')).toBe(content)
    expect(tabSwitchObservation.snapshot().at(-1)).toMatchObject({ state: 'pending', pendingStage: 'frame' })
    frame(); frame()
    expect(tabSwitchObservation.snapshot().at(-1)).toMatchObject({ state: 'pending', pendingStage: 'input-gate' })
    // A spatial parent change retains this same exact placement owner and content.
    await render(true, false, true)
    expect(destination.querySelector('output')).toBe(content)
    expect(tabSwitchObservation.snapshot().at(-1)).toMatchObject({ state: 'pending', pendingStage: 'input-gate' })
    await render(true, true, true)
    const ended = tabSwitchObservation.snapshot().at(-1)!
    expect(ended).toMatchObject({ state: 'superseded', pendingStage: null, inputReadyMs: null })
    await render(true)
    tabSwitchObservation.observe(target)
    expect(tabSwitchObservation.snapshot().at(-1)).toEqual(ended)
    expect(frames.size).toBe(0)
  } finally {
    await act(async () => root.unmount()); release(); home.remove(); slot.remove(); destination.remove(); vi.unstubAllGlobals()
  }
})
