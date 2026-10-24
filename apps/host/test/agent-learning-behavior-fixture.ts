import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { AgentMuxControlServer, AgentMuxSpatialStateStore, connectAgentMuxRpc, spatialCatalog } from '@agentmux/core'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { WorkspaceFiles } from '../../desktop/src/main/workspace-files.js'
import { TopicKnowledgeOwner } from '@agentmux/host/topic-knowledge'
import { TopicSpatialOwner } from '@agentmux/host/topic-spatial-owner'
import { learningPublicFixture } from './agent-learning-public-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { writeBehaviorTools } from './agent-learning-behavior-tools.mjs'
import type { AgentLearningOperation } from '@agentmux/core/agent-learning'

export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

/** Real business/resource owners; Core authorization/journals are real, Runtime I/O is the existing controlled port. */
export async function learningBehaviorFixture(evidenceDirectory?: string) {
  const f = await learningPublicFixture(), state = new AgentMuxSpatialStateStore(join(f.root, 'spatial.json'))
  const audit: unknown[] = []
  let fault: 'receipt' | undefined, concurrent: ((input: any) => Promise<void>) | undefined
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never, {
    localWriteFault: () => { const selected = fault; fault = undefined; return selected },
    beforeWrite: async input => { const action = concurrent; concurrent = undefined; await action?.(input) }
  })
  const competingFiles = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never)
  const originalFiles = new FileReadOwner({ files, workspace: id => id === f.workspace.id ? f.workspace as never : undefined,
    topicForDirectory: (workspace, directory) => f.topics.readForDirectory(workspace, directory),
    catalog: async () => { const current = await state.read(); return current ? spatialCatalog(current.graph) : null } })
  const topics = new TopicKnowledgeOwner(f.topics as never, files, () => f.workspace as never)
  topics.setSpatialPort(new TopicSpatialOwner({ state, workspace: () => f.workspace as never,
    topics: () => topics.listTopicSnapshots(), categories: () => topics.listCategories(), ensureDefaultCategory: () => topics.ensureDefaultCategoryContent() }))
  topics.setFileReadPort(originalFiles)
  async function record(value: unknown) {
    const safe = JSON.parse(JSON.stringify(value, (key, item) => key === 'capability' ? '[redacted-test-capability]' : item))
    audit.push(safe)
    if (evidenceDirectory) await appendFile(join(evidenceDirectory, 'owner-actions.ndjson'), JSON.stringify(safe) + '\n')
  }
  const observedFiles = new Proxy(originalFiles, { get(owner, key) {
    const value = Reflect.get(owner, key, owner)
    if (typeof value !== 'function') return value
    return async (...args: unknown[]) => {
      try { const result = await value.apply(owner, args); await record({ port: 'files', method: String(key), input: args, result }); return result }
      catch (error) { await record({ port: 'files', method: String(key), input: args, error: { code: (error as any).code, message: String(error) } }); throw error }
    }
  } })
  const observedTopics = { call: async (...args: Parameters<typeof topics.call>) => {
    try { const result = await topics.call(...args); await record({ port: 'topics', input: args, result }); return result }
    catch (error) { await record({ port: 'topics', input: args, error: { code: (error as any).code, message: String(error) } }); throw error }
  } }
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'behavior.sock'), agentLearning: f.owner,
    spatialState: state, files: observedFiles, topics: observedTopics as never, coreClients: f.coreClients })
  await server.start()
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const resource = (index: number, path: string) => ({ zoneId: f.targets[index]!.zoneId,
    path, expectedResource: f.targets[index]!.expectedResource })
  const cli = (argv: string[], stdin = '', credentials?: { agentSessionId: string; capability: string }) =>
    runCompiledObjectCli(argv, objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path,
      AGENTMUX_AGENT_SESSION_ID: credentials?.agentSessionId, AGENTMUX_AGENT_CAPABILITY: credentials?.capability }), stdin)
  async function workerPacket(operationId: string, worker: { agentSessionId: string; createOperationId: string }, stage: 'extraction' | 'learning' | 'later', label: string) {
    if (!evidenceDirectory) throw Error('This observed model packet needs an explicit evidence directory.')
    const stored = (await f.store.readMetadata(worker.agentSessionId))!
    const spec = f.started.find(entry => entry.env?.AGENTMUX_AGENT_SESSION_ID === worker.agentSessionId)
    if (!stored.initialInput?.prompt || !spec?.env.AGENTMUX_AGENT_CAPABILITY) throw Error('Original Core packet/caller unavailable.')
    if (stored.creation?.createOperationId !== worker.createOperationId) throw Error('Packet belongs to another original Core creation.')
    const directory = join(evidenceDirectory, label); await mkdir(directory, { recursive: true })
    const original = stored.initialInput.prompt
    await writeFile(join(directory, 'production-input.txt'), original)
    await writeFile(join(directory, 'initial-input.json'), JSON.stringify(stored.initialInput, null, 2))
    const tools = await writeBehaviorTools({ directory, cliPath: resolve('packages/core/bin/amux'), endpoint: 'unix:' + server.path,
      caller: worker.agentSessionId, capability: spec.env.AGENTMUX_AGENT_CAPABILITY, operationId, production: original })
    const binding = { label, stage, operationId, fixtureCaller: worker.agentSessionId,
      createOperationId: worker.createOperationId, ...tools,
      nativeTaskId: null, providerLaunch: 'controlled-runtime-not-qualified' }
    await writeFile(join(directory, 'binding.json'), JSON.stringify(binding, null, 2))
    return binding
  }
  const packet = (operation: AgentLearningOperation, stage: 'extraction' | 'learning', label: string) =>
    workerPacket(operation.operationId, stage === 'extraction' ? operation.proposer : operation.learner!, stage, label)
  const sessionPacket = (agentSessionId: string, createOperationId: string, label: string) =>
    workerPacket(createOperationId, { agentSessionId, createOperationId }, 'later', label)
  return { ...f, state, files, competingFiles, originalFiles, knowledge: topics, audit, behaviorClient: client, resource, cli, packet,
    sessionPacket,
    failNextSaveReceipt: () => { fault = 'receipt' }, raceNextSave: (action: (input: any) => Promise<void>) => { concurrent = action },
    closeBehavior: async () => { await client.dispose(); await server.stop(); await files.dispose(); await competingFiles.dispose() } }
}
