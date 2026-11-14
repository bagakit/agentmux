import { afterEach, expect, it, vi } from 'vitest'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { agentPromptSubmissionOutcome } from '../../../packages/core/src/agent-input-wait.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { focusTaskHandoffNote } from '../../../packages/core/src/focus-task-guidance.js'
import { focusGroupTask } from '../../desktop/src/renderer/src/lib/focus-group-task'
import type { FocusScanLane } from '../../desktop/src/renderer/src/lib/focus-collection-lanes'
import { createMoteConversationStartFixture } from './helpers/mote-conversation-start-fixture.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const factsPath = process.env.AGENTMUX_FOCUS_GROUP_PUBLIC_FACTS, compiledCli = process.env.AGENTMUX_FOCUS_GROUP_PUBLIC_CLI === '1'
const record = (value: object) => { if (factsPath) appendFileSync(factsPath, JSON.stringify(value) + '\n') }

it('production group prompt reaches the exact original Main public queue and stale role never writes', async () => {
  const f = await createMoteConversationStartFixture({ providerId: 'claude' }); closes.push(f.close)
  await f.start('focus-group-main'); await f.settledSetup('focus-group-main')
  const page = await f.rpc.call('space.mote.dialogue.read', { target: f.target, kind: 'main' })
  const reference = page.main.current!, session = (await f.h.client.readAgentSession(reference.sessionId))!
  expect(reference).toBeTruthy(); expect(page.main.roleRevision).toBeTruthy()
  const lane = { id: 'focus-group-original', name: 'Original project', hostId: 'local', projectId: 'original-project',
    workspaceId: 'original-project', topicId: null, path: session.workspacePath, recovery: null,
    contextRefs: [{ hostId: reference.hostId, id: reference.sessionId }] } as FocusScanLane
  const task = focusGroupTask('analyze', lane,
    [{ id: 'original-project', hostId: 'local', name: 'Original project', path: session.workspacePath }],
    { kind: 'mote', topicId: 'launcher:start-fixture' }) as Exclude<ReturnType<typeof focusGroupTask>, string>
  const { prompt, focusTask } = task, fixedNote = focusTaskHandoffNote(focusTask!)
  expect(prompt).toContain('从旁分析这个组'); expect(prompt).not.toContain('Group reference data (JSON):')
  expect(prompt).toContain('用户未确认时不得执行这些动作'); expect(prompt).not.toContain(reference.sessionId)
  expect(focusTask?.selection).toEqual({ kind: 'members', references: [{ hostId: reference.hostId, contextId: reference.sessionId }] })
  expect(fixedNote).toContain('focus --skill'); expect(fixedNote).toContain('focus read --input -')
  const before = f.h.inner.kernel.input.mock.calls.length
  const input = { agentSessionId: reference.sessionId, expectedRun: session.run, operationId: 'focus-group-analysis', prompt, focusTask,
    admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const }
  const submitted = await f.rpc.call('space.mote.dialogue.input.submit', { target: f.target, expectedRoleRevision: page.main.roleRevision!, input })
  let inspected = await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: input.operationId })
  await vi.waitFor(async () => {
    inspected = await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: input.operationId })
    expect(agentPromptSubmissionOutcome(inspected.record)).toBe('terminal-confirmed')
  })
  expect(submitted.route?.reference).toEqual(reference); expect(inspected.route?.reference).toEqual(reference)
  const message = inspected.record?.admission?.intent.message
  expect(message?.userContent).toBe(prompt)
  expect(message?.systemContext).toContain(fixedNote)
  expect(message?.userContent).not.toContain('Group reference data (JSON):')
  expect(f.h.inner.kernel.input.mock.calls.length).toBeGreaterThan(before)
  const after = f.h.inner.kernel.input.mock.calls.length
  const rejected = await f.rpc.call('space.mote.dialogue.input.submit', { target: f.target, expectedRoleRevision: page.main.roleRevision! + ':stale',
    input: { ...input, operationId: 'focus-group-stale-analysis' } }).then(() => null, error => error)
  expect(rejected).toMatchObject({ code: 'MOTE_MAIN_CHANGED' })
  expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(after)
  expect((await f.main.readCurrentMoteMain(f.target)).current).toEqual(reference)
  expect(f.h.started).toHaveLength(1); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
  record({ kind: 'original-public-queue', promptSHA256: createHash('sha256').update(prompt).digest('hex'), prompt, focusTask, fixedNote,
    systemContextSHA256: createHash('sha256').update(message!.systemContext!).digest('hex'), target: f.target,
    reference, run: session.run, operationId: input.operationId, submitted, inspected, rejected: { code: rejected.code, detail: rejected.detail ?? null }, writes: { before, after, afterRejected: f.h.inner.kernel.input.mock.calls.length }, controls: { starts: f.h.started.length, stops: f.h.inner.kernel.stop.mock.calls.length } })
  if (compiledCli) {
    for (const [action, value] of [['read', { target: f.target, kind: 'main' }], ['input', { target: f.target, operationId: input.operationId }]] as const) {
      const args = action === 'read' ? ['space', 'mote', 'dialogue', 'read'] : ['space', 'mote', 'dialogue', 'input', 'inspect']
      const reply = await runCompiledObjectCli(['--endpoint', 'unix:' + f.server.path, ...args, '--input', '-'], objectCliEnvironment(f.h.root), JSON.stringify(value), 45000)
      expect(reply.code, reply.stderr).toBe(0)
      const receipt = JSON.parse(reply.stdout); expect(receipt.ok).toBe(true)
      expect(receipt.operation).toBe(action === 'read' ? 'space.mote.dialogue.read' : 'space.mote.dialogue.input.inspect')
      if (action === 'read') expect(receipt.result.main.current).toEqual(reference)
      else { expect(receipt.result.route.reference).toEqual(reference); expect(agentPromptSubmissionOutcome(receipt.result.record)).toBe('terminal-confirmed') }
      expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(after)
      record({ kind: 'compiled-cli', args, receipt })
    }
  } else record({ kind: 'compiled-cli', status: 'not-run', reason: 'The single ordinary build owner has not yet supplied the compiled CLI candidate.' })
})
