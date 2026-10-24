import { appendFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import { moteChatDiagnosisKey } from '@agentmux/core/mote-chat'
import { MoteChatStore } from '../../../packages/connectors/src/mote-chat-store.js'
import { moteChatJourneyFixture } from '../../../packages/connectors/test/fixtures/mote-chat-journey.js'
import { encodeCwdDirname } from '../../../packages/core/src/providers/grok-native-history.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { runSourceObjectCli } from '../../../packages/core/test/helpers/source-object-cli.js'

it.each(['claude', 'grok'] as const)('current native coverage for a %s private generation survives the actual Host, safe RPC and source CLI', async providerId => {
  const f = await moteChatJourneyFixture(1, 60_000, 'headless', false, providerId)
  const status = f.inner.kernel.status as (id: string) => Promise<ReturnType<typeof f.run>>
  f.inner.kernel.status = async id => ({ ...await status(id), acceptedInputBytes: f.run(id).acceptedInputBytes })
  expect(await f.wire.post(f.message('first-original'))).toBe(202)
  const first = await f.claimed('first-original'), sessionId = first.input!.agentSessionId
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: first.ingressId })).inputReceipt?.status).toBe('terminal-confirmed'))
  const binding = new MoteChatStore(f.services.database!).generationBySession(sessionId)!.binding!
  const publication = f.services.publication!, list = () => publication.list({ connectionId: binding.connectionId, bindingId: binding.bindingId, bindingRevision: binding.revision })
  await f.reply(sessionId, 'old-original-answer', 'An older confirmed answer is not this query answer.')
  await vi.waitFor(async () => expect((await list()).deliveries.filter(row => row.reference.source.kind === 'native')).toMatchObject([{ state: 'confirmed' }]), { timeout: 8_000 })
  const original = (await list()).deliveries.find(row => row.reference.source.kind === 'native')!
  expect((await list()).sourceObservation?.state).toBe('ready')

  const provider = (f.client as unknown as { providers: core.AgentProviderRegistry }).providers.get(providerId)
  expect(typeof provider.readConversationChanges).toBe('function')
  const nativeChanges = provider.readConversationChanges!.bind(provider)
  // A fresh native head and its watch can be healthy while this original changes cursor fails.
  const failure = vi.spyOn(provider, 'readConversationChanges').mockImplementation(input => input.after !== undefined
    ? Promise.reject(new core.AgentMuxError('PRIVATE native read detail', 'AGENT_SESSION_HISTORY_TIMEOUT')) : nativeChanges(input))
  expect(await f.wire.post(f.message('latest-original'))).toBe(202)
  const latest = await f.claimed('latest-original')
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: latest.ingressId })).inputReceipt?.status).toBe('terminal-confirmed'))
  publication.refresh()
  await vi.waitFor(async () => expect((await list()).sourceObservation).toMatchObject({ state: 'unavailable', reason: 'source-gap', code: 'AGENT_SESSION_HISTORY_TIMEOUT' }))
  expect(failure).toHaveBeenCalled()
  const rpc = await f.sdk.call('space.mote.chat.diagnose', { target: f.target })
  expect(rpc.publications).toHaveLength(1)
  expect(rpc.publications[0]).toMatchObject({ preparedProviderId: providerId,
    sourceObservation: { state: 'unavailable', code: 'AGENT_SESSION_HISTORY_TIMEOUT' },
    coverage: { state: 'incomplete', gaps: [expect.objectContaining({ reason: 'source-gap', code: 'AGENT_SESSION_HISTORY_TIMEOUT' })] },
    effects: [expect.objectContaining({ kind: 'conversation', state: 'confirmed' })] })
  expect(rpc.publications[0]!.intakeKeys).toContain(moteChatDiagnosisKey(f.target, latest.ingressId))
  expect(rpc.incoming!.rows.find(row => row.key === moteChatDiagnosisKey(f.target, latest.ingressId))!.input)
    .toMatchObject({ status: 'terminal-confirmed', runtime: { target: 'original', state: 'running' } })
  const credentials = f.credentials(0)
  const cli = await runSourceObjectCli(['--endpoint', 'unix:' + join(f.root, 'public.sock'), 'space', 'mote', 'chat', 'diagnose', '--input', '-'],
    objectCliEnvironment(f.root, { AGENTMUX_AGENT_SESSION_ID: credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: credentials.capability,
      ...(process.env.MOTE_NATIVE_COVERAGE_CLI_LOADED ? { AGENTMUX_RESUMED_INBOX_CLI_LOADED: process.env.MOTE_NATIVE_COVERAGE_CLI_LOADED } : {}) }),
    JSON.stringify({ target: f.target }), 20_000, new URL('../../../packages/core/test/fixtures/a2a-resumed-inbox/source-loader.mjs', import.meta.url))
  expect(cli.code, cli.stdout + cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result).toEqual(rpc)
  const safe = JSON.stringify(rpc)
  for (const value of [f.root, sessionId, first.input!.expectedRun.runId, first.body, latest.body, first.ingressId, latest.externalMessageId,
    binding.externalConversationId, original.operationId, original.mapping!.messageId, 'PRIVATE native read detail']) expect(safe).not.toContain(value)
  expect((await list()).deliveries.filter(row => row.reference.source.kind === 'native')).toEqual([original])

  failure.mockRestore(); publication.refresh()
  await vi.waitFor(async () => expect((await list()).sourceObservation?.state).toBe('ready'))
  expect((await list()).deliveries.filter(row => row.reference.source.kind === 'native')).toEqual([original])
  expect((await list()).coverage?.gaps).toEqual([])
  // Replacing the native file cannot replace the original durable cut or certify a reply.
  const session = (await f.client.readAgentSession(sessionId))!, native = session.nativeHandle!
  const path = native.transcriptPath ?? join(f.root, 'grok/sessions', encodeCwdDirname(session.workspacePath), native.sessionId, 'updates.jsonl')
  const retained = publication.store.retainedCheckpoint(binding)
  await rename(path, path + '.original')
  await writeFile(path, '')
  publication.refresh()
  await vi.waitFor(async () => expect((await list()).sourceObservation).toMatchObject({ state: 'unavailable', code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' }))
  await vi.waitFor(async () => expect((await list()).coverage?.gaps).toContainEqual(expect.objectContaining({ reason: 'source-gap', code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })))
  expect(publication.store.retainedCheckpoint(binding)).toEqual(retained)
  expect((await list()).deliveries.filter(row => row.reference.source.kind === 'native')).toEqual([original])
  expect(f.start).toHaveBeenCalledOnce(); expect(f.inner.kernel.input).toHaveBeenCalledTimes(2); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  if (process.env.MOTE_NATIVE_COVERAGE_FACTS) appendFileSync(process.env.MOTE_NATIVE_COVERAGE_FACTS, JSON.stringify({ providerId,
    originalEffect: original.operationId, currentInput: 'terminal-confirmed', nativeAdoption: 'unconfirmed', latestReply: 'unconfirmed',
    transientCoverage: rpc.publications[0], recovered: true, originalCutRetained: true, sourceChanged: (await list()).sourceObservation,
    createCount: f.start.mock.calls.length, inputCount: vi.mocked(f.inner.kernel.input).mock.calls.length }) + '\n')
}, 30_000)
