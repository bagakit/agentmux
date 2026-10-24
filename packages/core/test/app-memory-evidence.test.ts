import { expect, it } from 'vitest'
import { parseAppMemoryArchive, parseAppMemoryEvidence } from '../src/app-memory-evidence.js'

const process = { pid: 4, creationTime: 2, type: 'Tab', rssKib: 70 }
const archive = { schema: 'agentmux.app-memory-evidence.v1', segments: [{
  main: { pid: 3, creationTime: 1 }, firstObservedAt: 100, lastObservedAt: 200, sampleCount: 2,
  peak: { observedAt: 200, rssKib: 90, processCount: 2,
    processes: [process, { pid: 3, creationTime: 1, type: 'Browser', rssKib: 20 }], omittedProcesses: 0 },
  largestProcess: { ...process, observedAt: 200 }
}] } as const

it('keeps archive and public memory evidence bounded to original process identities', () => {
  expect(parseAppMemoryArchive(archive).segments[0]?.peak.rssKib).toBe(90)
  expect(parseAppMemoryEvidence({ ...archive, intervalMs: 30000,
    sampling: { state: 'available', reason: null },
    persistence: { state: 'confirmed', reason: null, coalescedWrites: 0 } }).segments).toHaveLength(1)
  expect(() => parseAppMemoryArchive({ ...archive, segments: [{ ...archive.segments[0], peak: {
    ...archive.segments[0].peak, processCount: 3 } }] })).toThrow()
  expect(() => parseAppMemoryArchive({ ...archive, segments: [{ ...archive.segments[0], largestProcess: {
    ...archive.segments[0].largestProcess, rssKib: 100 } }] })).toThrow()
  expect(() => parseAppMemoryEvidence({ ...archive, intervalMs: 30000,
    sampling: { state: 'unavailable', reason: null },
    persistence: { state: 'confirmed', reason: null, coalescedWrites: 0 } })).toThrow()
})

it('rejects non-string states and array accessors without evaluating them', () => {
  const evidence = { ...archive, intervalMs: 30000, sampling: { state: 'available', reason: null },
    persistence: { state: 'confirmed', reason: null, coalescedWrites: 0 } }
  expect(() => parseAppMemoryEvidence({ ...evidence, sampling: { state: ['available'], reason: null } })).toThrow()
  expect(() => parseAppMemoryEvidence({ ...evidence, persistence: {
    state: ['confirmed'], reason: null, coalescedWrites: 0 } })).toThrow()
  let evaluated = false
  const segments = [...archive.segments], processes = [...archive.segments[0].peak.processes]
  const getter = { enumerable: true, get() { evaluated = true; return archive.segments[0] } }
  Object.defineProperty(segments, '0', getter)
  expect(() => parseAppMemoryArchive({ ...archive, segments })).toThrow()
  Object.defineProperty(processes, '0', getter)
  expect(() => parseAppMemoryArchive({ ...archive, segments: [{ ...archive.segments[0],
    peak: { ...archive.segments[0].peak, processes } }] })).toThrow()
  expect(evaluated).toBe(false)
})
