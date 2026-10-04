import { expect, it, vi } from 'vitest'
import type { RendererTabSwitchTarget, RendererTabSwitchTerminal } from '@agentmux/core/control'
import { createTabSwitchObservation } from '../src/renderer/src/lib/tab-switch-observation'

const target: RendererTabSwitchTarget = { presentationId: 'space', displayWorkspaceId: 'workspace', groupId: 'left', tabId: 'tab', regionId: 'region' }
const ready: RendererTabSwitchTerminal = { sessionId: 'session', runId: 'run', readySinceAt: 1,
  visible: true, revealed: true, liveReady: true, acceptsInput: true, readOnly: false, replaying: false }
function fixture() {
  let time = 100, next = 0
  const frames = new Map<number, FrameRequestCallback>(), all = new Map<number, FrameRequestCallback>()
  const cancel = vi.fn((id: number) => { frames.delete(id) })
  const costs = createTabSwitchObservation(() => time, () => 1_000 + time, cb => { frames.set(++next, cb); all.set(next, cb); return next }, cancel)
  return { costs, frames, all, cancel, advance(ms: number) { time += ms }, frame() { const [id, cb] = frames.entries().next().value!; frames.delete(id); cb(time) } }
}

it('observes an already ready retained Terminal without requiring a new attach or revealed transition', () => {
  const f = fixture(), placement = vi.fn(() => true), read = vi.fn(() => ready)
  const off = f.costs.registerPlacement(target, placement), offTerminal = f.costs.registerTerminal(target, read)
  f.costs.begin(target, 'terminal', 80); f.advance(3); f.costs.selected(target)
  expect(f.costs.snapshot()[0]).toMatchObject({ inputDelayMs: 20, selectedMs: 3, placedMs: 0, terminalMs: 0, inputReadyMs: 0, frameMs: null, state: 'pending', terminal: ready })
  f.advance(7); f.frame(); f.advance(9); f.frame()
  expect(f.costs.snapshot()[0]).toMatchObject({ frameMs: 19, state: 'observed', terminal: { runId: 'run', readySinceAt: 1 } })
  const before = read.mock.calls.length
  for (let n = 0; n < 100; n++) f.costs.observe({ ...target, regionId: 'unrelated' })
  expect(read).toHaveBeenCalledTimes(before)
  const detached = f.costs.snapshot(); detached[0]!.target.tabId = 'mutated'; detached[0]!.terminal!.acceptsInput = false
  expect(f.costs.snapshot()[0]).toMatchObject({ target, terminal: ready })
  off(); offTerminal(); offTerminal(); expect(f.frames.size).toBe(0)
})

it('keeps missing placement unknown and separates local display from a later open input gate', () => {
  const f = fixture(); let placed = false, facts = { ...ready, acceptsInput: false, liveReady: false, replaying: true }
  f.costs.registerPlacement(target, () => placed); f.costs.registerTerminal(target, () => facts)
  f.costs.begin(target, 'terminal', null); f.costs.selected(target)
  expect(f.costs.snapshot()[0]).toMatchObject({ inputDelayMs: null, placedMs: null, frameMs: null, inputReadyMs: null })
  expect(f.frames.size).toBe(0)
  f.advance(15_000); placed = true; f.costs.observe(target); f.frame(); f.frame()
  expect(f.costs.snapshot()[0]).toMatchObject({ placedMs: 15_000, frameMs: 15_000, inputReadyMs: null, terminal: { acceptsInput: false, replaying: true } })
  f.advance(2_000); facts = { ...ready }; f.costs.observe(target)
  expect(f.costs.snapshot()[0]).toMatchObject({ inputReadyMs: 17_000, terminal: ready })
})

it('does not cross-complete quick switches, duplicate Groups or a covered retained host', () => {
  const f = fixture(), other = { ...target, groupId: 'right' }
  f.costs.registerPlacement(target, () => true); f.costs.registerTerminal(target, () => ready)
  f.costs.registerPlacement(other, () => false); f.costs.registerTerminal(other, () => ({ ...ready, visible: false }))
  f.costs.begin(target, 'terminal', 90); f.costs.selected(other)
  expect(f.costs.snapshot()[0]!.selectedMs).toBeNull()
  f.costs.selected(target); const stale = [...f.all.values()][0]!
  f.costs.begin(other, 'terminal', 95); f.costs.selected(other); stale(100); f.costs.observe(target)
  expect(f.costs.snapshot().map(r => [r.state, r.frameMs, r.placedMs])).toEqual([['superseded', null, 0], ['pending', null, null]])
  expect(f.frames.size).toBe(0)
  f.costs.begin(target, 'terminal', 99); f.costs.selected(target); f.frame(); const oldSecond = [...f.all.values()].at(-1)!
  f.costs.begin(target, 'terminal', 99); f.costs.selected(target); oldSecond(101)
  expect(f.frames.size).toBe(1); f.frame(); f.frame()
  expect(f.costs.snapshot().at(-1)!.state).toBe('observed')
})

