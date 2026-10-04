// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SpaceObjectIcon } from '../src/renderer/src/components/SpaceObjectIcon'
import { DEFAULT_MOTE_FACE } from '../src/shared/mote-avatars'
import { PMO_TEAMS_TOPIC_ID } from '../src/shared/scratch-topics'
import { defaultAgent } from './fixtures/mote-workface'
import { useAppStore } from '../src/renderer/src/store'
let root: Root, container: HTMLDivElement, commits: number, reduced: boolean
let intersections: Map<Element, (visible: boolean) => void>, changes: Set<() => void>
const before = useAppStore.getState()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(100000)
  vi.spyOn(Math, 'random').mockReturnValue(.43)
  reduced = false; commits = 0; intersections = new Map(); changes = new Set()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private listener: IntersectionObserverCallback) {}
    observe(node: Element) { const emit = (visible: boolean) => this.listener([{ target: node, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as IntersectionObserverEntry], this as unknown as IntersectionObserver); intersections.set(node, emit); emit(true) }
    unobserve(node: Element) { intersections.delete(node) }
    disconnect() { intersections.clear() }
  })
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ media: query, get matches() { return reduced }, addEventListener(_type: string, callback: () => void) { changes.add(callback) }, removeEventListener(_type: string, callback: () => void) { changes.delete(callback) } } as MediaQueryList))
  useAppStore.setState({ sessions: [], timelines: {} })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); expect(vi.getTimerCount()).toBe(0); expect(changes.size).toBe(0)
  container.remove(); useAppStore.setState(before, true); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function mount(node: React.ReactNode) { await act(async () => root.render(<Profiler id="original-avatar" onRender={() => commits++}>{node}</Profiler>)) }
const face = (visible = true, session = false) => <SpaceObjectIcon kind="mote" name="Original authored identity" manualIcon={DEFAULT_MOTE_FACE} visible={visible} {...(session ? { moteSessionId: defaultAgent.id, moteHostId: defaultAgent.hostId } : {})} />
function node() { return container.querySelector<HTMLElement>('[data-mote-expression]')! }
function gestures(milliseconds: number) {
  const seen: string[] = []
  for (let i = 0; i < milliseconds / 100; i++) { vi.advanceTimersByTime(100); const gesture = node().dataset.moteGesture; if (gesture && seen.at(-1) !== gesture) seen.push(gesture) }
  return seen
}
it('varies gestures without pointer input or React frames, and keeps the original saved face and drafts intact', async () => {
  await mount(<>{face()}<SpaceObjectIcon kind="mote" name="Main dragon" manualIcon={null} avatarTopicId={PMO_TEAMS_TOPIC_ID} /></>)
  const count = commits, state = useAppStore.getState(), painted = container.querySelector('svg')!.outerHTML
  const seen = gestures(45000)
  expect(new Set(seen).size).toBeGreaterThan(1); expect(seen.length).toBeGreaterThan(2)
  expect(seen.every((value,index) => !index || value !== seen[index-1])).toBe(true)
  expect(vi.getTimerCount()).toBe(1); expect(commits).toBe(count)
  expect(container.querySelector('svg')!.outerHTML).toBe(painted)
  expect(useAppStore.getState().spaceObjectIcons).toBe(state.spaceObjectIcons)
  expect(useAppStore.getState().agentComposerDrafts).toBe(state.agentComposerDrafts)
  expect(node().dataset.moteExpression).toBe('identity')
})
it('cancels offscreen, hidden, reduced and page-hidden gesture work; forty hidden identities add no timer or geometry reads', async () => {
  await mount(<>{face()}{Array.from({ length: 40 }, (_,i) => <div key={i}>{face(false)}</div>)}</>)
  const read = vi.spyOn(Element.prototype, 'getBoundingClientRect'), visible = node()
  expect(intersections.size).toBe(1); expect(vi.getTimerCount()).toBe(1)
  expect(gestures(4500).length).toBeGreaterThan(0)
  intersections.get(visible)!(false); expect(visible.dataset.moteGesture).toBeUndefined(); expect(vi.getTimerCount()).toBe(0)
  vi.advanceTimersByTime(60000); expect(read).not.toHaveBeenCalled()
  intersections.get(visible)!(true); reduced = true; changes.forEach(change => change())
  expect(vi.getTimerCount()).toBe(0); expect(visible.dataset.moteMotion).toBe('off')
  reduced = false; changes.forEach(change => change()); expect(vi.getTimerCount()).toBe(1)
  const descriptor = Object.getOwnPropertyDescriptor(document, 'hidden')
  try {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'))
    expect(vi.getTimerCount()).toBe(0); expect(visible.dataset.moteGesture).toBeUndefined()
    vi.advanceTimersByTime(60000); expect(read).not.toHaveBeenCalled()
  } finally { if (descriptor) Object.defineProperty(document, 'hidden', descriptor); else delete (document as unknown as Record<string, unknown>).hidden; document.dispatchEvent(new Event('visibilitychange')) }
  await mount(face(false)); expect(vi.getTimerCount()).toBe(0)
})
it('uses original authoritative expressions and clears an old gesture immediately when state changes', async () => {
  useAppStore.setState({ sessions: [{ ...defaultAgent, status: { state: 'done', source: 'native-hook', observedAt: 100 } }] })
  await mount(face(true, true))
  expect(node().dataset.moteExpression).toBe('idle'); expect(gestures(4500).length).toBeGreaterThan(0)
  for (const [state, expected, allowed] of [
    ['working','thinking',['ponder','double-blink']], ['waiting','waiting',['blink','attentive']],
    ['running','unknown',['blink']], ['starting','starting',['wake']], ['error','error',[]], ['exited','stopped',[]]
  ] as const) {
    await act(async () => useAppStore.setState({ sessions: [{ ...defaultAgent, status: { state, source: 'native-hook', observedAt: Date.now() } }] }))
    expect(node().dataset.moteGesture).toBeUndefined(); expect(node().dataset.moteExpression).toBe(expected)
    const seen = gestures(12000)
    expect(seen.length > 0).toBe(allowed.length > 0); expect(seen.every(value => (allowed as readonly string[]).includes(value))).toBe(true)
  }
})
