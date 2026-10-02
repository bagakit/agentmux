import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc, type ExecutionHost, type TopicKnowledgeWrite } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { ScratchTopics } from '../src/main/scratch-topics'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { TopicKnowledgeOwner } from '../src/main/topic-knowledge'
import { TopicSpatialOwner } from '../src/main/topic-spatial-owner'
import { MOTE_SOUL_PATH, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName, scratchTopicPhysicalPath } from '../src/shared/scratch-topics'
import type { WorkspaceRecord } from '../src/shared/contracts'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => { throw new Error('This content test does not decode avatars.') } } }))
const roots: string[] = [], servers: AgentMuxControlServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const ENTRY = '11111111-1111-4111-8111-111111111111'
const SECOND = '22222222-2222-4222-8222-222222222222'
const BAD = '33333333-3333-4333-8333-333333333333'
const LINK = '44444444-4444-4444-8444-444444444444'
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-knowledge-'))); roots.push(root)
  const path = join(root, 'scratch'); await mkdir(path)
  const workspace: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path, kind: 'folder' }
  const scratch = new ScratchTopics(), files = new WorkspaceFiles(() => ({ kind: 'local' } as ExecutionHost))
  const state = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  const owner = new TopicKnowledgeOwner(scratch, files, () => workspace)
  owner.setSpatialPort(new TopicSpatialOwner({ state, workspace: () => workspace, topics: () => owner.listTopicSnapshots(),
    categories: () => owner.listCategories(), ensureDefaultCategory: () => owner.ensureDefaultCategoryContent() }))
  const { topic } = await owner.call('topic.create', { topicId: 'view:knowledge', title: '招聘讨论' })
  const authored: TopicKnowledgeWrite = { topicId: topic.topicId, entryId: ENTRY, title: '结构化面试', content: '有来源的建议：采用结构化问题。',
    form: 'derived', certainty: 'proposal', scope: '工程岗位；原讨论涉及两轮面试。',
    sources: [{ kind: 'topic', topicId: topic.topicId, chatId: 'original-chat', threadId: 'original-thread' },
      { kind: 'file', hostId: 'local', path: _hygiene_fixturePath("project/interview.md"), projectId: 'original-project', revision: 'sha256:' + 'a'.repeat(64) },
      { kind: 'note', noteId: 'original-note', blockId: 'source-block' }, { kind: 'survey', zoneId: 'original-survey', tabId: 'survey-chat', regionId: 'survey-thread' },
      { kind: 'space', zoneId: 'original-project-zone', tabId: 'project-chat', regionId: 'project-thread' },
      { kind: 'url', url: 'https://example.org/research' }], expectedRevision: null }
  return { root, workspace, scratch, files, state, owner, topic, authored }
}

