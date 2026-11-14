import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { vi } from 'vitest'
import { defineRun } from '@ctxmux/sdk'
import { AgentMuxControlServer } from '../../src/public-rpc-server.js'
import { AgentMuxRpcService } from '../../src/public-rpc-service.js'
import { openDemandStore } from '@agentmux/demand'
import { GoalDelegationOwner } from '../../../../apps/host/src/goal-delegation-owner.js'
import { connectAgentMuxRpc } from '../../src/public-rpc-client.js'
import { MoteDialogueStore } from '../../src/mote/dialogue-store.js'
import type { AgentMuxClient } from '../../src/client.js'
import { createHostMoteDialogue, createHostMoteMainReader } from '../../../../apps/host/src/mote-dialogue.js'
import { createHostContent } from '../../../../apps/host/src/content-owner.js'
import { createHostSpatialAgentControl } from '../../../../apps/host/src/spatial-agent-control.js'
import { createMoteInputFixture } from './mote-input-owner.js'
import { runSourceObjectCli } from './source-object-cli.js'
import { objectCliEnvironment } from './object-cli-rpc.js'
import { fixtureHostExecutorOptions } from '../../../../apps/host/test/helpers/configured-executor-owner.js'

/** Synthetic Runtime/native I/O only; creation, authorization, messages, Dispatch, Host and RPC are real owners. */
export async function createMoteWorkThreadFixture(options: {directoryAddress?:boolean;topicId?:string} = {}) {
  const f = await createMoteInputFixture({ ...options, clientOptions: root => fixtureHostExecutorOptions(() => join(root, 'configuration.json'))(root) }), cleanup: Array<() => Promise<unknown>> = [f.close]
  try {
    const configurationPath = join(f.root, 'configuration.json'), configuration = JSON.parse(await readFile(configurationPath, 'utf8'))
    await writeFile(join(dirname(f.motePath), 'SOUL.md'), '# SOUL\nSynthetic persistent Mote identity.\n')
    configuration.executors = { codex: { label: 'Synthetic Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: false } }
    await writeFile(configurationPath, JSON.stringify(configuration))
    const core = f.client as any, launches: any[] = [], runs: any[] = []
    core.kernel.launchIdentity = ({ program, args }: any) => ({ program, argsDigest: createHash('sha256').update(JSON.stringify(args)).digest('base64url') })
    core.kernel.prepareStart = ({ program, args, cwd, env }: any) => defineRun(program, { args, cwd, env, initialSize: { cols: 80, rows: 24 } })
    core.kernel.creationRuntimeIdentity = () => ({ runtimeId: 'mote-work-fixture', instanceId: 'mote-work-fixture', protocolVersion: 18, buildIdentity: 'fixture' })
    core.kernel.start = vi.fn(async (spec: any) => {
      launches.push(spec)
      const run = { ...f.run('work-run-' + launches.length), program: spec.program, args: spec.args,
        workspacePath: spec.cwd, lifecycleOperationId: spec.operationKey }
      runs.push(run); return run
    })
    core.kernel.startPrepared = (request: any, operationKey: string) => core.kernel.start({ ...request, operationKey })
    core.kernel.list = async () => runs
    core.kernel.inspectCreation = async (operationKey: string) => runs.find(run => run.lifecycleOperationId === operationKey) ?? null
    core.kernel.inspectPreparedStart = async (_request: unknown, operationKey: string) => core.kernel.inspectCreation(operationKey)
    const status = core.kernel.status
    core.kernel.status = async (id: string) => runs.find(run => run.runId === id) ?? await status(id)
    core.ensureTerminalHandshakeOrDegrade = async (session: unknown) => session
    core.hookServer.isRunning = () => true
    core.hookServer.createBinding = (_agent: string, _provider: string, bindingId: string) => ({ bindingId,
      endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
    vi.spyOn(core.screenEvidence, 'wait').mockResolvedValue(1)
    const provider = f.client.providers.get('codex')
    f.client.providers.replace({ ...provider, prepareManagedLaunch: async plan => ({ plan }) })
    const graph=(await f.spatial.read())!.graph
    const target = { spaceId: graph.spaces[0]!.spaceId, zoneId: graph.bindings[0]!.zoneId,
      expectedResource: { hostId: 'local', workspaceId: '__scratch__', workspacePath: join(f.root, 'scratch') } }
    const content = createHostContent({ configurationPath, spatial: f.spatial })
    const main = createHostMoteMainReader({ configurationPath, spatial: f.spatial, files: content.files! })
    const dialogue = createHostMoteDialogue({ main, spatial: f.spatial, store: new MoteDialogueStore(join(f.root, 'work-dialogue.sqlite')), clientForHost: () => f.client })
    const demands = openDemandStore({ root: join(f.root, 'goals') })
    const coreRpc = new AgentMuxRpcService({ coreClients: f.coreClients })
    const goalDelegations = new GoalDelegationOwner(demands, {
      agentCreation: async (_hostId, sessionId) => f.client.inspectAgentCreation(sessionId),
      resolveGoalAgent: async sessionId => ({ hostId: 'local', status: await f.client.statusAgent(sessionId) })
    }, undefined, {
      call: async (_hostId, method, params, context) => coreRpc.call(method, params, context),
      readDispatch: async (_hostId, sourceMessageId) => ({ ...await f.client.readDispatch({ sourceMessageId }), hostId: 'local' }),
      observeRun: async (_hostId, runId) => {
        const { run } = await f.client.runtimeSubject({ kind: 'terminal-run', runId })
        return { runId: run.runId, state: run.state }
      }
    })
    const server = new AgentMuxControlServer({ socketPath: join(f.root, 'work-dialogue.sock'), coreClients: f.coreClients,
      spatialState: f.spatial, ...content, moteDialogue: dialogue, goalDelegations,
      spatialAgentControl: createHostSpatialAgentControl({ configurationPath, spatial: f.spatial, runtime: () => ({ client: f.client }) as any }) })
    await server.start(); cleanup.push(() => server.stop())
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
    const cli = async (args: string[], input?: unknown, sessionId = 'primary', capability = f.capability) => {
      const result = await runSourceObjectCli(['--endpoint', 'unix://' + server.path, ...args], objectCliEnvironment(f.root,
        { AGENTMUX_AGENT_SESSION_ID: sessionId, AGENTMUX_AGENT_CAPABILITY: capability }), input === undefined ? '' : JSON.stringify(input), 30_000,
        pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../fixtures/a2a-resumed-inbox/source-loader.mjs')))
      if (result.code !== 0) throw Error(result.stdout + result.stderr)
      return JSON.parse(result.stdout).result
    }
    return { root: f.root, configurationPath, files:content.files!, capability:f.capability, client: f.client as AgentMuxClient, inner: f.inner, writes: f.writes,
      target, main, dialogue, rpc, cli, launches, demands, motePath: f.motePath, spatial: f.spatial,
      close: async () => { for (const close of cleanup.reverse()) await close() } }
  } catch (error) { for (const close of cleanup.reverse()) await close(); throw error }
}

/** Exact real public creation → Dispatch → association outputs, shared by Core and rendered-consumer proofs. */
export async function openMoteWorkThread(f: Awaited<ReturnType<typeof createMoteWorkThreadFixture>>) {
  const before = await f.rpc.call('space.mote.dialogue.read', { target: f.target })
  const opened = await f.cli(['agent', 'open', '--executor', 'codex', '--space', f.target.spaceId, '--zone', f.target.zoneId, '--new-tab',
    '--prompt', 'Research the original scoped outcome', '--operation-id', 'mote-first-work'])
  const messageId = opened.agent.initialMessageId as string
  if (!messageId) throw Error('The original first-task message receipt is required')
  const source = await f.client.readMessage({ messageId })
  await f.cli(['message', 'dispatch', 'open', '--source-message', messageId])
  const linkInput = { target: f.target, operationId: 'link-first-work', expectedRoleRevision: before.main.roleRevision!,
    source: { kind: 'work' as const, messageHostId: 'local', messageId } }
  const linked = await f.cli(['space', 'mote', 'dialogue', 'link', '--input', '-'], linkInput)
  const member = opened.agent.agentSessionId as string, capability = f.launches[0].env.AGENTMUX_AGENT_CAPABILITY
  await f.cli(['agent', 'send', '--to-session', 'primary', '--text', 'Original scoped research result',
    '--reply-to', messageId, '--thread', source!.envelope.threadId, '--message-id', 'first-work-result',
    '--operation-id', 'first-work-result-op'], undefined, member, capability)
  await f.cli(['message', 'dispatch', 'report', '--source-message', messageId, '--reply-message', 'first-work-result',
    '--kind', 'worker_done'], undefined, member, capability)
  const page = await f.rpc.call('space.mote.dialogue.read', { target: f.target, kind: 'work' })
  const observation = await f.rpc.call('message.dispatch.read', { hostId: 'local', sourceMessageId: messageId })
  return { before, opened, messageId, source, linkInput, linked, page, observation }
}
