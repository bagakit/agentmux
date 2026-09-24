// @vitest-environment happy-dom
import { writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { SessionSnapshot, AppConfig } from '../src/shared/contracts'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { EMPTY_AGENT_FOCUS, restoreAgentFocus, focusExecution, MAX_EXECUTION_FOCUS_HISTORY_BYTES } from '../src/renderer/src/lib/agent-focus'
const NOW = Date.parse('2026-10-03T12:00:00Z')
const baseline = useAppStore.getState()
function session(id: string): SessionSnapshot {
  return { id, kind: 'terminal', providerId: null, hostId: 'local', workspacePath: '/private', label: id, createdAt: 1, updatedAt: 1, processState: 'running', latestOutputBytes: 0, status: { state: 'running', source: 'run-process', observedAt: 1 }, control: { kind: 'terminal', hostId: 'local', runId: id, run: { runId: id } } }
}
function record(id: string, at: number) { vi.spyOn(Date, 'now').mockReturnValue(at); useAppStore.getState().focusExecutionSession(id) }
beforeEach(() => {
  const config = { ...baseline.config, workspaces: [{ id: 'private', hostId: 'local', name: 'Private project', path: '/private', kind: 'folder' }] } as AppConfig
  useAppStore.setState({ config, sessions: [session('a'), session('b')], timelines: {}, agentNames: {}, agentFocus: EMPTY_AGENT_FOCUS })
})
afterEach(() => { useAppStore.setState(baseline, true); vi.restoreAllMocks() })

it('bounds the same history UTF-16 material under actual long-name Store input without truncating observed identities', () => {
  const long = '\\"\ud83d\ude80'.repeat(4096)
  useAppStore.getState().renameAgent('a', long)
  for (let i = 0; i < 180; i++) record(i % 2 ? 'a' : 'b', NOW - 10_000 + i)
  const history = useAppStore.getState().agentFocus.execution.history
  expect(history.length).toBeGreaterThan(0)
  expect(history[0]!.identity?.name).toBe(long)
  expect(JSON.stringify(history).length * 2).toBeLessThanOrEqual(512 * 1024)
  expect(history[0]!.focusedAt).toBe(NOW - 9821)
  const restored = restoreAgentFocus(JSON.parse(JSON.stringify(useAppStore.getState().agentFocus)))
  expect(restored.execution.history).toEqual(history)
})


it('applies the same serialized-material rule to restored Store persist data and keeps complete newest observations', () => {
  record('a', NOW)
  const persisted = useAppStore.persist.getOptions().partialize!(useAppStore.getState()).agentFocus!
  const identity = persisted.execution.history[0]!.identity!
  expect(identity.name).toBe('a')
  const long = '\\"🚀'.repeat(4096)
  const raw = { ...persisted, execution: { ...persisted.execution, history: Array.from({ length: 180 }, (_, index) => ({ sessionId: index % 2 ? 'b' : 'a', focusedAt: NOW - index, identity: { ...identity, name: long } })) } }
  expect(JSON.stringify(raw.execution.history).length * 2).toBeGreaterThan(MAX_EXECUTION_FOCUS_HISTORY_BYTES)
  const restored = restoreAgentFocus(JSON.parse(JSON.stringify(raw)))
  expect(restored.execution.history.length).toBeGreaterThan(0)
  expect(restored.execution.history.length).toBeLessThan(180)
  expect(restored.execution.history[0]!.identity!.name).toBe(long)
  expect(restored.execution.history[0]!.focusedAt).toBe(NOW)
  expect(restored.execution.history).toEqual(raw.execution.history.slice(0, restored.execution.history.length))
  expect(JSON.stringify(restored.execution.history).length * 2).toBeLessThanOrEqual(MAX_EXECUTION_FOCUS_HISTORY_BYTES)
})

it('preserves current focus when a single complete observation exceeds retention and resumes recording the next small observation', () => {
  const stop = vi.spyOn(api.sessions, 'stop'), recover = vi.spyOn(api.sessions, 'recover'), create = vi.spyOn(api.sessions, 'launchAgent')
  const long = '🚀\\"'.repeat(100_000)
  useAppStore.getState().renameAgent('a', long)
  record('a', NOW)
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe('a')
  expect(useAppStore.getState().agentFocus.execution.history).toEqual([])
  record('b', NOW + 1)
  const focus = useAppStore.getState().agentFocus
  expect(focus.execution.sessionId).toBe('b')
  expect(focus.execution.history.map(entry => [entry.sessionId, entry.identity?.name])).toEqual([['b', 'b']])
  expect(stop.mock.calls).toEqual([]); expect(recover.mock.calls).toEqual([]); expect(create.mock.calls).toEqual([])
  expect(JSON.stringify(focus.execution.history).length * 2).toBeLessThanOrEqual(MAX_EXECUTION_FOCUS_HISTORY_BYTES)
})

it('observes related production writer cost with bounded complete real identities', () => {
  record('a', NOW)
  const observed = useAppStore.getState().agentFocus.execution.history[0]!.identity!
  expect(observed.project?.id).toBe('private')
  const samples = []
  for (const [name, count, label] of [['short', 2000, 'Observed worker'], ['escaped-long', 180, String.fromCharCode(92, 34, 0xd83d, 0xde80).repeat(4096)]] as const) {
    let focus = EMPTY_AGENT_FOCUS
    const started = performance.now()
    for (let index = 0; index < count; index++) focus = focusExecution(focus, index % 2 ? 'a' : 'b', index, { ...observed, name: label })
    const milliseconds = performance.now() - started
    const bytes = JSON.stringify(focus.execution.history).length * 2
    expect(focus.execution.history.length).toBeGreaterThan(0)
    expect(bytes).toBeLessThanOrEqual(MAX_EXECUTION_FOCUS_HISTORY_BYTES)
    expect(focus.execution.history[0]!.identity!.name).toBe(label)
    samples.push({ name, calls: count, events: focus.execution.history.length, utf16Bytes: bytes, milliseconds })
  }
  const output = process.env.AGENTMUX_FOCUS_RETENTION_COST_OUTPUT
  if (output) writeFileSync(output, JSON.stringify({ samples, boundary: 'Related production writer only; not browser quota, full-layout storage or GUI latency.' }) + '\n')
})
