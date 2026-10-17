import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxHostExecutorOwner } from '../src/executor-owner.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { consumeConversationWindowPage } from '../src/conversation-changes.js'
import { readSessionHistoryTextResource } from '../src/session-history-content.js'
import { projectConversationQuestions } from '../src/conversation-questions.js'
import { savedQuestionEvent, savedQuestionId, savedQuestionPrompt } from './helpers/codex-saved-question.js'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { fixtureIso } from '../../../test/fixture-values.mjs'

const close: Array<() => Promise<unknown>> = []
afterEach(async () => {
  try { for (const dispose of close.splice(0).reverse()) await dispose() }
  finally { vi.restoreAllMocks() }
})

const executorId = 'private-source-executor', originalText = 'Original Provider-owned task 中🙂'
async function fixture(providerId: 'codex' | 'claude', options: {
  registration?: 'same-provider' | 'foreign-provider'; owned?: boolean; retired?: boolean; text?: string; records?: unknown[]
} = {}) {
  const text = options.text ?? originalText
  const original = await nativeHistoryFixture(providerId, root => jsonl(providerId === 'codex' ? [
    { type: 'session_meta', payload: { id: 'native-main', cwd: root } },
    { type: 'response_item', payload: { type: 'message', id: 'original-user', role: 'user', content: [{ type: 'input_text', text }] } },
    ...options.records ?? []
  ] : [{ uuid: 'original-user', type: 'user', sessionId: 'native-main', timestamp: fixtureIso(), message: { role: 'user', content: text } }, ...options.records ?? []]))
  close.push(original.close)
  const store = new AgentMuxFileAgentSessionStore(join(original.root, 'reader-sessions.sqlite'))
  const owner = new AgentMuxHostExecutorOwner({ path: join(original.root, 'reader-executors.json'),
    runtimeId: 'original-source-owner', catalog: () => original.client.catalog() })
  const config = { label: 'Exact Host source', providerId: options.registration === 'foreign-provider'
    ? providerId === 'codex' ? 'claude' : 'codex' : providerId,
    command: process.execPath, args: ['private-source-argument'], env: { ORIGINAL_SOURCE_PROFILE: 'host-private-value' }, injectAgentMuxGuide: false }
  const registration = options.registration ? await owner.configure({ executorId, config }) : undefined
  const session: AgentMuxStoredAgentSession = { ...original.session, executorId, ...(options.owned ? {
    creation: { createOperationId: 'original-create', executorRevision: registration?.executor.configRevision ?? 'a'.repeat(64),
      initialPrompt: 'confirmed' as const }
  } : {}) }
  await store.compareAndSwap(null, session)
  if (options.retired) {
    const reservation = { kind: 'stop' as const, reservationId: 'original-retirement', ownerId: 'fixture-owner', ownerPid: process.pid,
      agentSessionId: session.agentSessionId, expectedRun: session.run, operationId: 'original-retirement', expiresAt: Date.now() + 60_000,
      stopOperation: { daemonInstance: 'fixture-native', operationKey: 'original-retirement', runId: session.run.runId } }
    await store.reserveLifecycle(reservation)
    await store.commitLifecycle(reservation, null)
  }
  const client = new AgentMuxClient({ store, hostExecutorOwner: owner })
  close.push(() => client.dispose())
  const resolve = vi.spyOn(owner, 'resolve'), connect = vi.spyOn(client, 'connect')
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map(key => vi.spyOn(Reflect.get(client, 'kernel'), key))
  const provider = client.providers.get(providerId)
  const page = vi.fn<NonNullable<typeof provider.readSessionHistoryPage>>(provider.readSessionHistoryPage!.bind(provider))
  provider.readSessionHistoryPage = page
  const rpc = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client }] })
  close.push(() => rpc.dispose())
  const path = session.nativeHandle!.kind === 'provider' ? session.nativeHandle!.transcriptPath! : ''
  const before = { native: await readFile(path), source: await store.readHistorySource(session.agentSessionId) }
  const unchanged = async () => {
    expect(await readFile(path)).toEqual(before.native)
    expect(await store.readHistorySource(session.agentSessionId)).toEqual(before.source)
    expect(connect).not.toHaveBeenCalled()
    for (const control of controls) expect(control).not.toHaveBeenCalled()
  }
  return { client, rpc, store, session, config, provider, resolve, page, before, unchanged,
    ref: { hostId: 'local', agentSessionId: session.agentSessionId } }
}

