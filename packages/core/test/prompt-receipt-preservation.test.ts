import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore, type AgentMuxAgentSessionStore } from '../src/agent-session-store.js'
import { parsePromptSubmissionRecord, terminalPromptPhaseOperationIdentity, mergePtyPromptRecord } from '../src/prompt-submission-record.js'
import { agentPromptSubmissionOutcome } from '../src/agent-input-wait.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import type { AgentMuxStoredAgentSession, AgentPromptSubmissionRecord } from '../src/types.js'
import { inspectPromptInSecondProcess } from './helpers/prompt-receipt-process.js'

const body = 'Original body 原文'
function session(): AgentMuxStoredAgentSession {
  return { kind: 'agent', agentSessionId: 'original-session', run: { runId: 'original-run' }, providerId: 'codex',
    executorId: 'codex', hostId: 'local', workspacePath: tmpdir(), retiredRuns: [], hookBindingId: 'original-hook',
    hookToken: 'test-only', createdAt: 1, updatedAt: 1 }
}
function record(owner = session(), id = 'original-input', complete = true, text = body): AgentPromptSubmissionRecord {
  const plan = { kind: 'render-then-submit' as const, payload: text, renderedText: text, submit: '\r' }, start = 10
  const phase = (name: 'payload' | 'submit', data: string, offset: number, acknowledged: boolean) => ({
    operationId: terminalPromptPhaseOperationIdentity(owner, id, name, data),
    inputByteRange: { startByte: offset, endByte: offset + Buffer.byteLength(data) }, acknowledged })
  const payload = phase('payload', text, start, true), submit = phase('submit', '\r', payload.inputByteRange.endByte, complete)
  return { agentSessionId: owner.agentSessionId, run: owner.run, nativeResult: { state: 'unsupported', reason: 'uncorrelated-carrier' },
    admission: { operationId: payload.operationId, submissionId: id,
      inputKey: { kind: 'prompt', agentSessionId: owner.agentSessionId, expectedRun: owner.run, submissionId: id },
      inputDispatch: { ref: { key: { kind: 'prompt', agentSessionId: owner.agentSessionId, expectedRun: owner.run, submissionId: id }, waitGeneration: 1 }, gateId: 'original-gate' },
      startByte: start, endByte: submit.inputByteRange.endByte, acknowledged: complete,
      intent: { run: owner.run, ownerInstanceId: 'test-runtime', prompt: text, plan, message: { userContent: text }, execution: 'immediate' } },
    terminalPromptSubmission: { run: owner.run, submissionId: id, promptDigest: createHash('sha256').update(text).digest('base64url'),
      outputCursorBytes: 1, payload, submit } }
}
function project(owner: AgentMuxStoredAgentSession, value: AgentPromptSubmissionRecord): AgentMuxStoredAgentSession {
  return { ...owner, ...(value.admission ? { promptCompletionAdmission: value.admission } : {}),
    ...(value.terminalPromptSubmission ? { terminalPromptSubmission: value.terminalPromptSubmission } : {}) }
}
async function retire(store: AgentMuxAgentSessionStore, one: AgentMuxStoredAgentSession) {
  const reservation = { kind: 'stop' as const, agentSessionId: one.agentSessionId, expectedRun: one.run,
    reservationId: 'test-retirement', ownerId: 'test-owner', ownerPid: process.pid, expiresAt: Date.now() + 30_000,
    operationId: 'original-stop', stopOperation: { daemonInstance: 'test-no-runtime', operationKey: 'original-stop', runId: one.run.runId } }
  await store.reserveLifecycle(reservation)
  return (await store.commitLifecycle(reservation, null))!
}
async function fixture(kind: 'file' | 'memory') {
  const root = await mkdtemp(join(tmpdir(), 'amux-prompt-receipt-'))
  const store = kind === 'file' ? new AgentMuxFileAgentSessionStore(join(root, 'sessions.sqlite')) : new AgentMuxMemoryAgentSessionStore()
  const read = (one = session(), id = 'original-input') => store.readPromptAdmission(one.agentSessionId, one.run, id)
  return { root, store, read, close: () => rm(root, { recursive: true, force: true }) }
}

