import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentMuxFileAgentSessionStore } from '../../dist/index.js'
import type { AgentMuxStoredAgentSession } from '../../src/types.js'

const execute = promisify(execFile)
const worker = fileURLToPath(new URL('../fixtures/antigravity-hook-public-worker.mjs', import.meta.url))
const roots: string[] = []
const nativeId = '00000000-0000-4000-8000-000000000901'
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'amx-antigravity-public-'))
  roots.push(root)
  const transcriptPath = join(root, nativeId, '.system_generated', 'logs', 'transcript.jsonl')
  await mkdir(dirname(transcriptPath), { recursive: true })
  const original = JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'PRIVATE_ORIGINAL_QUESTION' }) + '\n'
  await writeFile(transcriptPath, original)
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const session: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId: 'private-antigravity-session', providerId: 'antigravity',
    executorId: 'antigravity', hostId: 'local', workspacePath: root,
    run: { runId: 'private-synthetic-antigravity-run' }, retiredRuns: [],
    hookBindingId: 'b'.repeat(43), hookToken: 't'.repeat(43), createdAt: 1, updatedAt: 1
  }
  await store.compareAndSwap(null, session)
  const common = { conversationId: nativeId, workspacePaths: [root], transcriptPath,
    artifactDirectoryPath: join(root, nativeId), modelName: 'synthetic-model' }
  const scoped = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_') && key !== 'NODE_OPTIONS'))
  const env = { ...scoped,
    AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
    AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson'), AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json') }
  async function run(label: string, hooks: Array<{ eventName: string; payload: Record<string, unknown>; badToken?: boolean }>, write?: string) {
    const request = join(root, label + '.json')
    await writeFile(request, JSON.stringify({ root, label, hooks, write }))
    const result = await execute(process.execPath, [worker, request], { env, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 })
    const evidence = process.env.ANTIGRAVITY_TEST_EVIDENCE_DIR
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      const prefix = join(evidence, `${basename(root)}-${label}`)
      await writeFile(prefix + '.stdout', result.stdout)
      await writeFile(prefix + '.stderr', result.stderr)
    }
    return JSON.parse(result.stdout)
  }
  return { root, session, common, run,
    async sourceUnchanged() { expect(await readFile(transcriptPath, 'utf8')).toBe(original) } }
}