for (const providerId of ['codex', 'claude'] as const) {
  it('retains ' + providerId + ' replies and structured tool/question records through the same conversation source', async () => {
    const answer = 'Original assistant reply', question = savedQuestionEvent()
    question.payload.thread_id = 'native-main'
    const records = providerId === 'codex' ? [
      { type: 'response_item', payload: { type: 'message', id: 'original-reply', role: 'assistant', content: [{ type: 'output_text', text: answer }] } },
      { type: 'response_item', payload: { type: 'function_call', id: 'original-tool', call_id: 'original-call', name: 'exec_command', arguments: '{"cmd":"pwd"}' } }, question
    ] : [
      { uuid: 'original-reply', type: 'assistant', sessionId: 'native-main', timestamp: fixtureIso(), message: { role: 'assistant', content: [{ type: 'text', text: answer }] } },
      { uuid: 'original-tool', type: 'assistant', sessionId: 'native-main', timestamp: fixtureIso(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'original-call', name: 'AskUserQuestion', input: { questions: [{ question: 'Original question', options: [{ label: 'Keep' }] }] } }] } }
    ]
    const f = await fixture(providerId, { records }), page = await f.client.sessionHistoryPage(f.session.agentSessionId)
    expect(page.items.some(item => item.kind === 'assistant-message' && item.contentParts.some(part => part.kind === 'text' && part.text === answer))).toBe(true)
    expect(page.items.flatMap(item => item.contentParts).some(part => part.kind === 'tool-call' && part.callId === 'original-call')).toBe(true)
    if (providerId === 'codex') expect(projectConversationQuestions({ agentSessionId: f.session.agentSessionId, historyPage: page })[0])
      .toMatchObject({ questions: [{ question: { id: savedQuestionId, prompt: savedQuestionPrompt } }] })
    const result = consumeConversationWindowPage(await f.rpc.call('agent.conversation.inspect', f.ref))
    expect(result.kind).toBe('complete')
    if (result.kind !== 'complete') throw Error('Expected the original complete conversation')
    const native = result.snapshot.units.flatMap(unit => unit.records).flatMap(record => record.original.kind === 'native' ? [record.original.item] : [])
    expect(native).toEqual([...page.items].reverse())
    expect(f.resolve).not.toHaveBeenCalled()
    await f.unchanged()
  })

  it.each([
    [undefined, false], ['same-provider', false], ['foreign-provider', false],
    [undefined, true], ['same-provider', true], ['foreign-provider', true]
  ] as const)(
    '%s registration does not capture SDK-owned ' + providerId + ' history through public consumers (retired=%s)', async (registration, retired) => {
      const f = await fixture(providerId, { ...(registration ? { registration } : {}), retired }), input = { ...f.ref, source: 'native' as const, kind: 'user-message' as const }
      for (const page of [await f.client.readAgentSessionHistory(input), await f.rpc.call('agent.history', input)]) {
        expect(page.availability).toBe('available')
        expect(page.userMessages?.map(message => message.content)).toEqual([originalText])
      }
      const opened = await f.rpc.call('agent.conversation.inspect', f.ref)
      for (const page of [opened, await f.client.readAgentConversation(f.ref)]) {
        const assembled = consumeConversationWindowPage(page)
        expect(assembled.kind).toBe('complete')
        if (assembled.kind !== 'complete') throw Error('Expected one complete original-source window')
        const records = assembled.snapshot.units.flatMap(unit => unit.records)
        expect(records.map(record => {
          if (record.original.kind !== 'native') throw Error('Expected the original native source')
          return record.original.item.contentParts
        })).toMatchObject([[{ kind: 'text', text: originalText }]])
        const exact = await f.rpc.call('agent.conversation.inspect', { ...f.ref, record: records[0]!.reference! })
        expect(exact.items).toHaveLength(1)
        expect(JSON.stringify(exact)).toContain(originalText)
      }
      const cut = await f.rpc.call('agent.conversation.checkpoint', f.ref)
      expect((await f.rpc.call('agent.conversation.changes', { ...f.ref, checkpoint: cut.checkpoint })).items).toEqual([])
      const nativeCut = await f.client.sessionHistoryCheckpoint(f.session.agentSessionId)
      expect((await f.client.readSessionHistoryChanges(f.session.agentSessionId, { checkpoint: nativeCut })).items).toEqual([])
      const watch = await f.client.observeSessionHistory(f.session.agentSessionId, () => {})
      watch.dispose()
      expect(f.resolve).not.toHaveBeenCalled()
      expect(f.page).toHaveBeenCalled()
      for (const [context] of f.page.mock.calls) expect(context).toMatchObject({ command: f.provider.executable, args: [], env: {} })
      await f.unchanged()
    })

  it('reads exact deferred ' + providerId + ' content without consulting an unrelated Executor owner', async () => {
    const text = 'Original complete native body 中🙂\n'.repeat(100_000), f = await fixture(providerId, { text })
    const page = await f.client.sessionHistoryPage(f.session.agentSessionId), record = page.items[0]!, part = record.contentParts[0]!
    expect(part).toMatchObject({ kind: 'resource', resourceType: 'text' })
    if (part.kind !== 'resource' || part.resourceType !== 'text') throw Error('Expected exact original text resource')
    const result = await readSessionHistoryTextResource(part, 0, { source: page.source, recordId: record.id,
      ...(record.turnId ? { turnId: record.turnId } : {}) }, request => f.client.sessionHistoryResource(f.session.agentSessionId, request))
    expect(result).toMatchObject({ kind: 'text', text })
    expect(f.resolve).not.toHaveBeenCalled()
    await f.unchanged()
  })

  it.each([false, true])('Host-owned ' + providerId + ' source retains its private invocation after retirement=%s', async retired => {
    const f = await fixture(providerId, { owned: true, retired, registration: 'same-provider' })
    expect(f.before.source?.history?.creation?.executorRevision).toBeTypeOf('string')
    const overrides = { commandOverride: 'caller-command', args: ['caller-argument'], env: { CALLER_PROFILE: 'untrusted-profile' } }
    expect((await f.client.sessionHistoryPage(f.session.agentSessionId, overrides)).items[0]?.contentParts).toMatchObject([{ kind: 'text', text: originalText }])
    expect((await f.rpc.call('agent.history', { ...f.ref, source: 'native' })).availability).toBe('available')
    expect((await f.rpc.call('agent.conversation.inspect', f.ref)).items).toHaveLength(1)
    const watch = await f.client.observeSessionHistory(f.session.agentSessionId, () => {}, overrides)
    watch.dispose()
    expect(f.resolve).toHaveBeenCalled()
    for (const [context] of f.page.mock.calls) expect(context).toMatchObject({ command: f.config.command,
      args: f.config.args, env: f.config.env })
    await f.unchanged()
  })

  it.each([false, true])('Host-owned ' + providerId + ' history preserves missing-owner failure after retirement=%s', async retired => {
    const f = await fixture(providerId, { owned: true, retired })
    await expect(f.rpc.call('agent.history', { ...f.ref, source: 'native' })).rejects.toMatchObject({ code: 'HOST_EXECUTOR_NOT_FOUND' })
    await expect(f.client.sessionHistoryPage(f.session.agentSessionId, { commandOverride: 'caller-command' })).rejects.toMatchObject({ code: 'HOST_EXECUTOR_NOT_FOUND' })
    expect(f.page).not.toHaveBeenCalled()
    await f.unchanged()
  })
}
