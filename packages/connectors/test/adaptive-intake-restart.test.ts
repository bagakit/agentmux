import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { headlessFixture, until } from '../../core/test/helpers/headless-runtime-fixture.js'
import { consumeJsonReadEntry, type JsonReadAssembly } from '../../core/src/json-read-fragments.js'
import type { AgentMuxMessageEnvelope } from '../../core/src/agent-message-envelope.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs() })
it('original owner process restart retains unknown/waiting frozen wire and continues the exact journal field while its Run stays alive', async () => {
  vi.stubEnv('AGENTMUX_TEST_OWNER_ENTRY', resolve('packages/connectors/test/fixtures/adaptive-intake/owner.mjs'))
  const loader = pathToFileURL(resolve('packages/connectors/test/fixtures/adaptive-intake/source-loader.mjs'))
  const registration = `import { register } from 'node:module'; register(${JSON.stringify(loader.href)}, ${JSON.stringify(import.meta.url)});`
  const h = await headlessFixture({ ownerNodeArgs: ['--import', 'data:text/javascript,' + encodeURIComponent(registration)] }); cleanup.push(h.cleanup)
  let client = await h.client()
  const witness = join(h.root, 'input.jsonl'), body = '完整原文🙂\n'.repeat(5000)
  const session = await client.createAgent({ agentSessionId: 'adaptive-session', createOperationId: 'adaptive-create', providerId: 'pi', executorId: 'pi',
    workspacePath: h.root, injectAgentMuxGuide: false, commandOverride: process.execPath, args: [resolve('packages/core/test/fixtures/prompt-carrier-terminal.mjs')], env: { AGENTMUX_TEST_INPUT_WITNESS: witness } })
  const ready = await until(async () => { try { return JSON.parse(await readFile(witness + '.ready', 'utf8')) } catch { return null } }, Boolean, 'private original PTY')
  const envelope = (messageId: string): AgentMuxMessageEnvelope => ({ schema: 'agentmux.a2a.v1', messageId, operationId: messageId + '-operation',
    sender: { kind: 'external', connectionId: 'adaptive-fixture', actor: { application: { domain: 'fixture.example', appId: 'original-app' }, idType: 'user', userId: 'original-author' }, externalConversationId: 'room', externalMessageId: messageId + '-platform', bindingId: 'binding', bindingRevision: 1, grantId: 'grant', grantRevision: 1 },
    recipient: { kind: 'agent-session', agentSessionId: session.agentSessionId }, senderSessionId: null, senderRunId: null, recipientSessionId: session.agentSessionId,
    recipientRunId: session.run.runId, createdAt: 1, body, threadId: 'thread', correlationId: 'correlation', replyTo: null, workspaceId: null })
  const submit = (messageId: string, execution: 'default' | 'immediate') => client.submitAgentMessage({ agentSessionId: session.agentSessionId, execution,
    ...(execution === 'immediate' ? { admissionIntent: { kind: 'manual-actor' as const, expectedRun: session.run } } : { condition: { expectedRun: session.run, afterSubmissionId: 'unknown-message' } }), envelope: envelope(messageId) })
  const key = (messageId: string) => ({ kind: 'message' as const, agentSessionId: session.agentSessionId, expectedRun: session.run, messageId })
  await h.failInput({ disposition: 'unknown' })
  await submit('unknown-message', 'immediate')
  const unknown = await until(() => client.inspectAgentInput({ key: key('unknown-message') }), v => v?.status === 'unknown', 'unknown actual effect')
  const original = await client.inspectAgentPromptSubmission(key('unknown-message'))
  await submit('waiting-message', 'immediate')
  const waiting = await until(() => client.readAgentInputMailbox({ agentSessionId: session.agentSessionId, maxBytes: 1024 * 1024 }), v => v.items.length === 2, 'original pending recipe')
  expect((await client.inspectAgentInput({ key: key('waiting-message') }))!.status).toBe('waiting')
  expect(JSON.stringify(waiting)).toContain('representation'); expect(JSON.stringify(waiting)).toContain('--field body')
  const first = (await client.readMessage({ messageId: 'unknown-message', field: 'body', maxBytes: 4096 }))!
  expect(first.entry.kind).toBe('fragment'); expect(first.nextCursor).toBeTruthy()
  const reads = async () => (await readFile(witness, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line).text)
  await until(reads, rows => rows.length === 1, 'one original input wire')
  const sent = await reads(); expect(sent[0]).toContain('--field body'); expect(Buffer.byteLength(sent[0])).toBeLessThan(16 * 1024)
  const owner = h.owner, pid = h.ownerProcess.pid
  await client.dispose(); await h.stopOwner(); await rm(join(h.env.AGENTMUX_STATE_DIRECTORY!, 'input-failure'))
  // A new formatter threshold is actually loaded only by the reopened owner.
  h.env.ADAPTIVE_REOPEN_BUDGET = 'reopen-budget'; await h.restart(); client = await h.client()
  expect(h.ownerProcess.pid).not.toBe(pid); expect(h.owner.runtimeId).toBe(owner.runtimeId)
  expect(h.owner.ownerInstanceId).not.toBe(owner.ownerInstanceId)
  expect((await client.statusAgent(session.agentSessionId)).run).toMatchObject({ runId: session.run.runId, pid: ready.pid, state: 'running' })
  expect(await client.inspectAgentInput({ key: key('unknown-message') })).toEqual(unknown)
  expect(await client.inspectAgentPromptSubmission(key('unknown-message'))).toEqual(original)
  const reopened = await client.readAgentInputMailbox({ agentSessionId: session.agentSessionId, maxBytes: 1024 * 1024 })
  const recipes = (page: typeof waiting) => page.items.map(entry => {
    if (entry.kind !== 'item' || entry.item.kind !== 'controlled') throw Error('Expected complete original controlled recipes')
    return { intent: entry.item.intent, message: entry.item.message }
  })
  expect(reopened.queueId).toBe(waiting.queueId); expect(reopened.cut.incarnation).toBe(waiting.cut.incarnation)
  expect(recipes(reopened)).toEqual(recipes(waiting))
  expect((await client.inspectAgentInput({ key: key('waiting-message') }))!.status).toBe('waiting')
  await submit('unknown-message', 'immediate')
  expect(await reads()).toEqual(sent)
  let pending: JsonReadAssembly | undefined, cursor: string | undefined, value: unknown
  let page = first
  for (;;) {
    const assembled = consumeJsonReadEntry({ scopeKey: 'original-message/body', entry: page.entry, maxTotalBytes: 2_000_000, ...(pending ? { pending } : {}) })
    if (assembled.kind === 'complete') { value = assembled.value; break }
    pending = assembled.pending; cursor = page.nextCursor!
    page = (await client.readMessage({ messageId: 'unknown-message', field: 'body', maxBytes: 4096, cursor }))!
  }
  expect(value).toBe(body)
  expect(await reads()).toEqual(sent)
  expect(await client.inspectAgentInput({ key: key('unknown-message') })).toEqual(unknown)
  await client.stopAgent(session.agentSessionId, session.run)
}, 90_000)
