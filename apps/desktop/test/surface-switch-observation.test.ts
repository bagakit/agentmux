import { expect, it, vi } from 'vitest'
import { createSurfaceSwitchObservation } from '../src/renderer/src/lib/surface-switch-observation'

function fixture() {
  let time = 100, next = 0, visible = true
  const frames = new Map<number, FrameRequestCallback>(), all = new Map<number, FrameRequestCallback>()
  const costs = createSurfaceSwitchObservation(() => time, () => 1000 + time,
    cb => { frames.set(++next, cb); all.set(next, cb); return next }, id => { frames.delete(id) }, () => visible)
  return { costs, frames, all, advance(ms: number) { time += ms }, setTime(value: number) { time = value },
    visible(value: boolean) { visible = value; costs.observe() },
    frame() { const [id, cb] = frames.entries().next().value!; frames.delete(id); cb(time) } }
}

it('separates event delay, original handler/action tail, actual App commit and two local frames', () => {
  const f = fixture(); f.costs.committed('space', true)
  const id = f.costs.begin('space', 'focus', 80)
  expect(f.costs.snapshot()[0]).toMatchObject({ source: 'footer-click', from: 'space', to: 'focus', inputDelayMs: 20, selectedMs: null, frameMs: null })
  f.advance(3); f.costs.committed('focus', true); f.advance(4); f.costs.actionEnded(id, 'returned')
  expect(f.frames.size).toBe(1); f.advance(10); f.frame()
  expect(f.costs.snapshot()[0]).toMatchObject({ state: 'pending', selectedMs: 3, selectedSource: 'layout-effect', actionEndedMs: 7, frameMs: null })
  f.advance(12); f.frame()
  expect(f.costs.snapshot()[0]).toMatchObject({ state: 'observed', frameMs: 29, elapsedMs: 29, pendingStage: null })
  f.advance(5000); expect(f.costs.snapshot()[0]!.elapsedMs).toBe(29)
})

it('does not manufacture a commit from Store selection, a failed action, a missing App or an unrelated source commit', () => {
  const f = fixture(), id = f.costs.begin('space', 'focus', null)
  f.advance(15); f.costs.actionEnded(id, 'threw'); f.costs.committed('space', true)
  expect(f.costs.snapshot()[0]).toMatchObject({ state: 'pending', pendingStage: 'selection', selectedMs: null, selectedSource: null, actionResult: 'threw', actionEndedMs: 15 })
  expect(f.frames.size).toBe(0)
  f.costs.begin('focus', 'focus', null)
  expect(f.costs.snapshot()[1]!.selectedMs).toBeNull()
  f.costs.ownerDeparted(); f.costs.begin('space', 'space', null)
  expect(f.costs.snapshot()[2]!.selectedMs).toBeNull()
  expect(f.frames.size).toBe(0)
})

