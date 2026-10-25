import { afterEach, expect, it } from 'vitest'
import { appendFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession, AgentNativePromptInputPlan } from '../src/types.js'

const roots: string[] = []
afterEach(async () => {
  const results = await Promise.allSettled(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Private Store cleanup failed')
})

function database<T>(path: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path)
  try { return read(db) } finally { db.close() }
}
function writes(path: string) {
  return database(path, db => db.prepare('SELECT kind,event FROM admission_write_audit ORDER BY rowid').all())
}
function resetWrites(path: string) { database(path, db => db.exec('DELETE FROM admission_write_audit')) }
function recordCost(name: string, rows: ReturnType<typeof writes>): void {
  const directory = process.env.AGENTMUX_SESSION_ADMISSION_PROOF_DIR
  if (directory) appendFileSync(join(directory, 'cost.jsonl'), JSON.stringify({ name, rows }) + '\n')
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'am-admission-cost-')); roots.push(root)
  const path = join(root, 'sessions.json'), store = new AgentMuxFileAgentSessionStore(path)
  const initial: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original', providerId: 'fixture', executorId: 'fixture',
    hostId: 'local', workspacePath: root, run: { runId: 'original-run' }, retiredRuns: [],
    hookBindingId: 'original-hook', hookToken: 'private-token', createdAt: 100, updatedAt: 100 }
  await store.compareAndSwap(null, initial)
  // These triggers observe real SQL execution on this disposable fixture only.
  // Close the observer connection before the Store acquires its own transaction.
  database(path, db => db.exec(`
    CREATE TABLE admission_write_audit (kind TEXT, event TEXT);
    CREATE TRIGGER admission_insert AFTER INSERT ON prompt_admissions
      BEGIN INSERT INTO admission_write_audit VALUES ('admission','insert'); END;
    CREATE TRIGGER admission_update AFTER UPDATE ON prompt_admissions
      BEGIN INSERT INTO admission_write_audit VALUES ('admission','update'); END;
    CREATE TRIGGER metadata_update AFTER UPDATE ON sessions
      BEGIN INSERT INTO admission_write_audit VALUES ('metadata','update'); END;
  `))
  const registry = new AgentMuxAgentSessionRegistry(store); await registry.load('local')
  const admit = async (submissionId: string) => {
    const plan: AgentNativePromptInputPlan = { kind: 'native-rpc', operation: 'start-or-steer', protocolId: 'original-protocol',
      sourceId: 'original-source', actorId: 'original-actor', threadId: 'original-thread' }
    await registry.update(initial.agentSessionId, initial.run, current => ({ ...current, updatedAt: current.updatedAt + 1,
      promptCompletionAdmission: { transport: 'native', submissionId, operationId: submissionId,
        acknowledged: false, notApplied: false, native: { plan, outcome: 'claimed' },
        intent: { run: initial.run, ownerInstanceId: 'original-runtime', prompt: 'Body ' + submissionId, plan,
          execution: 'immediate', message: { userContent: 'Body ' + submissionId, authorHuman: true } } } }))
    const saved = await store.readPromptAdmission(initial.agentSessionId, initial.run, submissionId)
    expect(saved?.admission?.submissionId).toBe(submissionId)
    return saved!
  }
  return { path, store, registry, initial, admit, reopen: () => new AgentMuxFileAgentSessionStore(path) }
}

it('does not rewrite equal admissions during a real Registry metadata update', async () => {
  const f = await fixture()
  const originalA = await f.admit('A'), originalB = await f.admit('B')
  // Positive control: the observer saw real new records before measuring zero writes.
  expect(writes(f.path).filter(row => row.kind === 'admission' && row.event === 'insert')).toHaveLength(2)
  resetWrites(f.path)
  const next = await f.registry.update(f.initial.agentSessionId, f.initial.run,
    current => ({ ...current, hookToken: 'changed-private-token', updatedAt: current.updatedAt + 1 }))
  const observed = writes(f.path); recordCost('registry-metadata', observed)
  expect(observed.filter(row => row.kind === 'metadata')).toHaveLength(1)
  expect(observed.filter(row => row.kind === 'admission'), 'Unchanged original admissions must execute zero SQL writes').toHaveLength(0)
  const reopened = f.reopen()
  expect(await reopened.readMetadata(f.initial.agentSessionId)).toEqual(next)
  expect(await reopened.readPromptAdmission(f.initial.agentSessionId, f.initial.run, 'A')).toEqual(originalA)
  expect(await reopened.readPromptAdmission(f.initial.agentSessionId, f.initial.run, 'B')).toEqual(originalB)
})

