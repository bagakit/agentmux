import { describe, expect, it } from 'vitest'
import { reduceRuntimeEvent, runtimeDiagnosticNotice } from '../src/renderer/src/lib/session-state.js'
import type { RuntimeEvent, SessionSnapshot } from '../src/shared/contracts.js'

// OUTPUT_GAP is a service-window diagnostic. It must survive either event order without
// replacing the Run-owned state. The mounted Core→Store→App path is covered by
// agent-flow-diagnostic-projection.test.tsx.

const SESSION: SessionSnapshot = {
  id: 'agent-1',
  kind: 'agent',
  providerId: 'codex',
  executorId: 'codex',
  hostId: 'local',
  workspacePath: '/repo',
  label: 'Agent',
  createdAt: 1,
  updatedAt: 1,
  processState: 'running',
  latestOutputBytes: 0,
  capabilities: { interaction: false, posture: false, skills: false, commands: false },
  run: { runId: 'run-1' },
  status: { state: 'running', source: 'run-process', observedAt: 1 },
  // reducer 认 run 身份走的是 `control.run`（session-state.ts:75、:71），不是顶层 `run`。两处都给
  // 同一个 runId，免得 fixture 形状对不上导致测试静默失明。
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'agent-1', run: { runId: 'run-1' } }
} as unknown as SessionSnapshot

const OBSERVED_AT = 100

/** Core 事件经 `{type:'core', hostId, event}` 这层信封到达 renderer——reducer 读的是 `.event`。 */
function wrap(event: unknown): RuntimeEvent {
  return { type: 'core', hostId: 'local', event } as RuntimeEvent
}

function gapError(): RuntimeEvent {
  return wrap({
    type: 'agent-error',
    agentSessionId: 'agent-1',
    code: 'OUTPUT_GAP',
    message: 'This Attachment did not receive a continuous output stream.',
    evidence: { source: 'terminal-output', observedAt: OBSERVED_AT, run: { runId: 'run-1' } }
  })
}

function runningState(): RuntimeEvent {
  return wrap({
    type: 'process-state',
    agentSessionId: 'agent-1',
    state: 'running',
    run: { runId: 'run-1' },
    evidence: { source: 'run-process', observedAt: OBSERVED_AT }
  })
}

function apply(events: RuntimeEvent[]): SessionSnapshot {
  let state = { sessions: [SESSION] } as unknown as Parameters<typeof reduceRuntimeEvent>[0]
  for (const event of events) state = reduceRuntimeEvent(state, event)
  return (state as unknown as { sessions: SessionSnapshot[] }).sessions[0]!
}

