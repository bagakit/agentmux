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
  control: { canInterrupt: true, canSend: true, run: { runId: 'run-1' } }
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
    message: 'CtxMux evicted output before this Attachment could resume it.',
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
    expect(diagnostic?.message).toContain('CtxMux evicted output')
    expect(diagnostic?.subject).toBe(session.control)
  })
})
