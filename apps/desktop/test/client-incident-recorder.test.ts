// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentMuxClientIncidentReport } from '@agentmux/core/client-incident'
import { createClientIncidentRecorder, createClientIncidentDispatcher } from '../src/renderer/src/lib/client-incident-recorder'
import { api } from '../src/renderer/src/lib/api'

afterEach(() => vi.restoreAllMocks())
it('freezes the failed attempt before refresh and retains explicit association after recovery', () => {
  const reports: AgentMuxClientIncidentReport[] = []
  let cursorBytes = 0, next = 0
  const read = vi.fn((geometry: boolean) => ({ cursorBytes, ...(geometry ? { clientWidth: 640 } : {}) }))
  const recorder = createClientIncidentRecorder({ hostId: 'local', agentSessionId: 'agent', runId: 'run', regionId: () => 'region',
    read, send: report => reports.push(report), id: () => `id-${++next}`, now: () => 20, monotonic: () => 10 })
  recorder.begin('attach-requested')
  const failed = recorder.capture('terminal-attach-failed', 'attach-failed', { code: 'CONTROL_TIMEOUT', message: 'private text' })
  recorder.begin('refresh-requested')
  const refresh = recorder.capture('terminal-refresh', 'refresh-requested')
  cursorBytes = 400
  recorder.mark('replay-applied')
  recorder.capture('terminal-refresh', 'refresh-completed', undefined, refresh)
  expect(reports).toHaveLength(3)
  expect(reports[0]).toMatchObject({ code: 'CONTROL_TIMEOUT', metadata: { cursorBytes: 0 } })
  expect(reports[1]).toMatchObject({ relatedOccurrenceId: failed, metadata: { cursorBytes: 0 } })
  expect(reports[2]).toMatchObject({ relatedOccurrenceId: refresh, metadata: { cursorBytes: 400 } })
  expect(reports[0]!.stages.map(item => item.stage)).toEqual(['attach-requested', 'attach-failed'])
  expect(reports[0]!.attemptId).not.toBe(reports[2]!.attemptId)
  expect(JSON.stringify(reports)).not.toContain('private text')
  expect(read.mock.calls.filter(([geometry]) => geometry)).toHaveLength(3)
})

it('bounds stage history, reports overwritten coverage and withholds arbitrary codes', () => {
  const reports: AgentMuxClientIncidentReport[] = [], read = vi.fn(() => ({ visible: true }))
  const recorder = createClientIncidentRecorder({ hostId: 'local', agentSessionId: null, runId: 'raw-run', regionId: () => null,
    read, send: report => reports.push(report) })
  for (let index = 0; index < 1000; index++) recorder.mark('resize')
  expect(reports).toEqual([])
  recorder.capture('terminal-context-lost', 'context-lost', { code: 'PRIVATE_TOKEN_TEXT' })
  expect(reports).toHaveLength(1)
  expect(reports[0]!.stages).toHaveLength(16)
  expect(reports[0]!.metadata.historyOverwritten).toBe(985)
  expect(reports[0]!.code).toBeNull()
  expect(JSON.stringify(reports)).not.toContain('PRIVATE_TOKEN_TEXT')
})

it('holds one real IPC slot during slow reporting and bounds independent queued incidents', async () => {
  let release!: (receipt: { accepted: boolean }) => void
  const open = vi.spyOn(api.clientIncidents, 'open').mockResolvedValue({ token: 'document-token' })
  const report = vi.spyOn(api.clientIncidents, 'report').mockImplementation(() => new Promise(resolve => { release = resolve }))
  const sender = createClientIncidentDispatcher(() => api.clientIncidents)
  const reports: AgentMuxClientIncidentReport[] = []
  const recorder = createClientIncidentRecorder({ hostId: 'local', agentSessionId: null, runId: 'run', regionId: () => null,
    read: () => ({}), send: value => reports.push(value) })
  recorder.capture('terminal-attach-failed', 'attach-failed')
  sender.send(reports[0]!)
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1))
  for (let index = 0; index < 100; index++) sender.send({ ...reports[0]!, occurrenceId: `incident-${index}` })
  expect(report).toHaveBeenCalledTimes(1)
  expect(open).toHaveBeenCalledTimes(1)
  expect(sender.dropped()).toBe(68)
  // One acknowledgement releases one actual slot, rather than an observation timeout releasing many.
  report.mockResolvedValue({ accepted: true })
  release({ accepted: true })
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(33))
})