it('keeps Activity and other surfaces explicit and bounds history without reading unrelated owners', () => {
  const f = fixture(), read = vi.fn(() => ready)
  for (let n = 0; n < 100; n++) f.costs.registerTerminal({ ...target, tabId: `unrelated-${n}` }, read)
  for (let n = 0; n < 50; n++) { f.costs.begin(target, n % 2 ? 'activity' : 'other', -1); f.costs.selected(target) }
  const records = f.costs.snapshot()
  expect(records).toHaveLength(16); expect(records[0]!.id).toBe(35)
  expect(f.costs.omitted()).toBe(34)
  expect(f.costs.omitted()).toBe(34)
  expect(records.every(r => r.state === 'observed' && r.terminal === null && r.frameMs === null && r.inputReadyMs === null && r.inputDelayMs === null)).toBe(true)
  expect(read).not.toHaveBeenCalled(); expect(f.frames.size).toBe(0)
})

it('cancels departing owners, refuses ambiguous presentation readers, and ignores old callbacks', () => {
  const f = fixture(); f.costs.registerPlacement(target, () => true)
  const off = f.costs.registerTerminal(target, () => ready), duplicate = f.costs.registerTerminal(target, () => ready)
  f.costs.begin(target, 'terminal', 200_000); f.costs.selected(target)
  expect(f.costs.snapshot()[0]).toMatchObject({ inputDelayMs: null, terminal: null, terminalMs: null })
  duplicate(); f.costs.observe(target); const callback = [...f.all.values()].at(-1)!
  off(); callback(100); expect(f.costs.snapshot()[0]!.frameMs).toBeNull(); expect(f.frames.size).toBe(0)
})

it.each(['sessionId', 'runId'] as const)('keeps original facts when %s changes after a local frame but before the input gate opens', field => {
  const f = fixture(), facts = { ...ready, acceptsInput: false }
  f.costs.registerPlacement(target, () => true)
  const off = f.costs.registerTerminal(target, () => facts)
  f.costs.begin(target, 'terminal', 90)
  expect(f.costs.snapshot()[0]!.terminal).toEqual(facts)
  f.costs.selected(target); f.frame(); f.frame()
  const before = f.costs.snapshot()[0]!
  expect(before).toMatchObject({ state: 'observed', inputReadyMs: null })
  off(); f.advance(1000)
  const replacement = { ...ready, [field]: `replacement-${field}`, readySinceAt: 1100 }
  f.costs.registerTerminal(target, () => replacement)
  expect(f.costs.snapshot()[0]).toEqual({ ...before, state: 'superseded' })
  f.costs.observe(target)
  expect(f.costs.snapshot()[0]).toEqual({ ...before, state: 'superseded' })
  expect(f.frames.size).toBe(0)
})

it('rejects a changed Run first observed by the second local-frame callback', () => {
  const f = fixture(); let facts = { ...ready, acceptsInput: false }
  f.costs.registerPlacement(target, () => true); f.costs.registerTerminal(target, () => facts)
  f.costs.begin(target, 'terminal', 90); f.costs.selected(target); f.frame()
  facts = { ...ready, runId: 'replacement-run' }; f.advance(1000); f.frame()
  expect(f.costs.snapshot()[0]).toMatchObject({ state: 'superseded', frameMs: null, inputReadyMs: null,
    terminal: { runId: 'run', acceptsInput: false } })
  expect(f.frames.size).toBe(0)
})

it('measures bounded recorder work without reading unrelated retained terminals', () => {
  const frames: FrameRequestCallback[] = [], unrelated = vi.fn(() => ready)
  const costs = createTabSwitchObservation(() => performance.now(), Date.now, callback => { frames.push(callback); return frames.length }, () => {})
  costs.registerPlacement(target, () => true); costs.registerTerminal(target, () => ready)
  for (let n = 0; n < 100; n++) costs.registerTerminal({ ...target, tabId: `unrelated-${n}` }, unrelated)
  const count = 3000, start = performance.now()
  for (let n = 0; n < count; n++) {
    costs.begin(target, 'terminal', performance.now()); costs.selected(target)
    frames.shift()!(performance.now()); frames.shift()!(performance.now())
  }
  const durationMs = performance.now() - start
  expect(unrelated).not.toHaveBeenCalled(); expect(frames).toHaveLength(0)
  expect(costs.snapshot()).toHaveLength(16); expect(costs.omitted()).toBe(count - 16)
  console.info('RECORDER_COST=' + JSON.stringify({ count, durationMs, perClickMs: durationMs / count,
    boundary: 'Recorder and one controlled current-state reader; excludes DOM layout, native render and whole UI cost.', unrelatedReaders: 100, unrelatedReads: 0 }))
})
