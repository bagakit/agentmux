import { fixtureEpoch } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import {
  parseMetricsObservation, parseMetricsRendererResult,
  type RendererTabSwitchCost
} from '../src/metrics.js'
import { performanceFixture } from './helpers/renderer-performance.js'

const window = { windowId: 1, webContentsId: 2, generation: 3 }
const counts = { monacoEditors: null, monacoModels: null, documents: 0, runtimeSubscriptions: 1,
  terminalViews: 1, terminalAddons: 0, terminalListeners: 0 }
const pending = { state: 'pending', observedAt: null, lastSuccessAt: null, reason: null, data: null }
const decoders = [
  { name: 'Renderer IPC reply', parse(performance: unknown) {
    return parseMetricsRendererResult({ operation: 'metrics.renderer', window, observedAt: 2, counts, performance }).performance
  } },
  { name: 'public metrics observation', parse(performance: unknown) {
    return parseMetricsObservation({ schema: 'agentmux.metrics.v1', observedAt: 2,
      scope: { kind: 'unix-host', hostId: 'local', hostname: 'fixture-host', mainPid: 1 }, window,
      units: { cpu: 'percent', rss: 'KiB', storage: 'bytes', cpuAggregate: '10s-reading-peak', rssAggregate: 'latest' },
      process: pending, app: pending, runtime: pending, main: pending,
      renderer: { state: 'available', observedAt: 2, lastSuccessAt: 2, reason: null,
        data: { window, counts, performance } } }).renderer.data!.performance
  } }
]
function switchFixture(): RendererTabSwitchCost {
  return { id: 1, target: { displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'region', presentationId: 'space' },
    handlerAt: fixtureEpoch(1, 42496, 882), inputDelayMs: 12.5, selectedMs: 1, placedMs: 3, terminalMs: 4, inputReadyMs: 35, frameMs: 21.5,
    state: 'observed', mode: 'terminal', terminal: { sessionId: 'session', runId: 'run', readySinceAt: fixtureEpoch(1, 38117, 446),
      visible: true, revealed: true, liveReady: true, acceptsInput: true, readOnly: false, replaying: false } }
}
function without(value: object, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value }; delete copy[key]; return copy
}

describe.each(decoders)('$name tab-switch records', ({ parse }) => {
  it('preserves exact presentation, fractional elapsed phases and current ready terminal facts', () => {
    const record = switchFixture()
    const performance = { ...performanceFixture(), tabSwitches: [record] }
    const parsed = parse(JSON.parse(JSON.stringify(performance)))
    expect(parsed.tabSwitches).toEqual([record])
    expect(parsed.tabSwitches[0]!.target.presentationId).toBe('space')
    expect(parsed.tabSwitches[0]!.terminal!.readySinceAt).toBeLessThan(record.handlerAt)
  })

  it('retains null stages and non-terminal modes without inventing input or frame completion', () => {
    const record = switchFixture()
    const tabSwitches: RendererTabSwitchCost[] = [
      { ...record, state: 'pending', mode: 'unknown', terminal: null,
        inputDelayMs: null, selectedMs: null, placedMs: null, terminalMs: null, inputReadyMs: null, frameMs: null },
      { ...record, id: 2, state: 'superseded', mode: 'activity', terminal: null, terminalMs: null, inputReadyMs: null, frameMs: null },
      { ...record, id: 3, state: 'observed', mode: 'other', terminal: null, terminalMs: null, inputReadyMs: null },
      { ...record, id: 4, inputReadyMs: null, terminal: { ...record.terminal!, acceptsInput: false, readOnly: true, readySinceAt: null } }
    ]
    expect(parse({ ...performanceFixture(), tabSwitches }).tabSwitches).toEqual(tabSwitches)
  })

  it('accepts the 16-record boundary and rejects overflow', () => {
    const tabSwitches = Array.from({ length: 16 }, (_, id) => ({ ...switchFixture(), id }))
    const parsed = parse({ ...performanceFixture(), tabSwitches, tabSwitchesOmitted: 34 })
    expect(parsed.tabSwitches).toHaveLength(16); expect(parsed.tabSwitchesOmitted).toBe(34)
    expect(() => parse({ ...performanceFixture(), tabSwitches: [...tabSwitches, switchFixture()] })).toThrow()
    for (const tabSwitchesOmitted of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parse({ ...performanceFixture(), tabSwitches, tabSwitchesOmitted })).toThrow()
    }
    expect(() => parse(without(performanceFixture(), 'tabSwitchesOmitted'))).toThrow()
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('rejects invalid timestamp or elapsed duration %s', invalid => {
    for (const field of ['handlerAt', 'inputDelayMs', 'selectedMs', 'placedMs', 'terminalMs', 'inputReadyMs', 'frameMs'] as const) {
      expect(() => parse({ ...performanceFixture(), tabSwitches: [{ ...switchFixture(), [field]: invalid }] })).toThrow()
    }
    expect(() => parse({ ...performanceFixture(), tabSwitches: [{ ...switchFixture(),
      terminal: { ...switchFixture().terminal!, readySinceAt: invalid } }] })).toThrow()
  })

  it('rejects invalid identities, states, booleans and unbounded or private extra fields', () => {
    const record = switchFixture()
    const invalidRecords = [
      { ...record, id: 1.5 }, { ...record, id: Number.MAX_SAFE_INTEGER + 1 },
      { ...record, state: 'complete' }, { ...record, mode: 'tui' },
      { ...record, target: without(record.target, 'presentationId') },
      { ...record, target: { ...record.target, presentationId: ' ' } },
      { ...record, target: { ...record.target, groupId: 'group\npeer' } },
      { ...record, target: { ...record.target, regionId: 'x'.repeat(4097) } },
      { ...record, target: { ...record.target, title: 'private title' } },
      { ...record, terminal: { ...record.terminal!, sessionId: '' } },
      { ...record, terminal: { ...record.terminal!, runId: 'run\0peer' } },
      { ...record, terminal: { ...record.terminal!, acceptsInput: 1 } },
      { ...record, terminal: without(record.terminal!, 'readOnly') },
      { ...record, terminal: { ...record.terminal!, body: 'private terminal body' } },
      { ...record, eventName: 'keydown' }, { ...record, selectedMs: undefined }
    ]
    expect(invalidRecords.length).toBeGreaterThan(0)
    for (const value of invalidRecords) expect(() => parse({ ...performanceFixture(), tabSwitches: [value] })).toThrow()
    expect(() => parse(without(performanceFixture(), 'tabSwitches'))).toThrow()
  })

  it('rejects accessor-backed stage fields without executing them', () => {
    let reads = 0
    const record = switchFixture()
    Object.defineProperty(record, 'frameMs', { enumerable: true, get() { reads++; return 1 } })
    expect(() => parse({ ...performanceFixture(), tabSwitches: [record] })).toThrow()
    expect(reads).toBe(0)
  })
})