it('persists exact unknown and final receipts while rejecting changed frozen claims', async () => {
  const f = await fixture(), claimed = await f.admit('A')
  const unknown = structuredClone(claimed)
  unknown.admission!.native!.outcome = 'unknown'
  resetWrites(f.path)
  await f.store.settlePromptAdmission(claimed, unknown)
  expect(writes(f.path).filter(row => row.kind === 'admission')).toHaveLength(1)
  expect(await f.reopen().readPromptAdmission(f.initial.agentSessionId, f.initial.run, 'A')).toEqual(unknown)
  resetWrites(f.path)
  await f.store.settlePromptAdmission(unknown, structuredClone(unknown))
  expect(writes(f.path).filter(row => row.kind === 'admission')).toHaveLength(0)
  // The equal receipt still performs the original Session transaction.
  expect(writes(f.path).filter(row => row.kind === 'metadata')).toHaveLength(1)
  const final = structuredClone(unknown)
  final.admission!.native = { ...final.admission!.native!, outcome: 'admitted', turnId: 'original-turn' }
  final.admission!.acknowledged = true
  await f.store.settlePromptAdmission(unknown, final)
  expect(await f.reopen().readPromptAdmission(f.initial.agentSessionId, f.initial.run, 'A')).toEqual(final)
  const changedFinal = structuredClone(final)
  changedFinal.admission!.native!.turnId = 'other-turn'
  await expect(f.store.settlePromptAdmission(final, changedFinal)).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  const current = (await f.store.readMetadata(f.initial.agentSessionId))!, changed = structuredClone(current)
  changed.promptCompletionAdmission!.intent!.prompt = 'A different body'
  await expect(f.store.compareAndSwapMetadata(current, changed)).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  expect(await f.reopen().readPromptAdmission(f.initial.agentSessionId, f.initial.run, 'A')).toEqual(final)
})

it('preserves a missing original admission before replacement and keeps history after deletion', async () => {
  const f = await fixture(), originalA = await f.admit('A')
  // Model an original latest slot that has not yet been copied into its retained table.
  database(f.path, db => db.prepare('DELETE FROM prompt_admissions WHERE session_id=?').run(f.initial.agentSessionId))
  resetWrites(f.path)
  const originalB = await f.admit('B')
  expect(writes(f.path).filter(row => row.kind === 'admission' && row.event === 'insert')).toHaveLength(2)
  await f.registry.delete(f.initial.agentSessionId, f.initial.run)
  const reopened = f.reopen()
  expect(await reopened.readMetadata(f.initial.agentSessionId)).toBeNull()
  expect(await reopened.readPromptAdmission(f.initial.agentSessionId, f.initial.run, 'A')).toEqual(originalA)
  expect(await reopened.readPromptAdmission(f.initial.agentSessionId, f.initial.run, 'B')).toEqual(originalB)
})

it('uses deep equality when stored admission JSON property order differs', async () => {
  const f = await fixture(), original = await f.admit('A')
  database(f.path, db => {
    const row = db.prepare('SELECT json FROM prompt_admissions WHERE session_id=?').get(f.initial.agentSessionId)!
    const value = JSON.parse(String(row.json)) as Record<string, unknown>
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(value).reverse()))
    expect(reordered).not.toBe(String(row.json))
    db.prepare('UPDATE prompt_admissions SET json=? WHERE session_id=?').run(reordered, f.initial.agentSessionId)
  })
  resetWrites(f.path)
  await f.registry.update(f.initial.agentSessionId, f.initial.run, current => ({ ...current, updatedAt: current.updatedAt + 1 }))
  expect(writes(f.path).filter(row => row.kind === 'admission')).toHaveLength(0)
  expect(await f.reopen().readPromptAdmission(f.initial.agentSessionId, f.initial.run, 'A')).toEqual(original)
})
