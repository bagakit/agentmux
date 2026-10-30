// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
vi.mock('../src/renderer/src/components/AgentAvatar', () => ({ AgentAvatar: () => <span /> }))
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'

const initial = useAppStore.getState(), neighbor = composerSession('healthy-neighbor'), target = composerSession('retained-original')
let root: Root, container: HTMLDivElement
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)!
const dialog = () => document.querySelector('[role="dialog"]')
function Scene({ active = true }: { active?: boolean }) {
  const session = useAppStore(state => state.sessions.find(session => session.id === target.id))!
  return <WorkbenchPresentationContext.Provider value={{ active, retainedRegionId: null }}>
    <FocusContextRow context={agentContextForSession(session, undefined, 'Original retained Agent')} selected onSelect={() => {}} />
  </WorkbenchPresentationContext.Provider>
}
async function open() {
  const origin = container.querySelector<HTMLButtonElement>('button[data-session-id]')!
  await act(async () => { origin.focus(); origin.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })) })
  await settle()
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Stop Agent')!
  expect(item).toBeTruthy(); await act(async () => item.click()); await settle()
  expect(dialog()).not.toBeNull()
}
function preserved(before: ReturnType<typeof useAppStore.getState>) {
  const current = useAppStore.getState()
  for (const key of ['sessions', 'tabs', 'layouts', 'agentComposerDrafts', 'agentFocus', 'timelines'] as const) expect(current[key]).toBe(before[key])
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState({ ...initial, config: composerConfig, sessions: [neighbor, target],
    agentNames: { [target.id]: 'Original retained Agent' }, timelines: {}, tabs: {}, layouts: {}, scratchTopicSnapshots: {},
    mainSurface: 'agents', agentComposerDrafts: { [target.id]: 'Unsent original draft' }, error: null }, true)
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(<Scene />))
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('an already-exited retained Session can explicitly close through the original Core control', async () => {
  await act(async () => useAppStore.setState({ sessions: [neighbor, { ...target, processState: 'exited' }] }))
  const before = useAppStore.getState(); await open()
  expect(dialog()?.textContent).toContain('Close Agent?')
  expect(dialog()?.textContent).toContain('Current Run: exited.')
  expect(dialog()?.textContent).toContain('conversation history stays available')
  await act(async () => button('Close Agent').click()); await settle()
  expect(api.sessions.stop).toHaveBeenCalledExactlyOnceWith(target.control)
  expect(dialog()).toBeNull(); preserved(before)
})

it('an unobserved original Run keeps its explicit Stop capability and does not advertise cached exit as current', async () => {
  await act(async () => useAppStore.setState({ sessions: [neighbor, { ...target, processState: 'exited', runUnobserved: true }] }))
  await open()
  expect(dialog()?.textContent).toContain('current state is unknown')
  expect(dialog()?.textContent).not.toContain('Current Run: exited')
  expect(dialog()?.textContent).not.toContain('already ended')
  await act(async () => button('Stop Agent').click()); await settle()
  expect(api.sessions.stop).toHaveBeenCalledExactlyOnceWith(target.control)
})

it('a lost Stop receipt retains a persistent current-state notice and explicitly continues the same frozen target', async () => {
  vi.mocked(api.sessions.stop).mockRejectedValueOnce(new Error('Original stop receipt unavailable'))
  await open(); const before = useAppStore.getState()
  await act(async () => button('Stop Agent').click()); await settle()
  expect(dialog()?.textContent).toContain('Stop not confirmed')
  expect(dialog()?.textContent).toContain('Original stop receipt unavailable')
  expect(dialog()?.textContent).toContain('Current Run: running.')
  expect(dialog()?.textContent).toContain('Cancel only closes this notice')
  expect(button('Continue Stop').disabled).toBe(false); preserved(before)
  await act(async () => button('Continue Stop').click()); await settle()
  expect(api.sessions.stop).toHaveBeenCalledTimes(2)
  for (const [control] of vi.mocked(api.sessions.stop).mock.calls) expect(control).toEqual(target.control)
  expect(dialog()).toBeNull(); preserved(before)
})

it('dismissing a failed Stop notice neither cancels nor automatically replays that operation', async () => {
  vi.mocked(api.sessions.stop).mockRejectedValueOnce(new Error('Receipt still unknown'))
  await open(); await act(async () => button('Stop Agent').click()); await settle()
  const before = useAppStore.getState()
  await act(async () => button('Cancel').click()); await settle()
  expect(dialog()).toBeNull(); expect(api.sessions.stop).toHaveBeenCalledTimes(1); preserved(before)
})