for (const kind of ['memory', 'file'] as const) describe(kind + ' original PTY receipts', () => {
  it('retains exact phase ACKs when current cleanup weakens or removes the terminal projection', async () => {
    const f = await fixture(kind), one = session(), original = record(one)
    try {
      await f.store.compareAndSwap(null, project(one, original))
      const before = await f.read()
      const current = (await f.store.readMetadata(one.agentSessionId))!
      const weak = { ...current, updatedAt: 2, promptCompletionAdmission: { ...current.promptCompletionAdmission!, acknowledged: false } }
      delete weak.terminalPromptSubmission
      await f.store.compareAndSwapMetadata(current, weak)
      expect(await f.read()).toEqual(before)
      expect(agentPromptSubmissionOutcome(await f.read())).toBe('terminal-confirmed')
      expect((await f.store.readMetadata(one.agentSessionId))?.terminalPromptSubmission).toBeUndefined()
      await retire(f.store, weak)
      expect(await f.read()).toEqual(before)
    } finally { await f.close() }
  })

  it('settles the exact retired original row without reactivating or rewriting retirement', async () => {
    const f = await fixture(kind), one = session(), original = record(one)
    try {
      const damaged = project(one, original); delete damaged.terminalPromptSubmission
      await f.store.compareAndSwap(null, damaged)
      const retirement = await retire(f.store, damaged), expected = (await f.read())!
      await f.store.settlePromptAdmission(expected, original)
      expect(await f.read()).toEqual(original)
      expect(agentPromptSubmissionOutcome(await f.read())).toBe('terminal-confirmed')
      expect(await f.store.readMetadata(one.agentSessionId)).toBeNull()
      expect(await f.store.readRetiredAgentSession(one.agentSessionId)).toEqual(retirement)
      expect(parseRpcNativeResult('agent.input.inspect', { record: await f.read() }, { key: original.admission!.inputKey! })).toEqual({ record: original })
    } finally { await f.close() }
  })

  it('historical settlement cannot move another current Run or input slot backwards', async () => {
    const f = await fixture(kind), one = session(), original = record(one)
    try {
      const damaged = project(one, original); delete damaged.terminalPromptSubmission
      await f.store.compareAndSwap(null, damaged)
      const current = project({ ...one, run: { runId: 'new-run' }, retiredRuns: [one.run], updatedAt: 2 },
        record({ ...one, run: { runId: 'new-run' } }, 'new-input'))
      await f.store.compareAndSwapMetadata(damaged, current)
      const expected = (await f.read())!, latest = await f.store.readMetadata(one.agentSessionId)
      await f.store.settlePromptAdmission(expected, original)
      expect(await f.read()).toEqual(original)
      expect(await f.store.readMetadata(one.agentSessionId)).toEqual(latest)
    } finally { await f.close() }
  })

  it('PTY settlement adds only independent receipt evidence and never rewrites the matching current projection', async () => {
    const f = await fixture(kind), one = session(), original = record(one)
    try {
      const damaged = project(one, original); delete damaged.terminalPromptSubmission
      await f.store.compareAndSwap(null, damaged)
      const latest = await f.store.readMetadata(one.agentSessionId), expected = (await f.read())!
      await f.store.settlePromptAdmission(expected, original)
      expect(await f.read()).toEqual(original)
      expect(await f.store.readMetadata(one.agentSessionId)).toEqual(latest)
    } finally { await f.close() }
  })

  it.each(['digest', 'phase-operation', 'phase-bytes'] as const)('rejects newly supplied terminal evidence with a different %s', async field => {
    const f = await fixture(kind), one = session(), original = record(one)
    try {
      const damaged = project(one, original); delete damaged.terminalPromptSubmission
      await f.store.compareAndSwap(null, damaged)
      const before = (await f.read())!, conflicting = structuredClone(original)
      if (field === 'digest') conflicting.terminalPromptSubmission!.promptDigest = 'different-source-prompt'
      if (field === 'phase-operation') conflicting.terminalPromptSubmission!.submit.operationId = 'other-phase'
      if (field === 'phase-bytes') {
        conflicting.terminalPromptSubmission!.payload.inputByteRange.endByte--
        conflicting.terminalPromptSubmission!.submit.inputByteRange.startByte--
      }
      await expect(f.store.settlePromptAdmission(before, conflicting)).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
      expect(await f.read()).toEqual(before)
    } finally { await f.close() }
  })

  it.each(['body', 'key', 'gate', 'run', 'range', 'operation', 'refusal'] as const)('rejects conflicting %s and preserves the original independently', async field => {
    const f = await fixture(kind), original = record(), owner = project(session(), original)
    try {
      await f.store.compareAndSwap(null, owner)
      const before = await f.read(), next = structuredClone(original)
      if (field === 'body') next.admission!.intent!.prompt = 'different original content'
      if (field === 'key') Object.assign(next, record(session(), 'other-input'))
      if (field === 'gate') next.admission!.inputDispatch!.gateId = 'other-gate'
      if (field === 'run') Object.assign(next, record({ ...session(), run: { runId: 'foreign-run' } }))
      if (field === 'range') next.terminalPromptSubmission!.submit.inputByteRange.endByte++
      if (field === 'operation') next.terminalPromptSubmission!.submit.operationId = 'other-operation'
      if (field === 'refusal') { next.terminalPromptSubmission!.submit.acknowledged = false; next.terminalPromptSubmission!.submit.notApplied = true }
      await expect(f.store.settlePromptAdmission(before!, next)).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
      expect(await f.read()).toEqual(before)
    } finally { await f.close() }
  })

  it('preserves partial chunks and allows only matching prefix ACK advancement', async () => {
    const f = await fixture(kind), one = session(), original = record(one), claim = original.admission!
    try {
      claim.intent!.plan = { kind: 'single-phase', data: 'abcdefgh' }
      Object.assign(claim, { operationId: 'single-phase', startByte: 0, endByte: 8, acknowledged: false,
        chunks: [{ operationId: 'chunk-a', inputByteRange: { startByte: 0, endByte: 4 }, acknowledged: true },
          { operationId: 'chunk-b', inputByteRange: { startByte: 4, endByte: 8 }, acknowledged: false }] })
      delete original.terminalPromptSubmission
      await f.store.compareAndSwap(null, project(one, original))
      const weaker = structuredClone(original); weaker.admission!.chunks![0]!.acknowledged = false
      await f.store.settlePromptAdmission((await f.read())!, weaker)
      expect((await f.read())?.admission?.chunks).toEqual(claim.chunks)
      const completed = structuredClone(original); completed.admission!.chunks![1]!.acknowledged = true; completed.admission!.acknowledged = true
      await f.store.settlePromptAdmission((await f.read())!, completed)
      expect(agentPromptSubmissionOutcome(await f.read())).toBe('terminal-confirmed')
      const conflict = structuredClone(completed); conflict.admission!.chunks![1]!.operationId = 'foreign-chunk'
      await expect(f.store.settlePromptAdmission((await f.read())!, conflict)).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
    } finally { await f.close() }
  })

  it('keeps explicit record deletion terminal and stale settlement fenced', async () => {
    const f = await fixture(kind), one = session(), partial = record(one, 'original-input', false)
    try {
      await f.store.compareAndSwap(null, project(one, partial))
      const before = (await f.read())!, next = record(one)
      await f.store.settlePromptAdmission(before, next)
      await expect(f.store.settlePromptAdmission(before, next)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
      const retirement = await retire(f.store, (await f.store.readMetadata(one.agentSessionId))!)
      await f.store.deleteRecord(retirement, 'original-delete')
      await expect(f.store.settlePromptAdmission(next, next)).rejects.toMatchObject({ code: 'AGENT_SESSION_RECORD_DELETED' })
    } finally { await f.close() }
  })

  it('restores exact redraw history through settlement and preserves it through parser, public codec and later projection', async () => {
    const f = await fixture(kind), one = session(), original = record(one), sourceId = 'original-native-source'
    const plan = original.admission!.intent!.plan
    if (plan.kind !== 'render-then-submit') throw Error('Fixture carrier changed')
    plan.prepare = { interrupt: '\x1b', endEvent: 'Interrupt', refresh: '\x1b[I' }
    const refresh = (revision: number) => ({ operationId: terminalPromptPhaseOperationIdentity(one, 'original-input', 'refresh',
      JSON.stringify([plan.prepare!.refresh, sourceId, revision])), inputByteRange: { startByte: revision * 3, endByte: revision * 3 + 3 },
      acknowledged: true, nativeSourceId: sourceId, resizeRevision: revision, outputCursorBytes: revision })
    original.admission!.frameRefresh = refresh(2)
    original.ptyRefreshHistory = [refresh(0), refresh(1)]
    try {
      // A pre-upgrade source can lack this history while retaining the exact main claim.
      await f.store.compareAndSwap(null, project(one, original))
      const expected = (await f.read())!
      expect(expected).not.toHaveProperty('ptyRefreshHistory')
      await f.store.settlePromptAdmission(expected, original)
      expect(await f.read()).toEqual(original)
      expect(parsePromptSubmissionRecord(await f.read())).toEqual(original)
      expect(parseRpcNativeResult('agent.input.inspect', { record: await f.read() }, { key: original.admission!.inputKey! })).toEqual({ record: original })
      const current = (await f.store.readMetadata(one.agentSessionId))!, next = { ...current, updatedAt: 2 }
      delete next.terminalPromptSubmission
      await f.store.compareAndSwapMetadata(current, next)
      expect(await f.read()).toEqual(original)
      if (kind === 'file') {
        const cold = await inspectPromptInSecondProcess(f.root, original.admission!.inputKey!, join(f.root, 'sessions.sqlite'))
        expect(cold.readback.pid).not.toBe(process.pid)
        expect(cold.readback.record).toEqual(original)
        expect(cold.cli).toMatchObject({ ok: true, result: { record: original } })
      }
      const conflicting = structuredClone(original); conflicting.ptyRefreshHistory![0]!.outputCursorBytes++
      await expect(f.store.settlePromptAdmission(original, conflicting)).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
    } finally { await f.close() }
  })
})

it('keeps legacy absent refresh history absent through the original record decoder', () => {
  const original = record()
  expect(parsePromptSubmissionRecord(original)).toEqual(original)
  expect(parsePromptSubmissionRecord(original)).not.toHaveProperty('ptyRefreshHistory')
})

it.each(['plain text', '原文 🙂', 'lone surrogate \ud800', 'x'.repeat(4096)])('decodes original PTY receipts without Node globals for %s', text => {
  const original = record(session(), 'portable-original-input', true, text)
  const prepared = record(session(), 'portable-original-input', false, text)
  const expected = createHash('sha256').update(JSON.stringify(['agentmux-terminal-prompt-v1', original.agentSessionId,
    original.run.runId, original.terminalPromptSubmission!.submissionId, 'payload', text])).digest('base64url')
  expect(original.terminalPromptSubmission!.payload.operationId).toBe(expected)
  vi.stubGlobal('Buffer', undefined)
  try {
    expect(parsePromptSubmissionRecord(original)).toMatchObject(original)
    expect(mergePtyPromptRecord(prepared, original, true)).toMatchObject(original)
  }
  finally { vi.unstubAllGlobals() }
})
