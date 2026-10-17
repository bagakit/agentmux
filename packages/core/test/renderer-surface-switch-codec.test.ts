import { expect, it } from 'vitest'
import { parseRendererPerformanceSnapshot, type RendererSurfaceSwitchCost } from '../src/metrics.js'
import { performanceFixture } from './helpers/renderer-performance.js'

const record = (): RendererSurfaceSwitchCost => ({ id: 1, source: 'footer-click', from: 'space', to: 'focus',
  handlerAt: 1000, handlerStartMonoMs: 100, eventAtMonoMs: 80.5, inputDelayMs: 19.5,
  actionEndedMs: 3, actionResult: 'returned', selectedMs: 4, selectedSource: 'layout-effect',
  frameMs: 29.5, elapsedMs: 29.5, state: 'observed', pendingStage: null })
const parse = (surfaceSwitches: unknown, extra = {}) => parseRendererPerformanceSnapshot({ ...performanceFixture(), surfaceSwitches, ...extra })

it('preserves exact finite Surface/source phases, null missing facts and all 16 detached JSON records', () => {
  const records = [record(), { ...record(), id: 2, from: 'focus', to: 'goals', state: 'pending', pendingStage: 'selection',
    eventAtMonoMs: null, inputDelayMs: null, actionEndedMs: null, actionResult: null, selectedMs: null, selectedSource: null, frameMs: null },
  { ...record(), id: 3, from: 'goals', to: 'survey', state: 'superseded', pendingStage: null, frameMs: null },
  { ...record(), id: 4, from: 'recall', to: 'recall', selectedSource: 'already-committed-handler' }]
  expect(parse(JSON.parse(JSON.stringify(records))).surfaceSwitches).toEqual(records)
  const full = Array.from({ length: 16 }, (_, id) => ({ ...record(), id }))
  expect(parse(full, { surfaceSwitchesOmitted: 34 })).toMatchObject({ surfaceSwitches: full, surfaceSwitchesOmitted: 34 })
  expect(() => parse([...full, record()])).toThrow()
})

it('rejects unbounded, missing, private or malformed fields without executing accessors', () => {
  const base = record(), without = (key: string) => Object.fromEntries(Object.entries(base).filter(([name]) => name !== key))
  const invalid = [{ ...base, id: -1 }, { ...base, id: 1.5 }, { ...base, source: 'app.focus' }, { ...base, from: 'workbench' },
    { ...base, to: 'agents' }, { ...base, state: 'completed' }, { ...base, pendingStage: 'paint' },
    { ...base, selectedSource: 'store' }, { ...base, actionResult: 'success' }, { ...base, prompt: 'private body' },
    { ...base, targetTitle: 'private title' }, ...Object.keys(base).map(without)]
  for (const value of invalid) expect(() => parse([value])).toThrow()
  for (const field of ['handlerAt', 'handlerStartMonoMs', 'eventAtMonoMs', 'inputDelayMs', 'actionEndedMs', 'selectedMs', 'frameMs', 'elapsedMs']) {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => parse([{ ...base, [field]: value }])).toThrow()
  }
  for (const surfaceSwitchesOmitted of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) expect(() => parse([], { surfaceSwitchesOmitted })).toThrow()
  let reads = 0
  Object.defineProperty(base, 'frameMs', { enumerable: true, get() { reads++; return 1 } })
  expect(() => parse([base])).toThrow(); expect(reads).toBe(0)
  const missing: any = performanceFixture(); delete missing.surfaceSwitches
  expect(() => parseRendererPerformanceSnapshot(missing)).toThrow()
})
