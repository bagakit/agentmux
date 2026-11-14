import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '@agentmux/core'
import { AgentMuxSpatialStateStore, spatialCatalog } from '@agentmux/core/spatial-state'
import { TopicKnowledgeOwner } from '../../host/src/topic-knowledge'
import { TopicSearchHistoryOwner } from '../../host/src/topic-search-history'
import { TopicSpatialOwner } from '../../host/src/topic-spatial-owner'
import { FileReadOwner } from '../../host/src/file-read-owner'
import { SCRATCH_WORKSPACE_ID } from '../../host/src/mote-model'
import { ScratchTopics } from '../../host/src/mote-resources'
import { OrdinaryWorkspaceFiles } from '../../host/src/ordinary-files'
import type { WorkspaceRecord } from '../src/shared/contracts'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { agentMuxCommandHelp } from '../../../packages/core/src/agentmux-cli-help'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { failures.push(error) }
  vi.restoreAllMocks()
  if (failures.length) throw new AggregateError(failures, 'Private search-history fixture cleanup failed.')
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-history-cli-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'scratch'); await mkdir(path)
  const workspace: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path, kind: 'folder' }
  const files = new OrdinaryWorkspaceFiles(), scratch = new ScratchTopics({ files })
  const state = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  const historyPath = join(root, 'history.json'), history = new TopicSearchHistoryOwner(historyPath)
  const owner = new TopicKnowledgeOwner(scratch, files, () => workspace, history)
  owner.setSpatialPort(new TopicSpatialOwner({ state, workspace: () => workspace, topics: () => owner.listTopicSnapshots(),
    categories: () => owner.listCategories(), ensureDefaultCategory: () => owner.ensureDefaultCategoryContent() }))
  const publicFiles = new FileReadOwner({ files, workspace: id => id === workspace.id ? workspace : undefined,
    topicForDirectory: (w, directory) => scratch.readForDirectory(w, directory),
    catalog: async () => { const current = await state.read(); return current ? spatialCatalog(current.graph) : null } })
  owner.setFileReadPort(publicFiles)
  const { topic } = await owner.call('topic.create', { topicId: 'view:history-cli', title: 'Original search' })
  await writeFile(join(topic.directoryPath, 'outcome', 'report.md'), 'Unique source: 索引观察。Private source body remains in its original document.')
  const socketPath = join(root, 'rpc.sock'), server = new AgentMuxControlServer({ socketPath, spatialState: state, coreClients: () => [], topics: owner })
  await server.start(); cleanup.push(() => server.stop())
  const env = objectCliEnvironment(root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + socketPath })
  const run = (args: string[]) => runCompiledObjectCli(['topic', 'knowledge', ...args], env)
  return { root, topic, owner, files, historyPath, run }
}

describe('knowledge search history through the compiled object CLI', () => {
  it('reads the exact original saved search and its filters without searching or copying document bodies', async () => {
    const f = await fixture()
    const searched = await f.run(['search', '--topic', f.topic.topicId, '--query', '索引观察'])
    expect(searched.code, searched.stderr).toBe(0)
    const search = JSON.parse(searched.stdout).result
    expect(search.documents).toHaveLength(1)
    expect(search.observation.history).toBe('saved')
    const record = search.observation.record
    expect(record.searchId).toBeTruthy()
    expect(record.counters.documentMatches).toBe(1)
    // Two equal query/scope observations make the exact search selector carry proof.
    const laterSearch = await f.run(['search', '--topic', f.topic.topicId, '--query', '索引观察'])
    expect(laterSearch.code, laterSearch.stderr).toBe(0)
    const later = JSON.parse(laterSearch.stdout).result.observation.record
    expect(later.searchId).not.toBe(record.searchId)
    const originalBytes = await readFile(f.historyPath, 'utf8')
    const searchAgain = vi.spyOn(f.owner, 'call')
    const readBody = vi.spyOn(f.files, 'read')
    const history = await f.run(['history', '--topic', f.topic.topicId, '--query', '索引观察', '--search', record.searchId, '--limit', '1'])
    expect(history.code, history.stderr).toBe(0)
    expect(JSON.parse(history.stdout)).toMatchObject({ operation: 'topic.knowledge.history', result: {
      records: [record], hasMore: false, unavailable: [], retention: { prunedRecords: 0 } } })
    expect(searchAgain.mock.calls.map(([method]) => method)).toEqual(['topic.knowledge.history'])
    expect(readBody).not.toHaveBeenCalled()
    expect(history.stdout).not.toContain('Private source body')
    expect(await readFile(f.historyPath, 'utf8')).toBe(originalBytes)
    const exactQuery = await f.run(['history', '--query', ' 索引观察 '])
    expect(exactQuery.code, exactQuery.stderr).toBe(0)
    expect(JSON.parse(exactQuery.stdout).result.records).toEqual([])
    const otherTopic = await f.run(['history', '--topic', 'view:other-history'])
    expect(otherTopic.code, otherTopic.stderr).toBe(0)
    expect(JSON.parse(otherTopic.stdout).result.records).toEqual([])
    const all = await f.run(['history'])
    expect(all.code, all.stderr).toBe(0)
    expect(JSON.parse(all.stdout).result.records).toEqual([later, record])
    const help = agentMuxCommandHelp('topic.knowledge.history')
    expect(help).toContain('--search ID')
    expect(help).toContain('absent record never proves a search did not run')
  }, 30_000)
  it('reports the original history read failure without repairing bytes or replaying the search', async () => {
    const f = await fixture(), corrupt = '{"private":"history bytes kept'
    await writeFile(f.historyPath, corrupt)
    const calls = vi.spyOn(f.owner, 'call')
    const result = await f.run(['history', '--topic', f.topic.topicId])
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).result).toMatchObject({ records: [], hasMore: false,
      unavailable: [{ code: 'TOPIC_SEARCH_HISTORY_UNAVAILABLE' }] })
    expect(calls.mock.calls.map(([method]) => method)).toEqual(['topic.knowledge.history'])
    expect(result.stdout).not.toContain('history bytes kept')
    expect(await readFile(f.historyPath, 'utf8')).toBe(corrupt)
  })
  it('rejects malformed filters through the public codec and unknown CLI options without changing history', async () => {
    const f = await fixture(), before = await f.owner.call('topic.knowledge.history', {})
    for (const args of [['--limit', '0'], ['--limit', '101'], ['--limit', '1.5'], ['--query', ' '], ['--search', ''], ['--unknown', 'value']]) {
      const result = await f.run(['history', ...args])
      expect(result.code, JSON.stringify(args) + ': ' + result.stderr).toBe(1)
      expect(JSON.parse(result.stderr).error.code).toMatch(/^INVALID_(CONTROL_REQUEST|CLI_ARGUMENT)$/u)
    }
    expect(await f.owner.call('topic.knowledge.history', {})).toEqual(before)
  })
})
