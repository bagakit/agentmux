import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxRpcService, type ExecutionHost } from '@agentmux/core'
import { mintObjectId } from '@agentmux/core/object-id'
import type { AgentMuxSpaceCatalog, KnowledgeTopic, TopicCategory, TopicKnowledge } from '@agentmux/core/control'
import { parseFileReadParams, parseFileReadResult, type FileReadParams, type FileReadResult } from '@agentmux/core/files'
import { FileReadOwner } from '../../desktop/src/main/file-read-owner'
import { WorkspaceFiles } from '../../desktop/src/main/workspace-files'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { mobileKnowledgeDraftKey } from '../src/recovery/knowledge-drafts'
import { button, click, fixture, mount, mounted } from './conversation-fixture'

const connected = { state: 'connected' as const, message: 'Original mounted client' }
const hostId = 'original-chat-source-host', workspaceId = 'original-chat-source-workspace'
const resources: Array<{ path: string; files: WorkspaceFiles }> = []
async function waitFor(check: () => void) {
  await vi.waitFor(async () => { await act(async () => {}); check() })
}
async function typeBody(scope: HTMLElement, content: string) {
  const editor = scope.querySelector<HTMLTextAreaElement>('[aria-label="知识正文"]')!
  expect(editor).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, content)
    editor.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
beforeEach(async () => {
  localStorage.clear()
  await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
  await getDeviceWorkface().confirmHost({ origin: location.origin, hostId })
})
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  for (const resource of resources.splice(0)) { await resource.files.dispose(); await rm(resource.path, { recursive: true, force: true }) }
  document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); window.history.replaceState(null, '')
})

