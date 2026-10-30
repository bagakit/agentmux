import { afterEach, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { readFile, rm, writeFile } from 'node:fs/promises'
import * as core from '../../core/dist/index.js'
import { headlessFixture, until } from '../../core/test/helpers/headless-runtime-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs() })

it('real owner crashes retain the exact accepted O1 action, protect O2 and reopen the frozen confirmed gap before one original PTY effect', async () => {
  vi.stubEnv('AGENTMUX_TEST_OWNER_ENTRY', resolve(import.meta.dirname, 'fixtures/ingress-context-worker.mjs'))
  const h = await headlessFixture(); cleanup.push(h.cleanup)
  const state = h.env.AGENTMUX_STATE_DIRECTORY!, output = join(h.root, 'context-terminal.jsonl')
  let client = await h.client(), rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.socketPath } })
  const rpcs = [rpc]; cleanup.push(async () => { for (const item of rpcs) await item.dispose() })
  const session = await client.createAgent({ agentSessionId: 'original-agent', createOperationId: 'context-create', providerId: 'pi', executorId: 'pi',
    workspacePath: h.root, injectAgentMuxGuide: false, commandOverride: process.execPath,
    args: [resolve(import.meta.dirname, '../../core/test/fixtures/prompt-carrier-terminal.mjs')], env: { AGENTMUX_TEST_INPUT_WITNESS: output } })
  const before = await until(async () => { try { const ready = JSON.parse(await readFile(output + '.ready', 'utf8')), status = await client.statusAgent(session.agentSessionId); return ready.pid === status.run.pid ? status : null } catch { return null } }, Boolean, 'original private PTY')
  const source = { providerId: 'pi', nativeSessionId: 'private-context-native' }, application = { domain: 'chat.example', appId: 'original-app' }
  expect((await client.readAgentSession(session.agentSessionId))!.nativeHandle).toMatchObject({ providerId: source.providerId, sessionId: source.nativeSessionId })
  expect(await rpc.call('connection.bind', { operationId: 'context-bind', bindingId: 'context-binding', connectionId: 'sample-connection', expectedConnectionRevision: 1,
    executionHostId: 'local', agentSessionId: session.agentSessionId, externalConversationId: 'original-room', expectedSource: source,
    scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } })).toMatchObject({ state: 'applied' })
  const actor = { application, idType: 'native-user', userId: 'original-external-user' }
  expect(await rpc.call('connection.grant', { operationId: 'context-grant', bindingId: 'context-binding', expectedBindingRevision: 1, grantId: 'context-member', expectedRevision: null,
    actor, capabilities: ['input'], state: 'active' })).toMatchObject({ state: 'applied' })
  const event = { eventId: 'context-event', messageId: 'original-current', externalConversationId: 'original-room', actor, body: 'Original durable current body\nEvery byte survives both crashes.', selection: 'mention', conversationKind: 'group' }
  await writeFile(join(state, 'transport-event.json'), JSON.stringify({ proof: 'adapter-private-witness', event }))
  const first = await until(async () => { const rows = await rpc.call('connection.ingress.ls', { connectionId: 'sample-connection' }); return rows.ingresses[0] ? await rpc.call('connection.ingress.inspect', { ingressId: rows.ingresses[0].ingressId }) : null }, value => value?.preparation?.phase === 'history', 'original O1 history read')
  const ingressId = first!.ingress!.ingressId, originalAction = { ingressId, operationId: 'accepted-original-context-action', source: first!.rejoinSource! }
  expect(originalAction.source.kind).toBe('context-observation')
  const owners = [h.owner], pids = [h.ownerProcess.pid]
  const restart = async () => {
    await h.restart(); owners.push(h.owner); pids.push(h.ownerProcess.pid)
    client = await h.client(); rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.socketPath } }); rpcs.push(rpc)
    expect((await client.statusAgent(session.agentSessionId)).run).toMatchObject({ runId: before!.run.runId, pid: before!.run.pid, state: 'running' })
  }
  await writeFile(join(state, 'crash-after-context-action'), 'Original action is durable; observer not yet consumed')
  const endedO1 = once(h.ownerProcess, 'exit'), lostO1 = rpc.call('connection.ingress.rejoin', originalAction).catch(() => null)
  await endedO1; await lostO1
  const accepted = JSON.parse(await readFile(join(state, 'accepted-context-action.json'), 'utf8'))
  expect(accepted.actions).toContainEqual({ ...originalAction, outcome: 'pending' })
  expect(accepted.context).toMatchObject({ observationId: first!.preparation!.observationId, phase: 'history' })
  await rm(join(state, 'crash-after-context-action'))
  await restart()
  const second = await until(() => rpc.call('connection.ingress.inspect', { ingressId }), value => value.preparation?.phase === 'history' && value.preparation.observationId !== first!.preparation!.observationId, 'new exact O2 after process restart')
  const oldReplay = await rpc.call('connection.ingress.rejoin', originalAction)
  expect(oldReplay.action).toMatchObject({ ...originalAction, outcome: 'stale' })
  expect(oldReplay.inspection.rejoinSource).toEqual(second.rejoinSource)
  expect((await rpc.call('connection.ingress.rejoin', originalAction)).action).toEqual(oldReplay.action)
  expect((await rpc.call('connection.ingress.rejoin', { ...originalAction, operationId: 'different-old-O1-action' })).action.outcome).toBe('stale')
  expect((await rpc.call('connection.ingress.inspect', { ingressId })).rejoinSource).toEqual(second.rejoinSource)
  const currentAction = { ingressId, operationId: 'freeze-original-O2-gap', source: second.rejoinSource! }
  await writeFile(join(state, 'crash-after-context-gap'), 'Original source consumed and prefix/gap committed before reply or abort')
  const endedO2 = once(h.ownerProcess, 'exit'), lostO2 = rpc.call('connection.ingress.rejoin', currentAction).catch(() => null)
  await endedO2; await lostO2
  const frozen = JSON.parse(await readFile(join(state, 'frozen-context-gap.json'), 'utf8'))
  expect(frozen.actions).toContainEqual({ ...currentAction, outcome: 'context-ended' })
  expect(frozen.context.quote).toMatchObject({ coverage: 'partial', gaps: expect.arrayContaining([{ reason: 'context-observation-cancelled' }]), records: [{ messageId: 'confirmed-native-prefix' }] })
  await rm(join(state, 'crash-after-context-gap'))
  await restart()
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + h.socketPath, 'connection', 'ingress', 'rejoin', '--input', '-'], objectCliEnvironment(h.root), JSON.stringify(currentAction))
  expect(cli.code, cli.stdout + cli.stderr).toBe(0)
  const result = JSON.parse(cli.stdout).result
  expect(result.action).toEqual({ ...currentAction, outcome: 'context-ended' })
  const final = await until(() => rpc.call('connection.ingress.inspect', { ingressId }), value => value.inputReceipt?.status === 'terminal-confirmed', 'one original body input after durable gap reopen')
  expect(final.ingress!.body).toBe(event.body)
  expect(final.ingress!.input!.channelQuote).toEqual(frozen.context.quote)
  const inputs = async () => (await readFile(output, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })).split('\n').filter(Boolean).map(JSON.parse)
  await until(inputs, rows => rows.length === 1, 'one real original PTY effect')
  expect((await inputs())[0]!.text).toContain(event.body)
  expect((await client.readAgentInputMailbox({ agentSessionId: session.agentSessionId })).items).toHaveLength(1)
  expect((await rpc.call('connection.ingress.rejoin', originalAction)).action).toEqual(oldReplay.action)
  expect((await rpc.call('connection.ingress.rejoin', currentAction)).action).toEqual(result.action)
  expect(await inputs()).toHaveLength(1)
  expect((await readFile(join(state, 'context-reads.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2)
  expect(new Set(pids).size).toBe(3); expect(new Set(owners.map(owner => owner.runtimeId)).size).toBe(1)
  const loadedArtifacts = await Promise.all(pids.map(pid => readFile(join(state, 'context-loaded-' + pid + '.json'), 'utf8').then(JSON.parse)))
  expect(loadedArtifacts).toHaveLength(3)
  if (process.env.INGRESS_CONTEXT_CRASH) await writeFile(process.env.INGRESS_CONTEXT_CRASH, JSON.stringify({ owners, pids, loadedArtifacts, before, first, accepted, second, oldReplay, frozen, result, final, inputs: await inputs() }, null, 2))
  await client.stopAgent(session.agentSessionId, session.run)
}, 60000)