it('never replays an unknown report and retries only document discovery for a new incident', async () => {
  const open = vi.spyOn(api.clientIncidents, 'open').mockResolvedValue({ token: 'document-token' })
  const report = vi.spyOn(api.clientIncidents, 'report').mockRejectedValueOnce(new Error('reply lost')).mockResolvedValue({ accepted: true })
  const sender = createClientIncidentDispatcher(() => api.clientIncidents), reports: AgentMuxClientIncidentReport[] = []
  const recorder = createClientIncidentRecorder({ hostId: 'local', agentSessionId: null, runId: 'run', regionId: () => null,
    read: () => ({}), send: value => reports.push(value) })
  recorder.capture('terminal-attach-failed', 'attach-failed'); sender.send(reports[0]!)
  await vi.waitFor(() => expect(sender.dropped()).toBe(1))
  recorder.capture('terminal-refresh', 'refresh-requested'); sender.send(reports[1]!)
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2))
  expect(open).toHaveBeenCalledTimes(2)
  expect(report.mock.calls.map(([, value]) => value.occurrenceId)).toEqual(reports.map(value => value.occurrenceId))
})

it('keeps business callers usable when metadata reads or the diagnostic sink fail', () => {
  const reports: AgentMuxClientIncidentReport[] = []
  const send = vi.fn((_report: AgentMuxClientIncidentReport): void => { throw new Error('archive unavailable') })
  const recorder = createClientIncidentRecorder({ hostId: 'local', agentSessionId: null, runId: 'run', regionId: () => null,
    read: () => { throw new Error('projection unavailable') }, send })
  expect(() => { recorder.begin('attach-requested'); recorder.capture('terminal-attach-failed', 'attach-failed') }).not.toThrow()
  send.mockImplementation(value => { reports.push(value) })
  recorder.capture('terminal-refresh', 'refresh-requested')
  expect(reports).toHaveLength(1)
  expect(reports[0]!.metadata).toMatchObject({ reporterDropped: 1, recorderReadFailures: 5 })
  expect(JSON.stringify(reports)).not.toContain('projection unavailable')
})


it.each(['regionId', 'dropped', 'now', 'monotonic', 'id'] as const)(
  'isolates a failing %s producer callback and counts the unavailable occurrence after recovery', callback => {
    const reports: AgentMuxClientIncidentReport[] = []
    let broken = false, serial = 0
    const unavailable = () => { if (broken) throw Error('private callback failure') }
    const input = { hostId: 'local', agentSessionId: null, runId: 'run', read: () => ({ visible: true }),
      regionId: () => { if (callback === 'regionId') unavailable(); return 'original-region' },
      dropped: () => { if (callback === 'dropped') unavailable(); return 0 },
      now: () => { if (callback === 'now') unavailable(); return 20 },
      monotonic: () => { if (callback === 'monotonic') unavailable(); return 10 },
      id: () => { if (callback === 'id') unavailable(); return `original-${++serial}` },
      send: (report: AgentMuxClientIncidentReport) => { reports.push(report) } }
    const recorder = createClientIncidentRecorder(input)
    broken = true
    expect(() => { recorder.begin('refresh-requested'); recorder.mark('replay-started') }).not.toThrow()
    expect(recorder.capture('terminal-refresh', 'refresh-requested')).toBeNull()
    expect(reports).toEqual([])
    broken = false
    expect(recorder.capture('terminal-refresh', 'refresh-completed')).toEqual(expect.any(String))
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ observedAt: 20, elapsedMs: 0, metadata: { reporterDropped: 1 } })
    expect(JSON.stringify(reports)).not.toContain('private callback failure')
  })

it('does not fabricate an original ID or elapsed origin when initialization observations are unavailable', () => {
  let broken = true, serial = 0
  const reports: AgentMuxClientIncidentReport[] = []
  let recorder!: ReturnType<typeof createClientIncidentRecorder>
  expect(() => { recorder = createClientIncidentRecorder({ hostId: 'local', agentSessionId: null, runId: 'run', regionId: () => null,
    read: () => ({}), send: value => { reports.push(value) }, now: () => 20,
    monotonic: () => { if (broken) throw Error('clock unavailable'); return 10 },
    id: () => { if (broken) throw Error('identity unavailable'); return `original-${++serial}` } }) }).not.toThrow()
  expect(recorder.capture('terminal-refresh', 'refresh-requested')).toBeNull()
  broken = false
  expect(recorder.capture('terminal-refresh', 'refresh-completed')).toBe('original-1')
  expect(reports).toHaveLength(1)
  expect(reports[0]).toMatchObject({ observedAt: 20, elapsedMs: null, stages: [],
    metadata: { reporterDropped: 1, recorderReadFailures: 2 } })
})

it('reads only an own finite code observation without executing an error accessor', () => {
  const reports: AgentMuxClientIncidentReport[] = []
  let getters = 0
  const error = Object.defineProperty(new Error('private original error'), 'code', { get() { getters++; throw Error('private getter') } })
  const recorder = createClientIncidentRecorder({ hostId: 'local', agentSessionId: null, runId: 'run', regionId: () => null,
    read: () => ({}), send: value => { reports.push(value) } })
  expect(recorder.capture('terminal-attach-failed', 'attach-failed', error)).toEqual(expect.any(String))
  expect(getters).toBe(0)
  expect(reports).toHaveLength(1)
  expect(reports[0]).toMatchObject({ code: null, metadata: { recorderReadFailures: 1 } })
  expect(JSON.stringify(reports)).not.toContain('private original error')
})
