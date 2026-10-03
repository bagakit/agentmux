import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SpawnOptions } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc, type ExecutionHost, type TopicKnowledgeDocument } from '@agentmux/core'
import { AgentMuxSpatialStateStore, spatialCatalog } from '@agentmux/core/spatial-state'
import { ScratchTopics } from '../src/main/scratch-topics'
import { WorkspaceFiles as SourceWorkspaceFiles } from '../src/main/workspace-files'
import { TopicKnowledgeOwner as SourceTopicKnowledgeOwner } from '../src/main/topic-knowledge'
import { TopicSpatialOwner } from '../src/main/topic-spatial-owner'
import { FileReadOwner } from '../src/main/file-read-owner'
import { SCRATCH_TOPIC_WIKI_PATH, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName, scratchTopicPhysicalPath } from '../src/shared/scratch-topics'
import type { WorkspaceRecord } from '../src/shared/contracts'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
const WorkspaceFiles: typeof SourceWorkspaceFiles = process.env.AGENTMUX_TEST_TOPIC_DOCUMENT_FILES
  ? (await import(/* @vite-ignore */ pathToFileURL(process.env.AGENTMUX_TEST_TOPIC_DOCUMENT_FILES).href)).WorkspaceFiles : SourceWorkspaceFiles
const TopicKnowledgeOwner: typeof SourceTopicKnowledgeOwner = process.env.AGENTMUX_TEST_TOPIC_DOCUMENT_OWNER
  ? (await import(/* @vite-ignore */ pathToFileURL(process.env.AGENTMUX_TEST_TOPIC_DOCUMENT_OWNER).href)).TopicKnowledgeOwner : SourceTopicKnowledgeOwner