describe('Antigravity actual built public Hook ingress', () => {
  for (const [label, payload] of [
    ['native-error', { terminationReason: 'error', error: 'PRIVATE_NATIVE_FAILURE', fullyIdle: true }],
    ['background-running', { terminationReason: 'model_stop', fullyIdle: false }],
    ['continuable-idle', { terminationReason: 'model_stop', fullyIdle: true }],
    ['unknown-stop-shape', {}]
  ] as const) {
    it(`keeps ${label} Stop provisional across two ordinary consumer processes`, async () => {
      // Official Stop can return decision=continue: even fullyIdle is observed before
      // all Hook decisions. None of these payloads proves final success/turn-end.
      const h = await harness()
      const first = await h.run('first', [
        { eventName: 'PreInvocation', payload: { ...h.common, invocationNum: 0, initialNumSteps: 1 } },
        { eventName: 'Stop', payload: { ...h.common, executionNum: 1, ...payload } }
      ])
      expect(first.statuses).toEqual([204, 204])
      expect(first.stored).toHaveLength(1)
      expect(first.contexts[1]).toMatchObject({ semanticState: 'unknown', lifecycleEvent: null })
      expect(first.stored[0].semanticStatus.state).toBe('working')
      expect(first.stored[0].hookReceipt).toMatchObject({ eventName: 'Stop', lifecycleEvent: null })
      expect(first.timeline.items.map((item: { title: string }) => item.title)).toEqual(['PreInvocation', 'Stop'])
      expect(first.stored[0].terminalPromptReadiness).toBeUndefined()
      expect(first.stored[0].nativeHandle).toEqual({ kind: 'provider', providerId: 'antigravity', sessionId: nativeId, transcriptPath: h.common.transcriptPath })
      expect(first.restored.map((s: AgentMuxStoredAgentSession) => [s.agentSessionId, s.run])).toEqual([[h.session.agentSessionId, h.session.run]])
      expect(first.counts).toMatchObject({ start: 0, input: 0, resize: 0, stop: 0, attach: 0 })
      const second = await h.run('second', [], 'PRIVATE_NEXT_INPUT\r')
      expect(second.pid).not.toBe(first.pid)
      expect(second.before.map((s: AgentMuxStoredAgentSession) => [s.agentSessionId, s.run])).toEqual([[h.session.agentSessionId, h.session.run]])
      expect(second.stored[0].semanticStatus.state).toBe('working')
      expect(second.stored[0].hookReceipt).toEqual(first.stored[0].hookReceipt)
      expect(second.stored[0].nativeHandle).toEqual(first.stored[0].nativeHandle)
      expect(second.timeline.items).toEqual(first.timeline.items)
      expect(second.input).toEqual(['PRIVATE_NEXT_INPUT\r'])
      expect(second.inputAck).toMatchObject({ runId: h.session.run.runId, acceptedThroughByte: Buffer.byteLength('PRIVATE_NEXT_INPUT\r') })
      expect(second.counts).toMatchObject({ start: 0, input: 1, resize: 0, stop: 0, attach: 0 })
      await h.sourceUnchanged()
    }, 30_000)
  }

  it('uses native nested toolCall name/args through authenticated ingress and preserves frozen context', async () => {
    const h = await harness()
    const payload = { ...h.common, stepIdx: 1,
      toolCall: { name: 'ask_permission', args: { Action: 'read', Target: 'PRIVATE_NATIVE_TOOL_ARGUMENT', Reason: 'Synthetic protocol fixture' } },
      // Unrelated flat fields must not override the actual protocol's nested source.
      tool_name: 'forged_flat_tool', tool_input: { Target: 'FORGED_FLAT_ARGUMENT' } }
    const first = await h.run('nested', [
      { eventName: 'PreInvocation', payload: h.common },
      { eventName: 'PreToolUse', payload, badToken: true },
      { eventName: 'PreToolUse', payload }
    ])
    expect(first.statuses).toEqual([204, 403, 204])
    expect(first.contexts).toHaveLength(2)
    expect(first.contexts[1]).toMatchObject({ frozen: true, handleFrozen: true,
      nativeHandle: { kind: 'provider', providerId: 'antigravity', sessionId: nativeId, transcriptPath: h.common.transcriptPath }, eventName: 'PreToolUse' })
    expect(first.stored).toHaveLength(1)
    expect(first.stored[0].semanticStatus.state).toBe('waiting')
    const tools = first.timeline.items.filter((item: { toolName?: string }) => item.toolName !== undefined)
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ kind: 'permission', toolName: 'ask_permission', toolInput: JSON.stringify(payload.toolCall.args) })
    expect(JSON.stringify(tools)).not.toContain('FORGED_FLAT_ARGUMENT')
    expect(first.stored[0].pendingInteraction).toBeUndefined()
    expect(first.counts).toMatchObject({ start: 0, input: 0, resize: 0, stop: 0, attach: 0 })
    await h.sourceUnchanged()
  })

  it('preserves the actual nested PostToolUse failure without inventing a tool call ID or main completion', async () => {
    const h = await harness()
    const call = { name: 'run_command', args: { CommandLine: 'private-command', Cwd: h.root } }
    const result = await h.run('post', [
      { eventName: 'PreToolUse', payload: { ...h.common, stepIdx: 0, toolCall: call } },
      { eventName: 'PostToolUse', payload: { ...h.common, stepIdx: 0, toolCall: call, error: 'PRIVATE_EXIT_FAILURE' } }
    ])
    expect(result.statuses).toEqual([204, 204])
    const tools = result.timeline.items.filter((item: { toolName?: string }) => item.toolName !== undefined)
    expect(tools).toHaveLength(2)
    expect(tools[0].id).not.toBe(tools[1].id)
    expect(tools[1]).toMatchObject({ toolName: 'run_command', toolInput: JSON.stringify(call.args), status: 'failed', toolOutput: 'PRIVATE_EXIT_FAILURE' })
    expect(result.stored[0].semanticStatus.state).toBe('working')
    expect(result.stored[0].run).toEqual(h.session.run)
    expect(result.counts).toMatchObject({ start: 0, input: 0, resize: 0, stop: 0, attach: 0 })
    await h.sourceUnchanged()
  })
})