describe('actual App Knowledge Chat source consumes original Files and Markdown', () => {
  it('renders the specified second Chat and Region from disk, then returns to the original later draft and whole unknown request', async () => {
    const path = await realpath(await mkdtemp(join(tmpdir(), 'amx-topic-chat-source-')))
    const files = new WorkspaceFiles(() => ({ kind: 'local' } as ExecutionHost))
    resources.push({ path, files })
    await mkdir(join(path, 'topic-dir/refs'), { recursive: true })
    const firstBody = '# 第一 Chat 磁盘标题\n\n第一份真实文件，不能冒充第二 Chat。'
    const secondHeading = '准确第二 Chat 磁盘标题', secondBody = '# ' + secondHeading + '\n\n第二 Region 的原 Files 非空正文。'
    await writeFile(join(path, 'topic-dir/refs/first-chat.md'), firstBody)
    await writeFile(join(path, 'topic-dir/refs/second-chat.md'), secondBody)
    expect(await readFile(join(path, 'topic-dir/refs/first-chat.md'), 'utf8')).toBe(firstBody)
    const firstChat = mintObjectId(), secondChat = mintObjectId(), firstRegion = mintObjectId(), secondRegion = mintObjectId()
    const sourceZone = { zoneId: 'original-source-topic-zone', workspaceId, kind: 'directory' as const, hostId, directoryPath: join(path, 'topic-dir'), branch: null }
    const knowledgeZone = { ...sourceZone, zoneId: 'original-knowledge-topic-zone', directoryPath: join(path, 'knowledge-dir') }
    const catalog: AgentMuxSpaceCatalog = { spaces: [], zones: [sourceZone, knowledgeZone],
      tabs: [{ tabId: firstChat, zoneId: sourceZone.zoneId, workspaceId, name: '第一来源 Chat', regionIds: [firstRegion] },
        { tabId: secondChat, zoneId: sourceZone.zoneId, workspaceId, name: '准确第二来源 Chat', regionIds: [secondRegion] }],
      regions: [{ regionId: firstRegion, tabId: firstChat, kind: 'file', agentSessionId: null, runId: null, execution: null,
        file: { workspaceId, path: 'topic-dir/refs/first-chat.md', zoneRelativePath: 'refs/first-chat.md' } },
      { regionId: secondRegion, tabId: secondChat, kind: 'file', agentSessionId: null, runId: null, execution: null,
        file: { workspaceId, path: 'topic-dir/refs/second-chat.md', zoneRelativePath: 'refs/second-chat.md' } }],
      bindings: [], locations: [], agentPresentation: [], motePresentation: [] }
    const fileOwner = new FileReadOwner({ files, workspace: id => id === workspaceId ? { id, hostId, name: '原文件 Workspace', path, kind: 'folder' } : undefined,
      catalog: async () => catalog })
    const service = new AgentMuxRpcService({ files: fileOwner, coreClients: () => [] })
    const diskReads = vi.spyOn(files, 'read'), diskWrites = vi.spyOn(files, 'write')
    const categories: TopicCategory[] = ['第一分类', '准确第二分类'].map(title => ({ categoryId: mintObjectId(), hostId, spaceId: mintObjectId(), directoryPath: path, title, revision: null }))
    const sourceTopic: KnowledgeTopic = { topicId: mintObjectId(), hostId, zoneId: sourceZone.zoneId, directoryPath: sourceZone.directoryPath,
      title: '来源讨论 Topic', summary: '', categorySpaceIds: [categories[0]!.spaceId], chatIds: [firstChat, secondChat], spatialRevision: 1 }
    const knowledgeTopic: KnowledgeTopic = { ...sourceTopic, topicId: mintObjectId(), zoneId: knowledgeZone.zoneId, directoryPath: knowledgeZone.directoryPath,
      title: '准确第二知识 Topic', categorySpaceIds: [categories[1]!.spaceId], chatIds: [] }
    const source = { kind: 'topic' as const, topicId: sourceTopic.topicId, chatId: secondChat, threadId: secondRegion }
    const second: TopicKnowledge = { topicId: knowledgeTopic.topicId, entryId: mintObjectId(), title: '准确第二知识', content: '原第二知识正文',
      form: 'derived', certainty: 'proposal', sources: [source], revision: 'sha256:' + 'a'.repeat(64), updatedAt: 1 }
    const first: TopicKnowledge = { ...second, entryId: mintObjectId(), title: '第一知识', content: '不得选择的第一知识', sources: [{ ...source, chatId: firstChat, threadId: firstRegion }] }
    const readReceipts: Array<{ params: FileReadParams; result: FileReadResult }> = []
    const f = fixture(); f.sessions.clear()
    f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-chat-source-runtime', ownerInstanceId: 'original-chat-source-process', availability: 'connected' })
    // Only discovery/Knowledge receipts are controlled metadata. File bodies always traverse the real owner and public codec.
    const rpc = vi.fn(async (method: string, params: any) => {
      if (method === 'goal.ls') return { goals: [], unavailable: [] }
      if (method === 'topic.category.ls') return { categories, unavailable: [] }
      if (method === 'topic.ls') return { topics: params.categoryId === categories[1]!.categoryId ? [sourceTopic, knowledgeTopic] : [sourceTopic], unavailable: [] }
      if (method === 'topic.inspect') return { topic: params.topicId === sourceTopic.topicId ? sourceTopic : knowledgeTopic, unavailable: [] }
      if (method === 'topic.knowledge.ls') return { entries: [first, second], documents: [], unavailable: [] }
      if (method === 'topic.knowledge.read') return { entry: params.entryId === second.entryId ? second : first }
      if (method === 'topic.knowledge.write') throw new Error('Original mounted save receipt unavailable')
      if (method === 'app.snapshot') return { workspaces: [{ workspaceId, hostId, name: '原文件 Workspace', path, kind: 'folder', projectId: null, repoPath: null, branch: null }], unavailable: [] }
      if (method === 'space.ls') return { catalog: params.target?.zoneId === sourceZone.zoneId ? catalog : { ...catalog, tabs: [], regions: [] } }
      if (method === 'file.read') {
        const input = parseFileReadParams(params), result = parseFileReadResult(await service.call('file.read', input), input)
        readReceipts.push({ params: input, result }); return result
      }
      throw new Error('Unexpected mounted business operation: ' + method)
    })
    f.client.forwardRpc = rpc as NonNullable<typeof f.client.forwardRpc>
    const owner = getDeviceWorkface(), recordId = owner.recordIdentity()
    const { element } = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
    await click(button(element.querySelector<HTMLElement>('.mobile-navigation')!, 'Topics'))
    const topics = element.querySelector<HTMLElement>('section[aria-label="Topics"]')!
    await waitFor(() => expect(topics.textContent).toContain(categories[1]!.title))
    await click(button(topics, categories[1]!.title))
    await waitFor(() => expect(topics.textContent).toContain(knowledgeTopic.title))
    await click(button(topics, knowledgeTopic.title))
    await click(button(topics.querySelector<HTMLElement>('[aria-label="Topic 内容"]')!, '知识'))
    const knowledge = topics.querySelector<HTMLElement>(`[aria-label="${knowledgeTopic.title}知识"]`)!
    await waitFor(() => expect(knowledge.textContent).toContain(second.title))
    await click(button(knowledge, second.title + '提案'))
    await waitFor(() => expect(knowledge.querySelector('h2')?.textContent).toBe(second.title))
    await click(button(knowledge, '编辑知识'))
    const originalEditor = knowledge.querySelector<HTMLTextAreaElement>('[aria-label="知识正文"]')!
    const sent = '明确保存的原完整请求正文', later = '原请求之后仍可编辑的后来稿'
    await typeBody(knowledge, sent); await click(button(knowledge, '保存知识'))
    await waitFor(() => expect(knowledge.textContent).toContain('保存未确认'))
    await typeBody(knowledge, later)
    await waitFor(() => expect(owner.snapshot().record.knowledgeDrafts?.[0]?.content).toBe(later))
    const before = structuredClone(owner.snapshot().record.knowledgeDrafts![0]!), attempt = before.attempts[0]!
    const input = { topicId: knowledgeTopic.topicId, entryId: second.entryId, expectedRevision: second.revision,
      title: second.title, content: sent, form: second.form, certainty: second.certainty, sources: [source] }
    expect(before.scope).toEqual({ origin: location.origin, runtimeId: 'original-chat-source-runtime', deviceHostId: hostId })
    expect(before.attempts).toHaveLength(1); expect(attempt.phase).toBe('unknown'); expect(attempt.input).toEqual(input)
    expect(rpc.mock.calls.filter(([method]) => method === 'topic.knowledge.write').map(([, params]) => params)).toEqual([input])
    await click(button(knowledge, '返回阅读')); await click(button(knowledge, '原讨论'))
    const workface = () => element.querySelector<HTMLElement>(`[aria-label="${sourceTopic.title} 的讨论与内容"]`)
    try {
      await waitFor(() => expect(workface()?.querySelector('[aria-label="原文件阅读"] h1')?.textContent).toBe(secondHeading))
    } catch (error) {
      console.error('Original Chat source failure diagnostics', JSON.stringify({
        workfaceHtml: workface()?.outerHTML ?? null,
        visibleWorkfaces: [...element.querySelectorAll('.mobile-zone-workface')].filter(node => !node.closest('[hidden]')).map(node => node.outerHTML),
        visibleStatuses: [...element.querySelectorAll('[role=status]')].filter(node => !node.closest('[hidden]')).map(node => node.textContent),
        rpc: rpc.mock.calls.map(([method, params]) => ({ method, params })), readReceipts,
        diskReads: diskReads.mock.calls, diskReadResults: diskReads.mock.results.map(value => ({ type: value.type, valueType: typeof value.value })),
        source, firstChat, firstRegion, sourceZone, record: owner.snapshot().record
      }, null, 2))
      throw error
    }
    expect(workface()!.closest('[hidden]')).toBeNull()
    expect(workface()!.querySelectorAll('[aria-label="原文件阅读"]')).toHaveLength(1)
    expect(workface()!.querySelector('h2')?.textContent).toBe('准确第二来源 Chat')
    expect(workface()!.textContent).toContain('第二 Region 的原 Files 非空正文。')
    expect(workface()!.textContent).not.toContain('第一来源 Chat'); expect(workface()!.textContent).not.toContain('第一 Chat 磁盘标题')
    expect(readReceipts).toHaveLength(1)
    expect(readReceipts[0]!.params).toEqual({ zoneId: sourceZone.zoneId, path: 'refs/second-chat.md', expectedResource: { hostId, workspaceId, workspacePath: path } })
    const read = readReceipts[0]!.result
    expect(read.resource).toMatchObject({ hostId, workspaceId, workspacePath: path, zoneId: sourceZone.zoneId, zonePath: sourceZone.directoryPath, path: 'topic-dir/refs/second-chat.md' })
    expect(read.result.status).toBe('read')
    if (read.result.status !== 'read') throw new Error('The real original File owner must return a nonempty read')
    expect(read.result.document.path).toBe('topic-dir/refs/second-chat.md'); expect(read.result.document.content).toBe(secondBody)
    expect(diskReads).toHaveBeenCalledOnce(); expect(diskReads.mock.calls[0]![1]).toBe('topic-dir/refs/second-chat.md')
    const frame = owner.snapshot().record.presentation!.topics!.sources[0]!
    expect(frame.source).toEqual(source)
    expect(frame.origin).toEqual({ categoryId: categories[1]!.categoryId, topicId: knowledgeTopic.topicId, mode: 'knowledge' })
    expect(frame.originKnowledge).toEqual({ topicId: knowledgeTopic.topicId, entryId: second.entryId, view: 'read', draftKey: mobileKnowledgeDraftKey(knowledgeTopic.topicId, second.entryId, before.scope) })
    const fileReadsBeforeBack = readReceipts.length
    await click(button(topics, '返回知识'))
    await waitFor(() => { expect(knowledge.closest('[hidden]')).toBeNull(); expect(knowledge.querySelector('h2')?.textContent).toBe(second.title) })
    await click(button(knowledge, '继续编辑草稿'))
    expect(knowledge.querySelector('[aria-label="知识正文"]')).toBe(originalEditor)
    expect(originalEditor.closest('[hidden]')).toBeNull()
    expect(originalEditor.value).toBe(later)
    expect(owner.snapshot().record.knowledgeDrafts).toEqual([before])
    expect(owner.snapshot().record.presentation!.topics!.sources).toEqual([])
    expect(owner.snapshot().record.presentation!.topics!.context).toEqual(frame.origin)
    expect(owner.recordIdentity()).toBe(recordId); expect(readReceipts).toHaveLength(fileReadsBeforeBack)
    expect(rpc.mock.calls.filter(([method]) => method === 'topic.knowledge.write')).toHaveLength(1)
    const readonlyMethods = new Set(['goal.ls', 'topic.category.ls', 'topic.ls', 'topic.inspect', 'topic.knowledge.ls', 'topic.knowledge.read', 'app.snapshot', 'space.ls', 'file.read'])
    expect(rpc.mock.calls.filter(([method]) => !readonlyMethods.has(method)).map(([method]) => method)).toEqual(['topic.knowledge.write'])
    expect(diskWrites).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
    expect(f.client.agentSessions()).toEqual([])
  })
})