const workerProbe = vi.hoisted(() => ({ onSpawn: null as (() => void) | null }))
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, spawn: (command: string, args: string[] = [], options?: SpawnOptions) => {
    const child = original.spawn(command, args, options ?? {})
    if (args.some(value => value.startsWith('{"action":"read-bytes"'))) queueMicrotask(() => workerProbe.onSpawn?.())
    return child
  } }
})

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => { throw new Error('Document search does not decode avatars.') } } }))
const roots: string[] = [], servers: AgentMuxControlServer[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  workerProbe.onSpawn = null
  for (const server of servers.splice(0)) await server.stop()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-topic-documents-'))); roots.push(root)
  const path = join(root, 'scratch'); await mkdir(path)
  const workspace: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path, kind: 'folder' }
  const scratch = new ScratchTopics(), files = new WorkspaceFiles(() => ({ kind: 'local' } as ExecutionHost))
  const state = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  const owner = new TopicKnowledgeOwner(scratch, files, () => workspace)
  owner.setSpatialPort(new TopicSpatialOwner({ state, workspace: () => workspace, topics: () => owner.listTopicSnapshots(),
    categories: () => owner.listCategories(), ensureDefaultCategory: () => owner.ensureDefaultCategoryContent() }))
  const publicFiles = new FileReadOwner({ files, workspace: id => id === workspace.id ? workspace : undefined,
    topicForDirectory: (w, directory) => scratch.readForDirectory(w, directory),
    catalog: async () => { const current = await state.read(); return current ? spatialCatalog(current.graph) : null } })
  owner.setFileReadPort(publicFiles)
  const { topic } = await owner.call('topic.create', { topicId: 'view:documents', title: '原资料' })
  const expectedResource = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path }
  return { root, workspace, scratch, files, publicFiles, state, owner, topic, expectedResource }
}
function exact(documents: TopicKnowledgeDocument[], path: string): TopicKnowledgeDocument {
  const document = documents.find(item => item.target.path === path)
  expect(document, 'The actual original document must be discovered.').toBeDefined()
  return document!
}
describe('Topic search consumes bounded original Files instead of a second knowledge index', () => {
  it('lists names without reading bodies and finds Chinese body-only text with zero saved UUID entries through RPC and shipping CLI', async () => {
    const f = await fixture(), body = '# 原始文件\n本文讨论挂载磁盘权限与安全清理。\n'
    await expect(lstat(join(f.topic.directoryPath, 'knowledge'))).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(join(f.topic.directoryPath, 'outcome', 'report.md'), body)
    await writeFile(join(f.topic.directoryPath, 'refs', 'reference.txt'), '其他保存的参考。')
    const readSpy = vi.spyOn(f.files, 'read')
    const listing = await f.owner.call('topic.knowledge.ls', { topicId: f.topic.topicId })
    expect(listing.entries).toEqual([])
    expect(listing.unavailable).toEqual([])
    expect(readSpy).not.toHaveBeenCalled()
    expect(exact(listing.documents, 'outcome/report.md')).toMatchObject({ topicId: f.topic.topicId, readScope: 'name', snippet: null, revision: null,
      target: { zoneId: f.topic.zoneId, expectedResource: f.expectedResource, maxBytes: 131072 } })
    expect(exact(listing.documents, 'topic.md')).toBeDefined()
    expect(exact(listing.documents, SCRATCH_TOPIC_WIKI_PATH)).toBeDefined()
    const socketPath = join(f.root, 'rpc.sock'), server = new AgentMuxControlServer({ socketPath, spatialState: f.state, coreClients: () => [], topics: f.owner, files: f.publicFiles })
    servers.push(server); await server.start()
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
    const env = objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + socketPath })
    try {
      const searched = await client.call('topic.knowledge.search', { topicId: f.topic.topicId, query: '挂载磁盘权限' })
      expect(searched.entries).toEqual([])
      expect(searched.unavailable).toEqual([])
      expect(searched.documents).toHaveLength(1)
      const doc = exact(searched.documents, 'outcome/report.md')
      expect(doc).toMatchObject({ readScope: 'full', snippet: expect.stringContaining('挂载磁盘权限'), revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) })
      const original = await client.call('file.read', doc.target)
      expect(original.result).toMatchObject({ status: 'read', document: { content: body, revision: doc.revision } })
      expect(original.resource).toMatchObject({ zoneId: f.topic.zoneId, workspaceId: f.workspace.id, path: scratchTopicDirectoryName(f.topic.topicId) + '/outcome/report.md' })
      const cli = await runCompiledObjectCli(['topic', 'knowledge', 'search', '--query', '挂载磁盘权限', '--topic', f.topic.topicId], env)
      expect(cli.code, cli.stderr).toBe(0)
      expect(JSON.parse(cli.stdout).result).toEqual(searched)
      const read = await runCompiledObjectCli(['file', 'read', '--zone', doc.target.zoneId, '--path', doc.target.path,
        '--host', 'local', '--workspace', f.workspace.id, '--workspace-path', f.workspace.path, '--max-bytes', '131072'], env)
      expect(read.code, read.stderr).toBe(0)
      expect(JSON.parse(read.stdout).result).toEqual(original)
      expect(await readFile(join(f.topic.directoryPath, 'outcome', 'report.md'), 'utf8')).toBe(body)
      await expect(lstat(join(f.topic.directoryPath, 'knowledge'))).rejects.toMatchObject({ code: 'ENOENT' })
      if (process.env.AGENTMUX_TEST_TOPIC_DOCUMENT_CLI_RECEIPT) await writeFile(process.env.AGENTMUX_TEST_TOPIC_DOCUMENT_CLI_RECEIPT,
        JSON.stringify({ cli: { search: cli, read }, original, searched, knowledgeDirectoryAbsentBeforeAndAfter: true }, null, 2) + '\n')
    } finally { await client.dispose() }
  }, 20_000)
  it('keeps same relative paths in different original Zones distinct and excludes Mote documents without changing its files', async () => {
    const f = await fixture(), { topic: second } = await f.owner.call('topic.create', { topicId: 'view:other-documents', title: '其他原资料' })
    await writeFile(join(f.topic.directoryPath, 'outcome', 'same.md'), '专属词甲与共同词')
    await writeFile(join(second.directoryPath, 'outcome', 'same.md'), '专属词乙与共同词')
    const mote = await f.scratch.ensureMote(f.workspace, 'view:private-document-mote')
    const privatePath = join(scratchTopicPhysicalPath(f.workspace, mote), 'outcome', 'private.md')
    await writeFile(privatePath, '共同词私有')
    const exactRequest = f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: '专属词' })
    await expect(exactRequest).resolves.toMatchObject({ unavailable: [], documents: [{ topicId: f.topic.topicId, target: { zoneId: f.topic.zoneId } }] })
    const only = await exactRequest
    expect(only.documents).toHaveLength(1)
    expect(only.documents[0]).toMatchObject({ topicId: f.topic.topicId, target: { zoneId: f.topic.zoneId }, snippet: expect.stringContaining('专属词甲') })
    expect((await f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: '专属词乙' })).documents).toEqual([])
    const all = await f.owner.call('topic.knowledge.search', { query: '共同词' })
    expect(all.unavailable).toEqual([])
    expect(all.documents).toHaveLength(2)
    expect(new Set(all.documents.map(item => item.target.zoneId + ':' + item.target.path)).size).toBe(2)
    expect(all.documents.map(item => item.topicId).sort()).toEqual([f.topic.topicId, second.topicId].sort())
    await expect(f.owner.call('topic.knowledge.search', { topicId: mote.id, query: '共同词' })).rejects.toMatchObject({ code: 'TOPIC_TARGET_IS_MOTE' })
    expect(await readFile(privatePath, 'utf8')).toBe('共同词私有')
  })
  it('keeps original topic.md and Wiki searchable, skips runtime/build and duplicate UUID backing files, and shares the result limit', async () => {
    const f = await fixture(), entryId = '11111111-1111-4111-8111-111111111111'
    await writeFile(join(f.topic.directoryPath, 'topic.md'), '# 原资料\n主题持续记录可发现词\n')
    await writeFile(join(f.topic.directoryPath, SCRATCH_TOPIC_WIKI_PATH), 'Wiki原文可发现词')
    for (const path of ['.agentmux/runtime.json', '.agents/private.md', 'node_modules/pkg.md', 'dist/generated.md']) {
      await mkdir(join(f.topic.directoryPath, path, '..'), { recursive: true }); await writeFile(join(f.topic.directoryPath, path), '内部文件可发现词')
    }
    await f.owner.call('topic.knowledge.write', { topicId: f.topic.topicId, entryId, title: '条目可发现词', content: '条目正文', form: 'derived', certainty: 'proposal', sources: [{ kind: 'topic', topicId: f.topic.topicId }], expectedRevision: null })
    await writeFile(join(f.topic.directoryPath, 'knowledge', 'authored.md'), '其他保存文档可发现词')
    const found = await f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: '可发现词' })
    expect(found.entries).toHaveLength(1)
    expect(found.documents.map(item => item.target.path).sort()).toEqual([SCRATCH_TOPIC_WIKI_PATH, 'knowledge/authored.md', 'topic.md'].sort())
    expect(found.unavailable).toEqual([])
    const limited = await f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: '可发现词', limit: 2 })
    expect(limited.entries.length + limited.documents.length).toBe(2)
    expect(limited.unavailable).toContainEqual(expect.objectContaining({ code: 'TOPIC_KNOWLEDGE_PARTIAL' }))
  })
  it('keeps the explicitly saved Wiki searchable when original Git discovery omits its hidden directory', async () => {
    const f = await fixture()
    await promisify(execFile)('git', ['init', '-q'], { cwd: f.topic.directoryPath })
    await writeFile(join(f.topic.directoryPath, '.gitignore'), '.agentmux/\n')
    await writeFile(join(f.topic.directoryPath, SCRATCH_TOPIC_WIKI_PATH), '保存的Wiki特有正文词')
    const raw = await f.publicFiles.list({ zoneId: f.topic.zoneId, path: '.', expectedResource: f.expectedResource })
    expect(raw.result).toMatchObject({ status: 'listed', omitted: 'git-ignored' })
    if (raw.result.status !== 'listed') throw Error('Actual Git discovery must list names.')
    expect(raw.result.files).not.toContain(SCRATCH_TOPIC_WIKI_PATH)
    const result = await f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: '特有正文词' })
    expect(exact(result.documents, SCRATCH_TOPIC_WIKI_PATH)).toMatchObject({ readScope: 'full', snippet: '保存的Wiki特有正文词' })
    expect(result.unavailable).toContainEqual(expect.objectContaining({ code: 'TOPIC_KNOWLEDGE_PARTIAL' }))
  })
  it('refuses oversized document bodies before reading, preserves default original reads, and bounds click reads even after growth', async () => {
    const f = await fixture(), path = 'refs/large.json', body = 'x'.repeat(131073)
    await writeFile(join(f.topic.directoryPath, path), body)
    const listing = await f.owner.call('topic.knowledge.ls', { topicId: f.topic.topicId })
    const doc = exact(listing.documents, path), costs: number[] = []
    const read = f.files.read.bind(f.files)
    vi.spyOn(f.files, 'read').mockImplementation((w, p, budget) => read(w, p, budget ? { ...budget, onReadCost: cost => { costs.push(cost.payloadBytes); budget.onReadCost?.(cost) } } : budget))
    const search = await f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: 'xxxxx' })
    expect(search.documents).toEqual([])
    expect(search.unavailable).toContainEqual(expect.objectContaining({ code: 'WORKSPACE_FILE_BYTE_LIMIT', source: f.topic.topicId + ':' + path }))
    expect(costs).toContain(0)
    expect(await f.publicFiles.read(doc.target)).toMatchObject({ result: { status: 'error', code: 'WORKSPACE_FILE_BYTE_LIMIT' } })
    const { maxBytes, ...unbounded } = doc.target
    expect(await f.publicFiles.read(unbounded)).toMatchObject({ result: { status: 'read', document: { content: body } } })
    await writeFile(join(f.topic.directoryPath, 'outcome', 'grows.md'), '先命中资料')
    const hit = exact((await f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: '先命中' })).documents, 'outcome/grows.md')
    await writeFile(join(f.topic.directoryPath, 'outcome', 'grows.md'), body)
    expect(await f.publicFiles.read(hit.target)).toMatchObject({ result: { status: 'error', code: 'WORKSPACE_FILE_BYTE_LIMIT' } })
  })
  it('charges real nonmatching body reads to the shared 4 MiB budget and reports the unobserved tail', async () => {
    const f = await fixture(), costs: number[] = [], read = f.files.read.bind(f.files)
    for (let index = 0; index < 36; index++) await writeFile(join(f.topic.directoryPath, 'outcome', `candidate-${String(index).padStart(2, '0')}.md`), 'a'.repeat(131072))
    vi.spyOn(f.files, 'read').mockImplementation((w, p, budget) => read(w, p, budget ? { ...budget, onReadCost: cost => { costs.push(cost.payloadBytes); budget.onReadCost?.(cost) } } : budget))
    const result = await f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: 'missing-body-only-query' })
    expect(result.entries).toEqual([]); expect(result.documents).toEqual([])
    expect(result.unavailable).toContainEqual(expect.objectContaining({ code: 'TOPIC_KNOWLEDGE_PARTIAL' }))
    const actual = costs.reduce((total, bytes) => total + bytes, 0)
    expect(actual).toBeGreaterThan(3 * 1024 * 1024)
    expect(actual).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(costs.filter(bytes => bytes === 131072)).toHaveLength(31)
    if (process.env.AGENTMUX_TEST_TOPIC_DOCUMENT_READ_COST_RECEIPT) await writeFile(process.env.AGENTMUX_TEST_TOPIC_DOCUMENT_READ_COST_RECEIPT,
      JSON.stringify({ costs, actualCandidateBodyBytes: actual, documentsReturned: result.documents.length, unavailable: result.unavailable,
        perOriginalDocumentCap: 131072, sharedCandidateBodyCap: 4194304,
        metadataBoundary: 'Existing ScratchTopics Topic/SOUL/Wiki identity observations are owned separately and are not charged to this candidate-body budget.' }, null, 2) + '\n')
  }, 20_000)
  it('stops later Files I/O when the actual in-flight worker is aborted and refuses pre-aborted reads', async () => {
    const f = await fixture(), controller = new AbortController(), read = f.files.read.bind(f.files)
    for (const name of ['first.md', 'later.md']) await writeFile(join(f.topic.directoryPath, 'outcome', name), '正文')
    let started = 0
    workerProbe.onSpawn = () => { started++; controller.abort() }
    const spy = vi.spyOn(f.files, 'read').mockImplementation((w, path, budget) => read(w, path, budget))
    await expect(f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: '正文' }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(started).toBe(1)
    await expect(read(f.workspace, scratchTopicDirectoryName(f.topic.topicId) + '/outcome/first.md', { maxFileBytes: 131072, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('reports an expired shared deadline as partial without turning it into a complete empty result or starting a later worker', async () => {
    const f = await fixture(), deadline = new AbortController(), before = await f.state.read()
    for (const name of ['first.md', 'later.md']) await writeFile(join(f.topic.directoryPath, 'outcome', name), '正文')
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    let started = 0
    workerProbe.onSpawn = () => { started++; deadline.abort(new DOMException('Time budget expired', 'TimeoutError')) }
    const result = await f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: '正文' })
    expect(result.documents).toEqual([])
    expect(result.unavailable).toContainEqual(expect.objectContaining({ code: 'TOPIC_KNOWLEDGE_PARTIAL' }))
    expect(started).toBe(1)
    expect(await f.state.read()).toEqual(before)
  })
  it('preserves discovered names beside a deleted file, binary text suffix, unknown resource and candidate exhaustion', async () => {
    const f = await fixture(), path = 'outcome/disappears.md'
    await writeFile(join(f.topic.directoryPath, path), '原文件')
    const listing = await f.owner.call('topic.knowledge.ls', { topicId: f.topic.topicId })
    const doc = exact(listing.documents, path)
    await rm(join(f.topic.directoryPath, path))
    expect(await f.publicFiles.read(doc.target)).toMatchObject({ result: { status: 'deleted' } })
    await writeFile(join(f.topic.directoryPath, 'refs', 'binary.md'), Buffer.from([0, 1, 2]))
    const binary = await f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: 'binary' })
    expect(binary.documents).toEqual([])
    expect(binary.unavailable).toContainEqual(expect.objectContaining({ code: 'TOPIC_DOCUMENT_UNAVAILABLE', source: f.topic.topicId + ':refs/binary.md' }))
    expect(await f.publicFiles.read({ ...doc.target, zoneId: 'unknown-original-zone' })).toMatchObject({ resource: null, result: { status: 'unknown' } })
    for (let index = 0; index < 520; index++) await writeFile(join(f.topic.directoryPath, 'refs', `ignored-${index}.bin`), '')
    const partial = await f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: 'never-observed' })
    expect(partial.unavailable).toContainEqual(expect.objectContaining({ code: 'TOPIC_KNOWLEDGE_PARTIAL' }))
  })
})