describe('Knowledge entries retain exact source identity through original file CAS', () => {
  it('roundtrips one durable JSON with scope, certainty and references without copying source trees or changing Topic content', async () => {
    const f = await fixture(), directory = join(f.topic.directoryPath, 'knowledge')
    const original = await readFile(join(f.topic.directoryPath, 'topic.md'), 'utf8')
    const saved = await f.owner.call('topic.knowledge.write', f.authored)
    expect(saved.diskDurability).toBe('confirmed')
    const { expectedRevision, ...authored } = f.authored
    expect(saved.entry).toMatchObject(authored)
    expect(saved.entry.sources).toEqual(f.authored.sources)
    expect(saved.entry.updatedAt).toBeGreaterThan(0)
    expect(saved.entry.revision).toMatch(/^sha256:[a-f0-9]{64}$/u)
    const stored = JSON.parse(await readFile(join(directory, ENTRY + '.json'), 'utf8'))
    expect(stored).toEqual({ ...authored, updatedAt: saved.entry.updatedAt })
    expect(stored).not.toHaveProperty('revision')
    expect(stored).not.toHaveProperty('expectedRevision')
    const restarted = new TopicKnowledgeOwner(new ScratchTopics(), new WorkspaceFiles(() => ({ kind: 'local' } as ExecutionHost)), () => f.workspace)
    expect(await restarted.call('topic.knowledge.read', { topicId: f.topic.topicId, entryId: ENTRY })).toEqual({ entry: saved.entry })
    expect((await f.owner.call('topic.knowledge.search', { query: '原讨论' })).entries).toEqual([saved.entry])
    expect((await f.owner.call('topic.knowledge.search', { query: 'source-block' })).entries).toEqual([saved.entry])
    expect(await readFile(join(f.topic.directoryPath, 'topic.md'), 'utf8')).toBe(original)
    expect(await f.owner.call('topic.knowledge.read', { topicId: f.topic.topicId, entryId: SECOND })).toEqual({ entry: null })
  })
  it('refuses stale and duplicate saves, including a save made through the existing generic GUI file owner', async () => {
    const f = await fixture()
    const first = await f.owner.call('topic.knowledge.write', f.authored)
    const revised = await f.owner.call('topic.knowledge.write', { ...f.authored, content: '审阅后明确采用结构化面试。', certainty: 'decision', expectedRevision: first.entry.revision })
    await expect(f.owner.call('topic.knowledge.write', { ...f.authored, content: 'stale overwrite', expectedRevision: first.entry.revision })).rejects.toMatchObject({ code: 'TOPIC_CONTENT_CONFLICT' })
    await expect(f.owner.call('topic.knowledge.write', { ...f.authored, content: 'duplicate create' })).rejects.toMatchObject({ code: 'TOPIC_CONTENT_CONFLICT' })
    expect((await f.owner.call('topic.knowledge.read', { topicId: f.topic.topicId, entryId: ENTRY })).entry).toEqual(revised.entry)
    const filePath = scratchTopicDirectoryName(f.topic.topicId) + '/knowledge/' + ENTRY + '.json'
    const raw = JSON.parse(await readFile(join(f.topic.directoryPath, 'knowledge', ENTRY + '.json'), 'utf8'))
    const genericSave = await f.files.write(f.workspace, { path: filePath, content: JSON.stringify({ ...raw, content: 'Original file editor save.' }) + '\n', expectedRevision: revised.entry.revision })
    expect(genericSave.status).toBe('written')
    await expect(f.owner.call('topic.knowledge.write', { ...f.authored, expectedRevision: revised.entry.revision })).rejects.toMatchObject({ code: 'TOPIC_CONTENT_CONFLICT' })
    expect((await f.owner.call('topic.knowledge.read', { topicId: f.topic.topicId, entryId: ENTRY })).entry?.content).toBe('Original file editor save.')
  })
  it('keeps healthy entries beside damaged bytes or outside links and reports requested result limits', async () => {
    const f = await fixture(), directory = join(f.topic.directoryPath, 'knowledge')
    const first = await f.owner.call('topic.knowledge.write', f.authored)
    const second = await f.owner.call('topic.knowledge.write', { ...f.authored, entryId: SECOND, title: '第二条' })
    await writeFile(join(directory, BAD + '.json'), '{broken')
    const outside = join(f.root, 'outside.json'); await writeFile(outside, 'Outside private content')
    await symlink(outside, join(directory, LINK + '.json'))
    const discovered = await f.owner.call('topic.knowledge.ls', { topicId: f.topic.topicId })
    expect(discovered.entries.slice(0, 2)).toEqual([first.entry, second.entry])
    expect(discovered.entries.slice(2)).toEqual([
      expect.objectContaining({ topicId: f.topic.topicId, entryId: BAD, readError: expect.any(String) }),
      expect.objectContaining({ topicId: f.topic.topicId, entryId: LINK, readError: expect.any(String) })
    ])
    expect(discovered.unavailable.map(item => item.source)).toEqual([BAD, LINK])
    expect(await readFile(outside, 'utf8')).toBe('Outside private content')
    const limited = await f.owner.call('topic.knowledge.ls', { topicId: f.topic.topicId, limit: 1 })
    expect(limited.entries).toEqual([first.entry])
    expect(limited.unavailable).toContainEqual(expect.objectContaining({ code: 'TOPIC_KNOWLEDGE_PARTIAL', source: f.topic.topicId }))
    await writeFile(join(directory, BAD + '.json'), JSON.stringify({ ...first.entry, entryId: SECOND }))
    await expect(f.owner.call('topic.knowledge.read', { topicId: f.topic.topicId, entryId: BAD })).rejects.toMatchObject({ code: 'TOPIC_KNOWLEDGE_IDENTITY_CONFLICT' })
  })
  it('rejects Mote targets for knowledge operations and never discovers their private entries', async () => {
    const f = await fixture()
    const mote = await f.scratch.ensureMote(f.workspace, 'view:private-mote')
    const directory = join(scratchTopicPhysicalPath(f.workspace, mote), 'knowledge'); await mkdir(directory)
    const bytes = JSON.stringify({ ...f.authored, topicId: mote.id, updatedAt: 1 })
    await writeFile(join(directory, ENTRY + '.json'), bytes)
    const saved = await f.owner.call('topic.knowledge.write', f.authored)
    expect((await f.owner.call('topic.knowledge.search', { query: '结构化' })).entries).toEqual([saved.entry])
    await Promise.all([
      f.owner.call('topic.knowledge.ls', { topicId: mote.id }),
      f.owner.call('topic.knowledge.read', { topicId: mote.id, entryId: ENTRY }),
      f.owner.call('topic.knowledge.write', { ...f.authored, topicId: mote.id })
    ].map(operation => expect(operation).rejects.toMatchObject({ code: 'TOPIC_TARGET_IS_MOTE' })))
    expect(await readFile(join(directory, ENTRY + '.json'), 'utf8')).toBe(bytes)
    const legacyHome = join(f.workspace.path, scratchTopicDirectoryName(mote.id))
    await rename(scratchTopicPhysicalPath(f.workspace, mote), legacyHome)
    await rm(join(legacyHome, MOTE_SOUL_PATH))
    await symlink(join(f.root, 'missing-soul'), join(legacyHome, MOTE_SOUL_PATH))
    const unknown = await f.owner.call('topic.knowledge.search', { query: '结构化' })
    expect(unknown.entries).toEqual([saved.entry])
    expect(unknown.unavailable).toContainEqual(expect.objectContaining({ code: 'TOPIC_SCOPE_UNCONFIRMED', source: mote.id }))
    expect(await readFile(join(legacyHome, 'knowledge', ENTRY + '.json'), 'utf8')).toBe(bytes)
  })
  it('writes, reads, searches and revises through the actual compiled CLI and refuses stale RPC writes', async () => {
    const f = await fixture(), socketPath = join(f.root, 'rpc.sock')
    const server = new AgentMuxControlServer({ socketPath, spatialState: f.state, coreClients: () => [], topics: f.owner })
    servers.push(server); await server.start()
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
    const env = objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + socketPath })
    try {
      const created = await runCompiledObjectCli(['topic', 'knowledge', 'write', '--input', '-'], env, JSON.stringify(f.authored))
      expect(created.code, created.stderr).toBe(0)
      const first = JSON.parse(created.stdout).result.entry
      expect(first.sources).toEqual(f.authored.sources)
      const read = await runCompiledObjectCli(['topic', 'knowledge', 'read', '--topic', f.topic.topicId, '--entry', ENTRY], env)
      expect(read.code, read.stderr).toBe(0)
      expect(JSON.parse(read.stdout)).toMatchObject({ operation: 'topic.knowledge.read', result: { entry: first } })
      const searched = await runCompiledObjectCli(['topic', 'knowledge', 'search', '--query', 'source-block', '--topic', f.topic.topicId], env)
      expect(searched.code, searched.stderr).toBe(0)
      expect(JSON.parse(searched.stdout).result.entries).toEqual([first])
      const revisedInput = { ...f.authored, content: '实际 CLI 确认的决策。', certainty: 'decision', expectedRevision: first.revision }
      const inputFile = join(f.root, 'revision.json'); await writeFile(inputFile, JSON.stringify(revisedInput))
      const revised = await runCompiledObjectCli(['topic', 'knowledge', 'write', '--input', inputFile], env)
      expect(revised.code, revised.stderr).toBe(0)
      const entry = JSON.parse(revised.stdout).result.entry
      const stale = await runCompiledObjectCli(['topic', 'knowledge', 'write', '--input', '-'], env, JSON.stringify({ ...revisedInput, content: 'stale CLI data' }))
      expect(stale.code).toBe(1)
      expect(JSON.parse(stale.stderr)).toMatchObject({ error: { code: 'TOPIC_CONTENT_CONFLICT' } })
      const listed = await runCompiledObjectCli(['topic', 'knowledge', 'ls', '--topic', f.topic.topicId], env)
      expect(listed.code, listed.stderr).toBe(0)
      expect(JSON.parse(listed.stdout).result.entries).toEqual([entry])
      expect(await client.call('topic.knowledge.read', { topicId: f.topic.topicId, entryId: ENTRY })).toEqual({ entry })
    } finally { await client.dispose() }
  })
})