it('marks the already committed same target honestly while keeping script and invalid event clocks unknown', () => {
  const f = fixture(); f.costs.committed('focus', true)
  for (const timestamp of [null, -1, 0, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
    f.costs.begin('focus', 'focus', timestamp)
    expect(f.costs.snapshot().at(-1)).toMatchObject({ eventAtMonoMs: null, inputDelayMs: null, selectedMs: 0, selectedSource: 'already-committed-handler' })
    f.frame(); f.frame()
  }
})

it('waits without polling while hidden or covered and ignores cancelled frame callbacks', () => {
  const f = fixture(); f.costs.committed('space', true); f.costs.begin('space', 'focus', 90)
  f.costs.committed('focus', false)
  expect(f.costs.snapshot()[0]).toMatchObject({ selectedSource: 'layout-effect', selectedMs: 0, pendingStage: 'presentation', frameMs: null })
  expect(f.frames.size).toBe(0)
  f.costs.committed('focus', true); const stale = [...f.all.values()].at(-1)!
  f.visible(false); expect(f.frames.size).toBe(0); stale(100)
  expect(f.frames.size).toBe(0)
  f.advance(15_000); f.visible(true); f.frame(); f.frame()
  expect(f.costs.snapshot()[0]).toMatchObject({ state: 'observed', frameMs: 15_000 })
})

it('does not cross-complete quick switches, changed committed surfaces or a departed App', () => {
  const f = fixture(); f.costs.committed('space', true); const first = f.costs.begin('space', 'focus', 90)
  f.costs.committed('focus', true); f.frame(); const stale = [...f.all.values()].at(-1)!
  f.advance(5); f.costs.begin('focus', 'goals', 95); f.costs.committed('goals', true); stale(105)
  expect(f.costs.snapshot()[0]).toMatchObject({ state: 'superseded', frameMs: null, elapsedMs: 5 })
  f.advance(7); f.costs.actionEnded(first, 'threw'); f.costs.actionEnded(first, 'returned')
  expect(f.costs.snapshot()[0]).toMatchObject({ actionEndedMs: 12, actionResult: 'threw', elapsedMs: 5 })
  f.costs.committed('recall', true)
  expect(f.costs.snapshot()[1]).toMatchObject({ state: 'superseded', frameMs: null })
  f.costs.begin('recall', 'survey', null); f.costs.committed('survey', true); const old = [...f.all.values()].at(-1)!
  f.costs.ownerDeparted(); old(112)
  expect(f.costs.snapshot()[2]).toMatchObject({ state: 'superseded', frameMs: null })
  expect(f.frames.size).toBe(0)
})

it('bounds history and immutable snapshots, monotonic pending age and old evicted action tails', () => {
  const f = fixture(), first = f.costs.begin('space', 'focus', null)
  f.advance(500); expect(f.costs.snapshot()[0]!.elapsedMs).toBe(500)
  f.setTime(90); expect(f.costs.snapshot()[0]!.elapsedMs).toBe(500)
  f.setTime(600)
  for (let n = 0; n < 50; n++) f.costs.begin('space', 'focus', null)
  const records = f.costs.snapshot(); expect(records).toHaveLength(16); expect(records[0]!.id).toBe(36)
  expect(f.costs.omitted()).toBe(35)
  f.costs.actionEnded(first, 'returned'); expect(f.costs.snapshot()).toEqual(records)
  records[0]!.to = 'recall'; records.at(-1)!.state = 'observed'
  expect(f.costs.snapshot()[0]!.to).toBe('focus'); expect(f.costs.snapshot().at(-1)!.state).toBe('pending')
  expect(f.frames.size).toBe(0)
})

it('keeps recorder work bounded without scans, timers or layout and records its local cost', () => {
  const frames: FrameRequestCallback[] = [], interval = vi.spyOn(globalThis, 'setInterval'), timeout = vi.spyOn(globalThis, 'setTimeout')
  try {
    const costs = createSurfaceSwitchObservation(() => performance.now(), Date.now,
      cb => { frames.push(cb); return frames.length }, () => {}, () => true)
    costs.committed('space', true)
    const count = 3000, start = performance.now()
    for (let n = 0; n < count; n++) {
      const id = costs.begin('space', 'focus', performance.now()); costs.committed('focus', true); costs.actionEnded(id, 'returned')
      frames.shift()!(performance.now()); frames.shift()!(performance.now()); costs.committed('space', true)
    }
    const durationMs = performance.now() - start
    expect(costs.snapshot()).toHaveLength(16); expect(costs.omitted()).toBe(count - 16); expect(frames).toHaveLength(0)
    expect(interval).not.toHaveBeenCalled(); expect(timeout).not.toHaveBeenCalled()
    console.info('SURFACE_RECORDER_COST=' + JSON.stringify({ count, durationMs, perClickMs: durationMs / count,
      boundary: 'Recorder and controlled App commit facts only; excludes DOM layout, native rendering, compositor and whole UI cost.' }))
  } finally { interval.mockRestore(); timeout.mockRestore() }
})
