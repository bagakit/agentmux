import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxSpatialStateStore } from '@agentmux/core'
import { directoryIdentity, homeZoneId } from '@agentmux/host/mote-model'
import { createAgentLearningResources } from '../../host/src/agent-learning-resources'
import { createMoteChatAgents } from '@agentmux/host/mote-chat-agents'
import { createMoteChatResources } from '@agentmux/host/mote-resources'
import { createHostSpatialAgentControl } from '../../host/src/spatial-agent-control'
import { ScratchTopics } from '@agentmux/host/mote-resources'
import { composeAgentLaunchPrompt } from '@agentmux/core/agent-outbound-message'
import { creationInputOwner } from '../../../packages/core/test/helpers/creation-input-owner'
import { fixtureHostExecutorOptions } from '../../host/test/helpers/configured-executor-owner'
const roots: string[] = []
const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); vi.restoreAllMocks() })
it('actual Host preparation keeps current identity task and environment principles with custom user files and disabled Wiki', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mote-principles-'))); roots.push(root)
  const path = join(root, 'scratch'); await mkdir(path)
  const workspace = { id: '__scratch__', hostId: 'local', path }, owner = new ScratchTopics()
  const mote = await owner.ensureMote(workspace, 'launcher:principles-original')
  const saved = { 'SOUL.md': '# Saved persona\r\nKeep my long-term identity.\r\n', 'AGENTS.md': '# Saved guide\r\nKeep my custom working method.\r\n' }
  for (const [name, text] of Object.entries(saved)) await writeFile(join(mote.physicalDirectoryPath!, name), text)
  await owner.setWikiEnabled(workspace, mote.id, false)
  const prepared = await new ScratchTopics().prepareAgent(workspace, mote.id, { providerId: 'codex', sessionId: 'original-session' })
  const original = '  用户的目标与更正，保留原字节。\r\nNo extra authority.  '
  const actual = composeAgentLaunchPrompt(original, false, prepared.prompt, prepared.optionalContext)
  expect(actual.systemContext).toContain('Identity consistency and task consistency are base operating principles')
  expect(actual.systemContext).toContain('current main Agent can change')
  expect(actual.systemContext).toContain('main and member Agents keep their actual Session identities')
  expect(actual.systemContext).toContain('unfinished commitments, original input/permission, evidence and handoff sources')
  expect(actual.systemContext).toContain('available capabilities and execution cwd')
  expect(actual.systemContext).toContain('Saved personality or guidance does not prove')
  expect(actual.systemContext).toContain('Topic Wiki injection is disabled')
  expect(actual.systemContext).not.toContain(original)
  expect(actual.text.endsWith(original)).toBe(true)
  expect(prepared.absolutePath).toBe(mote.physicalDirectoryPath)
  for (const [name, text] of Object.entries(saved)) expect(await readFile(join(prepared.absolutePath, name), 'utf8')).toBe(text)
  const ordinary = await owner.ensure(workspace, 'launcher:ordinary-principles')
  const plain = await owner.prepareAgent(workspace, ordinary.id, { providerId: 'codex', sessionId: 'ordinary-session' })
  expect(plain.prompt).not.toContain('Identity consistency and task consistency')
  expect(plain.prompt).not.toContain(mote.id)
  const other = await owner.ensureMote(workspace, 'launcher:other-principles')
  const distinct = await owner.prepareAgent(workspace, other.id, { providerId: 'codex', sessionId: 'other-session' })
  expect(distinct.prompt).not.toContain(mote.physicalDirectoryPath)
  expect(distinct.prompt).not.toContain(mote.id)
})

it('actual Host spatial chat and learning consumers deliver the same current principles through their original prepare owner', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mote-principles-ports-'))); roots.push(root)
  const path = join(root, 'homes'); await mkdir(path)
  const workspace = { id: '__scratch__', hostId: 'local', path }, topics = new ScratchTopics()
  const mote = await topics.ensureMote(workspace, 'launcher:principles-ports')
  await writeFile(join(mote.physicalDirectoryPath!, 'MOTE.md'), '---\nversion: 1\ndefaults:\n  executorId: saved\n---\n')
  const spaceId = directoryIdentity('local', mote.identityDirectoryPath!), zoneId = homeZoneId(spaceId)
  const graph = { spaces: [{ spaceId, kind: 'mote' as const, topicId: mote.id, name: 'Original Mote', hostId: 'local', directoryPath: mote.physicalDirectoryPath!, projectId: null }],
    zones: [{ zoneId, kind: 'home' as const, workspaceId: workspace.id, hostId: 'local', directoryPath: mote.physicalDirectoryPath!, branch: null }],
    bindings: [{ spaceId, zoneId }], tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {} }
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json')); await spatial.commit({ expectedRevision: 0, graph })
  const target = { spaceId, zoneId, expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path } }
  const configurationPath = join(root, 'config.json')
  await writeFile(configurationPath, JSON.stringify({ workspaces: [workspace], executors: { saved: { label: 'Saved', providerId: 'codex', command: 'private-test-only', args: [], env: {}, injectAgentMuxGuide: false } } }))
  const learning = await createAgentLearningResources({ configurationPath, spatial, topics })({ ...target, topicId: mote.id, kind: 'mote' }, { providerId: 'codex', sessionId: 'learning-worker' })
  const catalog = { ...graph, locations: [] }
  const resources = createMoteChatResources({ topics, catalog: async () => catalog, configuration: async () => ({ workspace }) })
  const chat = createMoteChatAgents({ resources, clients: () => [{ hostId: 'local', client: {} as never }], executors: {
    resolve: async () => ({ providerId: 'codex', launch: { injectAgentMuxGuide: false } }), create: async () => { throw Error('No creation authorized by this preparation-only check') } } })
  const preparedChat = await chat.prepare({ generation: { target, executionHostId: 'local', agentSessionId: 'chat-worker', createOperationId: 'chat-operation' }, systemContext: 'Original private audience context' } as never)
  const h = await creationInputOwner(true, fixtureHostExecutorOptions(() => configurationPath)); closes.push(h.close)
  const create = vi.spyOn(h.client, 'createHostAgentWithDelivery')
  const creator = createHostSpatialAgentControl({ configurationPath, spatial, runtime: () => ({ client: h.client }) as never })
  const human = 'Original authorized test body; preserve exact scope.'
  const opened = await creator({ operation: 'agent.open', requestId: 'spatial-operation', content: { kind: 'new-agent', executorId: 'saved', prompt: human }, destination: { spaceId, zoneId, newTab: true }, focus: false } as never, {} as never)
  expect(opened?.operation).toBe('agent.open'); expect(create).toHaveBeenCalledTimes(1)
  const received = create.mock.calls[0]![0]; expect(received.prompt).toBe(human)
  for (const value of [learning, preparedChat.input, { ...received, agentMuxNote: received.sourceAgentMuxNote }]) {
    expect(value.workspacePath).toBe(mote.physicalDirectoryPath)
    expect(value.agentMuxNote).toContain('Identity consistency and task consistency are base operating principles')
    expect(value.agentMuxNote).toContain('available capabilities and execution cwd')
    expect(value.agentMuxNote).toContain(mote.id)
    expect(value.agentMuxNote).not.toContain(human)
    const delivered = composeAgentLaunchPrompt(undefined, false, value.agentMuxNote, value.optionalContext)
    expect(delivered.systemContext).toContain('current main Agent can change')
  }
})