it('a replacement Run is kept and cannot be stopped through the old continuation', async () => {
  vi.mocked(api.sessions.stop).mockRejectedValueOnce(new Error('Receipt unknown'))
  await open(); await act(async () => button('Stop Agent').click()); await settle()
  await act(async () => useAppStore.setState({ sessions: [neighbor, { ...target, control: { ...target.control, run: { runId: 'replacement-run' } } }] }))
  const before = useAppStore.getState()
  await act(async () => button('Continue Stop').click()); await settle()
  expect(api.sessions.stop).toHaveBeenCalledTimes(1)
  expect(dialog()?.textContent).toContain('original Run is no longer confirmed')
  expect(dialog()?.textContent).toContain('current state is unknown'); preserved(before)
})

it('a late successful receipt does not invent a retired state or replace a later chosen Run', async () => {
  let complete!: () => void
  vi.mocked(api.sessions.stop).mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  await open(); await act(async () => button('Stop Agent').click())
  expect(dialog()?.getAttribute('aria-busy')).toBe('true')
  await act(async () => useAppStore.setState({ sessions: [neighbor, { ...target, control: { ...target.control, run: { runId: 'later-run' } } }] }))
  const before = useAppStore.getState()
  await act(async () => complete()); await settle()
  expect(dialog()).toBeNull(); expect(api.sessions.stop).toHaveBeenCalledTimes(1); preserved(before)
})


it('the actual placeless Focus surface preserves history access while the cached process is unobserved', async () => {
  await act(async () => {
    useAppStore.setState({ sessions: [neighbor, { ...target, processState: 'exited', runUnobserved: true }],
      focusView: 'list', agentFocus: { execution: { sessionId: target.id, history: [] }, pmo: { sessionId: null } } })
    root.render(<GlobalFocusSurface presentation={{ projection: null, issue: 'No confirmed occurrence', references: [] }} />)
  })
  const notice = container.querySelector('.focus-location-recovery')
  expect(notice?.textContent).toContain('current Run state is unknown')
  expect(notice?.textContent).not.toContain('Its Run is exited')
  expect(notice?.textContent).toContain('Open the original conversation in a new Tab')
  expect(notice?.querySelector('[data-focus-open-placeless]')).not.toBeNull()
})


it('leaving the surface during Stop releases its observer and a late failure cannot resurrect a hidden confirmation', async () => {
  const originalSubscribe = useAppStore.subscribe
  let listeners = 0
  vi.spyOn(useAppStore, 'subscribe').mockImplementation(listener => { listeners++; const release = originalSubscribe(listener); return () => { listeners--; release() } })
  let reject!: (error: Error) => void
  vi.mocked(api.sessions.stop).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  await open(); await act(async () => button('Stop Agent').click())
  expect(listeners).toBe(1)
  await act(async () => root.render(<Scene active={false} />)); await settle()
  expect(dialog()).toBeNull(); expect(listeners).toBe(0)
  await act(async () => reject(new Error('Original late Stop timeout'))); await settle()
  expect(listeners).toBe(0)
  expect(useAppStore.getState().errorNoticeContext?.subject).toEqual(target.control)
  expect(useAppStore.getState().error).toContain('Original late Stop timeout')
  await act(async () => root.render(<Scene />)); await settle()
  expect(dialog()).toBeNull(); expect(listeners).toBe(0)
  expect(api.sessions.stop).toHaveBeenCalledTimes(1)
})

it('an old failed observer reports its original subject without attaching feedback to a later confirmation', async () => {
  let reject!: (error: Error) => void
  vi.mocked(api.sessions.stop).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  await open(); await act(async () => button('Stop Agent').click())
  await act(async () => root.render(<Scene active={false} />)); await settle()
  await act(async () => root.render(<Scene />)); await settle(); await open()
  await act(async () => reject(new Error('Old observer failure must stay with the old request'))); await settle()
  expect(dialog()?.textContent).not.toContain('Old observer failure')
  expect(dialog()?.textContent).not.toContain('Stop not confirmed')
  expect(button('Stop Agent').disabled).toBe(false)
  expect(useAppStore.getState().errorNoticeContext?.subject).toEqual(target.control)
  expect(useAppStore.getState().error).toContain('Old observer failure')
  expect(api.sessions.stop).toHaveBeenCalledTimes(1)
})