describe('output gap diagnostics and Run state have separate owners', () => {
  it.each([
    ['running then gap', [runningState(), gapError()]],
    ['gap then running', [gapError(), runningState()]]
  ])('%s keeps the diagnostic and the known Run fact', (_label, events) => {
    const session = apply(events as RuntimeEvent[])
    expect(session.status).toEqual({ state: 'running', source: 'run-process', observedAt: OBSERVED_AT })
    const diagnostic = runtimeDiagnosticNotice({ sessions: [session] }, gapError())
    expect(diagnostic?.message).toContain('OUTPUT_GAP')
    expect(diagnostic?.message).toContain('Attachment did not receive a continuous output stream')
    expect(diagnostic?.subject).toBe(session.control)
  })

  const terminal = {
    ...SESSION, id: 'run-1', kind: 'terminal', label: 'Build terminal', providerId: null,
    control: { kind: 'terminal', hostId: 'local', runId: 'run-1', run: { runId: 'run-1' } }
  } as SessionSnapshot
  const unnamed = (): RuntimeEvent => {
    const event = gapError()
    if (event.event.type !== 'agent-error') throw new Error('Expected diagnostic')
    delete event.event.agentSessionId
    return event
  }

  it.each([SESSION, terminal])('locates the unique current $kind using Host and Run without an Agent mapping', session => {
    const diagnostic = runtimeDiagnosticNotice({ sessions: [session] }, unnamed())
    expect(diagnostic?.subject).toBe(session.control)
    expect(diagnostic?.message).toContain(`\"${session.label}\" on host \"local\"; Run \"run-1\"`)
    expect(diagnostic?.message).toContain('Run state: running')
    expect(diagnostic?.message).not.toContain('could not be confirmed')
    expect(diagnostic?.message).toContain('does not establish complete history or confirm input delivery')
    if (session.kind === 'terminal') expect(diagnostic?.message).not.toContain('Agent state')
  })

  it('uses the Host fence when another Host projects the same Run', () => {
    const remote = { ...SESSION, hostId: 'remote', control: { ...SESSION.control, hostId: 'remote' } }
    const diagnostic = runtimeDiagnosticNotice({ sessions: [remote, terminal] }, unnamed())
    expect(diagnostic?.subject).toBe(terminal.control)
    expect(diagnostic?.message).toContain('Terminal \"Build terminal\" on host \"local\"')
  })

  it.each([
    ['absent', []],
    ['ambiguous', [SESSION, terminal]],
    ['other Host', [{ ...SESSION, hostId: 'remote' }]],
    ['old Run', [{ ...SESSION, control: { ...SESSION.control, run: { runId: 'successor' } } }]]
  ])('preserves the known Host/Run with %s current Session scope', (_case, sessions) => {
    const diagnostic = runtimeDiagnosticNotice({ sessions: sessions as SessionSnapshot[] }, unnamed())
    expect(diagnostic?.subject).toBeUndefined()
    expect(diagnostic?.message).toContain('Host \"local\"; Run \"run-1\"')
    expect(diagnostic?.message).toContain('current Session could not be confirmed')
  })

  it.each(['wrong Host', 'old Run'])('keeps the explicit Agent %s rejection even if another Session matches the Run', mismatch => {
    const named = mismatch === 'wrong Host'
      ? { ...SESSION, hostId: 'remote' }
      : { ...SESSION, control: { ...SESSION.control, run: { runId: 'successor' } } }
    expect(runtimeDiagnosticNotice({ sessions: [named, terminal] }, gapError())).toBeNull()
  })

  it('does not reassign an absent explicit Agent identity to a Terminal with its Run', () => {
    const diagnostic = runtimeDiagnosticNotice({ sessions: [terminal] }, gapError())
    expect(diagnostic?.subject).toBeUndefined()
    expect(diagnostic?.message).toContain('Agent \"agent-1\"')
    expect(diagnostic?.message).toContain('Run \"run-1\"')
    expect(diagnostic?.message).not.toContain('Build terminal')
  })

  it('does not invent a Run from the current Session when the diagnostic has no Run', () => {
    const event = gapError()
    if (event.event.type !== 'agent-error') throw new Error('Expected diagnostic')
    delete event.event.evidence.run
    const diagnostic = runtimeDiagnosticNotice({ sessions: [SESSION] }, event)
    expect(diagnostic?.subject).toBeUndefined()
    expect(diagnostic?.message).toContain('current Session could not be confirmed')
    expect(diagnostic?.message).not.toContain('Run \"run-1\"')
  })

  it.each([0, 42, null])('discloses the actual live cursor %s without converting it to delivery', cursor => {
    const event = gapError()
    if (event.event.type !== 'agent-error') throw new Error('Expected diagnostic')
    event.event.evidence.outputGap = { kind: 'live-stream', latestOutputBytes: 99,
      publishedThroughByte: cursor, representation: cursor === null ? null : 'raw' }
    const diagnostic = runtimeDiagnosticNotice({ sessions: [SESSION] }, event)
    expect(diagnostic?.subject).toBe(SESSION.control)
    expect(diagnostic?.message).toContain('Observed at (Unix ms): 100. Gap phase: live-stream. Cause: unknown.')
    expect(diagnostic?.message).toContain(`Gap latest output byte: 99. Core published-through byte: ${cursor ?? 'unknown'}.`)
    expect(diagnostic?.message).toContain('The publication boundary is not a Renderer parsing or Input acknowledgement.')
    expect(diagnostic?.message).not.toContain('Replay requested')
  })

  it('discloses only the actual replay request and snapshot retention facts', () => {
    const event = gapError()
    if (event.event.type !== 'agent-error') throw new Error('Expected diagnostic')
    event.event.evidence.outputGap = { kind: 'replay', latestOutputBytes: 99, requestedAfterByte: 4, firstAvailableByte: 20 }
    const diagnostic = runtimeDiagnosticNotice({ sessions: [SESSION] }, event)
    expect(diagnostic?.message).toContain('Gap phase: replay. Cause: unknown.')
    expect(diagnostic?.message).toContain('Replay requested after byte: 4. First available byte: 20. Snapshot latest output byte: 99.')
    expect(diagnostic?.message).not.toContain('Core published-through')
    expect(diagnostic?.message).toContain('does not establish complete history or confirm input delivery')
  })
})
