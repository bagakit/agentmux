import { tmpdir } from 'node:os'
import { fixturePath } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileRegionContent } from '../src/navigation/MobileRegionContent'
import { MobileSurveySurface } from '../src/survey/MobileSurveySurface'
import { readSurveyPresentation } from '../../desktop/src/renderer/src/lib/mobile-presentation'
import { FileReadOwner } from '../../desktop/src/main/file-read-owner'
import { parseFileReadResult } from '../../../packages/core/src/public-rpc-files'
import { parseSpaceControlSuccessReceipt } from '../../../packages/core/src/space-control-parser'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const mounted: { root: Root; element: HTMLDivElement }[] = []
afterEach(async () => { for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() } })
const catalog = {
  spaces: [{ spaceId: 'topic-original', kind: 'topic', name: '原关联课题', hostId: 'local', directoryPath: fixturePath("topic"), projectId: null }],
  zones: ['research', 'uncollected'].map(zoneId => ({ zoneId, workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: fixturePath("original"), branch: null })),
  tabs: [{ tabId: 'tab-original', zoneId: 'research', workspaceId: 'resource', name: '原内容标签', regionIds: ['browser-original', 'agent-original', 'note-original'] }],
  regions: [
    { regionId: 'browser-original', tabId: 'tab-original', kind: 'browser', browserId: 'browser-id-original', agentSessionId: null, runId: null, execution: null },
    { regionId: 'agent-original', tabId: 'tab-original', kind: 'agent', agentSessionId: 'session-original', runId: 'run-original', execution: { hostId: 'local', cwd: fixturePath("execution") } },
    { regionId: 'note-original', tabId: 'tab-original', kind: 'file', file: { workspaceId: 'resource', path: 'original.note.json', zoneRelativePath: 'original.note.json' }, agentSessionId: null, runId: null, execution: null }
  ],
  bindings: [{ zoneId: 'research', spaceId: 'topic-original' }],
  locations: ['display-a', 'display-b'].map(displayWorkspaceId => ({ spaceId: 'topic-original', zoneId: 'research', workspaceId: 'resource', displayWorkspaceId, groupId: 'group-original', tabId: 'tab-original', regionId: 'agent-original' })),
  survey: { items: [{ zoneId: 'research', name: '原命名研究' }, { zoneId: 'missing-zone', name: '图暂缺的原研究' }], selection: { zoneId: 'research', selection: [{ tabId: 'tab-original', regionId: 'agent-original' }], active: { tabId: 'tab-original', regionId: 'agent-original' } } },
  agentPresentation: [{ agentSessionId: 'session-original', name: '原 Agent 名称', project: '原项目', detail: '', group: 'working', state: 'working', providerId: 'codex', recap: null }]
}
function parsed(value: unknown) { const receipt = parseSpaceControlSuccessReceipt({ schemaVersion: 5, requestId: 'read', ok: true, operation: 'space.ls', result: { catalog: value } }); return (receipt.result as { catalog: typeof catalog }).catalog }
async function mount(forwardRpc = vi.fn().mockImplementation(async (method: string) => method === 'app.snapshot' ? { workspaces: [{ workspaceId: 'resource', hostId: 'local', path: fixturePath("original") }] } : method === 'file.read' ? { result: { status: 'unknown', message: '原文件待确认' } } : method === 'browser.targets' ? { targets: [] } : { catalog: parsed(catalog) })) {
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounted.push({ root, element })
  const openSession = vi.fn(), openTopic = vi.fn()
  await act(async () => root.render(<MobileSurveySurface client={{ forwardRpc } as any} connected openSession={openSession} openTopic={openTopic} />))
  const click = async (text: string) => { const button = [...element.querySelectorAll('button')].find(button => !button.closest('[hidden]') && button.textContent?.includes(text)); expect(button).toBeDefined(); await act(async () => button!.click()) }
  return { element, forwardRpc, openSession, openTopic, click }
}
describe('original Survey mobile slice', () => {
  it('reads explicit original membership via public RPC and opens the exact Region Session and Topic', async () => {
    const view = await mount()
    expect(view.forwardRpc).toHaveBeenCalledWith('space.ls', { target: {}, presentation: true })
    const list = view.element.querySelector('nav[aria-label="原研究列表"]')!
    expect([...list.querySelectorAll('button strong')].map(button => button.textContent)).toEqual(['原命名研究', '图暂缺的原研究'])
    expect(list.textContent).not.toContain('uncollected')
    expect(view.forwardRpc.mock.calls.map(call => call[0])).toEqual(['space.ls'])
    await view.click('原命名研究')
    expect(view.element.textContent).toContain('tab-original / agent-original')
    expect(view.element.textContent).toContain('display-a'); expect(view.element.textContent).toContain('display-b')
    await view.click('继续对话')
    expect(view.openSession).toHaveBeenCalledWith('session-original', { name: '原 Agent 名称', project: '原项目' })
    await view.click('原关联课题'); expect(view.openTopic).toHaveBeenCalledWith('topic-original')
    expect(view.element.textContent).not.toContain('刷新原 Browser 当前网址')
    expect(view.element.textContent).not.toContain('刷新原文件')
    await view.click('original.note.json')
    expect(view.element.textContent).toContain('刷新原文件')
  })
  it('retains original selection and healthy conversation on failed or missing presentation reads', async () => {
    const view = await mount()
    await view.click('原命名研究')
    view.forwardRpc.mockRejectedValueOnce(new Error('probe failed'))
    await view.click('刷新原研究')
    expect(view.element.textContent).toContain('probe failed')
    await view.click('继续对话'); expect(view.openSession).toHaveBeenCalledTimes(1)
    const { survey: omitted, ...withoutSurvey } = catalog
    view.forwardRpc.mockResolvedValueOnce({ catalog: parsed(withoutSurvey) })
    await view.click('刷新原研究')
    expect(view.element.textContent).toContain('原 Survey 呈现尚未确认')
    expect(view.element.textContent).toContain('原命名研究')
    await view.click('返回研究列表'); await view.click('图暂缺的原研究')
    expect(view.element.textContent).toContain('原 Zone 暂未确认')
    expect(view.element.textContent).not.toContain('继续对话')
  })
  it('reads original Note content only on selection and retains it after observation failure', async () => {
    const view = await mount()
    expect(view.forwardRpc.mock.calls.some(call => call[0] === 'file.read')).toBe(false)
    await view.click('原命名研究'); await view.click('original.note.json')
    expect(view.forwardRpc).toHaveBeenCalledWith('file.read', { zoneId: 'research', path: 'original.note.json', expectedResource: { hostId: 'local', workspaceId: 'resource', workspacePath: fixturePath("original") } })
    const content = JSON.stringify({ schema: 'agentmux.note.v1', noteId: 'note-id', content: { type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: 'block-id' }, content: [{ type: 'text', text: '原笔记全文' }] }] } })
    view.forwardRpc.mockResolvedValueOnce({ workspaces: [{ workspaceId: 'resource', hostId: 'local', path: fixturePath("original") }] }).mockResolvedValueOnce({ resource: { hostId: 'local', workspaceId: 'resource', workspacePath: fixturePath("original"), zoneId: 'research', zonePath: fixturePath("original"), path: 'original.note.json' }, result: { status: 'read', document: { path: 'original.note.json', content, revision: 'rev-original' } } })
    await view.click('刷新原文件')
    expect(view.forwardRpc).toHaveBeenLastCalledWith('file.read', { zoneId: 'research', path: 'original.note.json', expectedResource: { hostId: 'local', workspaceId: 'resource', workspacePath: fixturePath("original") } })
    expect(view.element.querySelector('[data-note-id="note-id"] .mobile-note-body')?.textContent).toBe('原笔记全文')
    expect(view.element.querySelector('[data-block-id="block-id"]')).not.toBeNull()
    view.forwardRpc.mockRejectedValueOnce(new Error('file unavailable'))
    await view.click('刷新原文件')
    expect(view.element.textContent).toContain('file unavailable')
    expect(view.element.querySelector('[data-note-id="note-id"] .mobile-note-body')?.textContent).toBe('原笔记全文')
  })
  it('opens the exact browserId URL as an independent mobile page', async () => {
    const view = await mount()
    await view.click('原命名研究'); await view.click('查看原网页')
    view.forwardRpc.mockResolvedValueOnce({ targets: [{ id: 'wrong-browser', url: 'https://wrong.example', title: 'wrong', status: 'ready' }, { id: 'browser-id-original', url: 'https://original.example/page', title: 'Original page', status: 'ready' }] })
    await view.click('刷新原 Browser 当前网址')
    expect(view.forwardRpc).toHaveBeenLastCalledWith('browser.targets', {})
    expect(view.element.querySelector('a')?.getAttribute('href')).toBe('https://original.example/page')
    expect(view.element.textContent).toContain('不控制 Mac 原 Browser 画面')
  })
  it('carries original collected and file owner output through the codec into actual reading', async () => {
    const raw = JSON.stringify({ schema: 'agentmux.note.v1', noteId: 'owner-note', content: { type: 'doc', content: [{ type: 'heading', attrs: { blockId: 'heading', level: 2 }, content: [{ type: 'text', text: '原标题' }] }, { type: 'paragraph', attrs: { blockId: 'body' }, content: [{ type: 'text', text: '加粗原正文', marks: [{ type: 'bold' }] }] }, { type: 'codeBlock', attrs: { blockId: 'code', language: null }, content: [{ type: 'text', text: 'const original = true' }] }, { type: 'bulletList', content: [{ type: 'listItem', attrs: { blockId: 'item' }, content: [{ type: 'paragraph', attrs: { blockId: 'item-text' }, content: [{ type: 'text', text: '原列表项' }] }] }] }, { type: 'blockReference', attrs: { blockId: 'reference', referenceId: 'ref-original', mode: 'embed', target: { noteId: 'owner-note', blockId: 'body' } } }] } })
    const state = { surveyCollectedZones: { research: true, missing: true }, surveyExplorationNames: { research: '原名中文😀'.repeat(100) }, surveyZoneSelection: catalog.survey.selection, tabs: { 'tab-original': { id: 'tab-original', regions: { 'note-original': { regionId: 'note-original', kind: 'file', workspaceId: 'resource', path: 'original.note.json' } } } } } as any
    const survey = readSurveyPresentation(state, catalog as any)
    const revision = 'sha256:' + 'a'.repeat(64)
    const read = vi.fn().mockResolvedValue({ status: 'read', document: { path: 'original.note.json', content: raw, revision } })
    const workspace = { id: 'resource', hostId: 'local', path: fixturePath("original") }
    const owner = new FileReadOwner({ catalog: async () => catalog as any, workspace: id => id === workspace.id ? workspace as any : undefined, files: { read, listFiles: vi.fn() } })
    const forward = vi.fn().mockImplementation(async (method: string, params: any) => {
      if (method === 'app.snapshot') return { workspaces: [{ workspaceId: workspace.id, hostId: workspace.hostId, path: workspace.path }] }
      if (method === 'file.read') return parseFileReadResult(await owner.read(params), params)
      return { catalog: parsed({ ...catalog, survey }) }
    })
    const view = await mount(forward)
    expect(read).not.toHaveBeenCalled()
    expect(view.element.querySelector('nav')?.textContent).toContain(state.surveyExplorationNames.research)
    expect(view.element.querySelector('nav')?.textContent).toContain('研究工作面暂未确认')
    await view.click('原名中文'); await view.click('original.note.json')
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith(workspace, 'original.note.json', undefined)
    expect(view.element.querySelector('h2[data-block-id="heading"]')?.textContent).toBe('原标题')
    expect(view.element.querySelector('.mobile-note-body strong')?.textContent).toBe('加粗原正文')
    expect(view.element.querySelector('.mobile-note-body pre code')?.textContent).toBe('const original = true')
    expect(view.element.querySelector('.mobile-note-body ul li')?.textContent).toBe('原列表项')
    expect(view.element.querySelector('.mobile-note-reference .mobile-note-body strong')?.textContent).toBe('加粗原正文')
  })
  it('reads only visible original Regions and isolates late reads after selection changes', async () => {
    const element = document.createElement('div'); document.body.append(element)
    const root = createRoot(element); mounted.push({ root, element })
    let resolveOld!: (value: unknown) => void
    const old = new Promise(resolve => { resolveOld = resolve })
    const forwardRpc = vi.fn().mockImplementation(async (method: string, params: any) => method === 'app.snapshot' ? { workspaces: [{ workspaceId: 'resource', hostId: 'local', path: fixturePath("original") }] } : params.path === 'old.txt' ? old : { resource: { hostId: 'local', workspaceId: 'resource', workspacePath: fixturePath("original"), zoneId: 'research', zonePath: fixturePath("original"), path: 'new.txt' }, result: { status: 'read', document: { path: 'new.txt', content: '新Region原正文', revision: 'new-revision' } } })
    const render = async (path: string, visible: boolean) => act(async () => root.render(<MobileRegionContent client={{ forwardRpc } as any} tabId="tab" regionId={path} zoneId="research" kind="file" file={{ workspaceId: 'resource', path, zoneRelativePath: path }} visible={visible} />))
    await render('old.txt', false); expect(forwardRpc).not.toHaveBeenCalled()
    await render('old.txt', true); expect(forwardRpc).toHaveBeenCalledWith('file.read', expect.objectContaining({ path: 'old.txt' }))
    await render('new.txt', true); expect(element.textContent).toContain('新Region原正文')
    await act(async () => resolveOld({ result: { status: 'read', document: { path: 'old.txt', content: '迟到旧正文', revision: 'old-revision' } } }))
    expect(element.textContent).not.toContain('迟到旧正文'); expect(element.textContent).toContain('新Region原正文')
  })
  it('does not infer a list when presentation is unavailable', async () => {
    const { survey: omitted, ...withoutSurvey } = catalog
    const view = await mount(vi.fn().mockResolvedValue({ catalog: parsed(withoutSurvey) }))
    expect(view.element.querySelector('nav')).toBeNull()
    expect(view.element.textContent).toContain('原研究列表尚未确认')
  })
})

import { mkdtemp, realpath, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { WorkspaceFiles } from '../../desktop/src/main/workspace-files'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { MobileNoteFile } from '../src/navigation/MobileNoteFile'
import { newNoteDocument, readNoteDocument } from '@agentmux/client-ui/note/note-document'
const fileCleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of fileCleanups.splice(0).reverse()) await cleanup() })
async function realNoteView(extra = false, crossScope = false, registeredSameScope = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'amx-note-mobile-')))
  fileCleanups.push(() => rm(directory, { recursive: true, force: true }))
  const workspace = { id: 'note-workspace', hostId: 'local', path: directory, name: 'Original', kind: 'folder' as const }
  const original = newNoteDocument('原始正文', 'note-original', 'block-original')
  if (extra) original.content.content!.push({ type: 'blockReference', attrs: { blockId: 'block-reference', referenceId: 'reference-original', mode: 'embed', target: { noteId: 'note-target', blockId: 'block-target' } } })
  await writeFile(join(directory, 'original.note.json'), JSON.stringify(original))
  await writeFile(join(directory, 'target.note.json'), JSON.stringify(newNoteDocument('跨文件引用正文😀', 'note-target', 'block-target')))
  await writeFile(join(directory, 'unrelated.note.json'), JSON.stringify(newNoteDocument('无关正文不得批量读取', 'note-unrelated', 'block-unrelated')))
  const otherDirectory = join(directory, 'other-workspace')
  await mkdir(otherDirectory)
  await writeFile(join(otherDirectory, 'target.note.json'), JSON.stringify(newNoteDocument('准确跨 Workspace 原块', 'note-target', 'block-target')))
  const other = { ...workspace, id: 'other-note-workspace', path: otherDirectory }
  const workspaces = crossScope ? [workspace, other] : [workspace]
  let receiptFailure = false
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never, { localWriteFault: () => receiptFailure ? 'receipt' : undefined })
  fileCleanups.push(async () => files.dispose())
  let mappedDirectory = directory
  const fileRead = vi.spyOn(files, 'read'), fileWrite = vi.spyOn(files, 'write')
  const owner = new FileReadOwner({ files, workspace: id => workspaces.find(value => value.id === id), catalog: async () => ({ spaces: [], zones: workspaces.map(value => ({ zoneId: value.id === workspace.id ? 'note-zone' : 'cross-zone', workspaceId: value.id, hostId: value.hostId, kind: 'home', directoryPath: value.id === workspace.id ? mappedDirectory : value.path, branch: null })), tabs: [], regions: [], locations: [], bindings: [] }) })
  const service = new AgentMuxRpcService({ files: owner, coreClients: () => [] })
  const params = { zoneId: 'note-zone', path: 'original.note.json', expectedResource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: directory }, maxBytes: 1024 * 1024 }
  const rpc = vi.fn().mockImplementation(async (method: string, input: any) => method === 'notebook.inspect' ? { pages: crossScope ? [{ noteId: 'note-target', resource: { hostId: 'local', workspaceId: other.id, workspacePath: other.path, path: 'target.note.json' }, workface: { zoneId: 'cross-zone', workspaceId: other.id } }] : registeredSameScope ? [{ noteId: 'note-target', resource: { hostId: 'local', workspaceId: workspace.id, workspacePath: directory, path: 'target.note.json' } }] : [] } : service.call(method as any, input))
  const originalRead = await service.call('file.read', params)
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounted.push({ root, element })
  const render = async () => act(async () => root.render(<MobileNoteFile rpc={rpc as any} params={params} read={originalRead} />))
  await render()
  const click = async (text: string) => { const button = [...element.querySelectorAll('button')].find(value => value.textContent === text); expect(button, text).toBeDefined(); await act(async () => { button!.click(); await new Promise(resolve => setTimeout(resolve, 80)) }) }
  const edit = async (text: string) => {
    const node = element.querySelector<HTMLElement>('[contenteditable="true"]') as HTMLElement & { editor: { commands: { insertContent(content: string): void } } }
    expect(node).not.toBeNull(); expect(node.editor).toBeDefined()
    await act(async () => node.editor.commands.insertContent(text))
  }
  const remount = async () => {
    await act(async () => root.render(null))
    await render()
  }
  return { element, root, directory, other, original, originalRead, params, files, fileRead, fileWrite, rpc, click, edit, render, remount, remap: (path: string) => { mappedDirectory = path }, failReceipt: () => { receiptFailure = true } }
}
describe('T-006 existing Note editing and original cross-file references', () => {
  it('edits through the shared schema and saves the exact existing Note via file.write without reallocating identity', async () => {
    localStorage.clear()
    const view = await realNoteView()
    await view.click('编辑原笔记'); await view.edit('手机新增文字😀')
    await view.click('保存原笔记')
    await vi.waitFor(async () => { await act(async () => new Promise(resolve => setTimeout(resolve, 20))); expect(view.element.textContent).toContain('原文件保存已确认') })
    const saved = readNoteDocument(await readFile(join(view.directory, 'original.note.json'), 'utf8'))
    expect(saved.status).toBe('valid')
    if (saved.status !== 'valid') throw new Error('Saved original Note must validate')
    expect(saved.note.noteId).toBe('note-original')
    expect(saved.note.content.content![0]!.attrs!.blockId).toBe('block-original')
    expect(JSON.stringify(saved.note.content)).toContain('手机新增文字😀')
    expect(view.fileWrite).toHaveBeenCalledTimes(1)
    await view.edit('<p>新增第二个块</p>'); await view.click('保存原笔记')
    const expanded = readNoteDocument(await readFile(join(view.directory, 'original.note.json'), 'utf8'))
    expect(expanded.status).toBe('valid')
    if (expanded.status !== 'valid') throw new Error('New semantic blocks must keep the original schema')
    const blockIds = expanded.note.content.content!.map(node => node.attrs?.blockId)
    expect(blockIds).toContain('block-original'); expect(blockIds.length).toBeGreaterThan(1); expect(new Set(blockIds).size).toBe(blockIds.length)
    expect(view.rpc).toHaveBeenCalledWith('file.write', expect.objectContaining({ zoneId: 'note-zone', path: 'original.note.json', expectedRevision: view.originalRead.result.status === 'read' ? view.originalRead.result.document.revision : '' }))
    expect(view.params.maxBytes).toBe(1024 * 1024)
    for (const [method, input] of view.rpc.mock.calls) if (method === 'file.write') expect(input).not.toHaveProperty('maxBytes')
  })
  it('preserves a conflict draft and never resends an unknown write; read reconciliation confirms actual saved bytes', async () => {
    localStorage.clear()
    const view = await realNoteView()
    await view.click('编辑原笔记'); await view.edit('保留草稿')
    await writeFile(join(view.directory, 'original.note.json'), JSON.stringify(newNoteDocument('别人已经更新', 'note-original', 'block-original')))
    await view.click('保存原笔记')
    expect(view.element.textContent).toContain('原文件已改变')
    expect(view.element.querySelector('[contenteditable="true"]')?.textContent).toContain('保留草稿')
    await view.click('核对当前原文'); await view.click('以当前修订继续保存本草稿')
    view.failReceipt()
    await view.click('保存原笔记')
    expect(view.element.textContent).toContain('保存回执未知')
    const writes = view.fileWrite.mock.calls.length
    await view.remount()
    expect(view.element.querySelector('[contenteditable="true"]')?.textContent).toContain('保留草稿')
    expect(view.element.textContent).toContain('原保存回执未确认')
    await view.click('保存原笔记'); expect(view.fileWrite).toHaveBeenCalledTimes(writes)
    await view.click('核对当前原文')
    expect(view.element.textContent).toContain('当前原文件已确认包含本次保存内容')
    expect(view.fileWrite).toHaveBeenCalledTimes(writes)
  })
  it('reads only the explicitly selected standalone reference from original Scope filenames, retaining wrong-file identity refusal', async () => {
    localStorage.clear()
    const view = await realNoteView(true)
    expect(view.fileRead).toHaveBeenCalledTimes(1)
    await view.click('读取引用原文')
    expect(view.rpc).toHaveBeenCalledWith('notebook.inspect', { noteId: 'note-target' })
    expect(view.rpc).toHaveBeenCalledWith('file.list', { zoneId: view.params.zoneId, expectedResource: view.params.expectedResource, path: '.' })
    expect(view.fileRead).toHaveBeenCalledTimes(1)
    await vi.waitFor(async () => { await act(async () => new Promise(resolve => setTimeout(resolve, 20))); expect([...view.element.querySelectorAll('button')].some(button => button.textContent === 'original.note.json')).toBe(true) })
    await view.click('original.note.json')
    expect(view.element.textContent).toContain('所选原文件不是此引用的 Note')
    await view.click('target.note.json')
    expect(view.element.querySelector('.mobile-note-reference .mobile-note-body')?.textContent).toBe('跨文件引用正文😀')
    expect(view.fileRead.mock.calls.map(call => call[1])).toEqual(['original.note.json', 'original.note.json', 'target.note.json'])
    expect(view.rpc).toHaveBeenCalledWith('file.read', { ...view.params, path: 'target.note.json' })
  })
  it('maps an exact registered same Scope reference through strict file.list while retaining the original read byte cap', async () => {
    localStorage.clear()
    const view = await realNoteView(true, false, true)
    await view.click('读取引用原文')
    await vi.waitFor(() => expect(view.element.querySelector('.mobile-note-reference .mobile-note-body')?.textContent).toBe('跨文件引用正文😀'))
    expect(view.rpc).toHaveBeenCalledWith('file.list', { zoneId: view.params.zoneId, expectedResource: view.params.expectedResource, path: '.' })
    expect(view.rpc).toHaveBeenCalledWith('file.read', { ...view.params, path: 'target.note.json' })
    expect(view.fileRead.mock.calls.map(call => call[1])).toEqual(['original.note.json', 'target.note.json'])
  })
})


describe('Note save uncertainty and durable device intent', () => {
  it('does not clear an unsettled write from a matching read or send a second write', async () => {
    localStorage.clear()
    const view = await realNoteView()
    const invoke = view.rpc.getMockImplementation()!
    let settle!: (value: unknown) => void
    view.rpc.mockImplementation(async (method: string, params: unknown) => {
      const result = await invoke(method, params)
      return method === 'file.write' ? await new Promise(resolve => { settle = () => resolve(result) }) : result
    })
    await view.click('编辑原笔记'); await view.edit('等待第一次保存')
    await view.click('保存原笔记'); await view.click('核对当前原文')
    expect(view.element.textContent).toContain('原保存请求仍在等待回执')
    const save = [...view.element.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === '保存原笔记')!
    expect(save.disabled).toBe(true)
    await view.click('保存原笔记'); expect(view.fileWrite).toHaveBeenCalledTimes(1)
    await act(async () => settle(undefined))
    expect(view.element.textContent).toContain('原文件保存已确认'); expect(save.disabled).toBe(false)
  })
  it.each([[false, 'none'], [true, 'none'], [true, 'setItem'], [true, 'getItem']])('shares a pending write and preserves the newer draft after ACK (unmount=%s, device fault=%s)', async (unmountFirst, deviceFault) => {
    localStorage.clear()
    const view = await realNoteView(), invoke = view.rpc.getMockImplementation()!
    let finish!: (value: any) => void, saved: any
    view.rpc.mockImplementation(async (method: string, params: unknown) => {
      const result = await invoke(method, params)
      if (method !== 'file.write') return result
      saved = result
      return new Promise(resolve => { finish = resolve })
    })
    await view.click('编辑原笔记'); await view.edit('第一工作面提交')
    await act(async () => { [...view.element.querySelectorAll('button')].find(button => button.textContent === '保存原笔记')!.click() })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    view.element.hidden = true
    if (unmountFirst) await act(async () => view.root.render(null))
    const element = document.createElement('div'); document.body.append(element)
    const root = createRoot(element); mounted.push({ element, root })
    const render = () => root.render(<MobileNoteFile rpc={view.rpc as any} params={view.params} read={view.originalRead} />)
    await act(async () => render())
    const click = async (text: string) => act(async () => { [...element.querySelectorAll('button')].find(button => button.textContent === text)!.click(); await new Promise(resolve => setTimeout(resolve, 80)) })
    await click('核对当前原文')
    expect(element.textContent).toContain('原保存请求仍在等待回执')
    expect([...element.querySelectorAll('button')].find(button => button.textContent === '保存原笔记')!.disabled).toBe(true)
    const node = element.querySelector<HTMLElement>('[contenteditable=true]') as any
    await act(async () => node.editor.commands.insertContent('第二工作面较新编辑'))
    const fault = deviceFault !== 'none' ? vi.spyOn(localStorage, deviceFault as 'getItem' | 'setItem').mockImplementation(() => { throw new Error('ACK durable storage failed') }) : null
    await act(async () => finish(saved))
    fault?.mockRestore()
    if (deviceFault !== 'none') { expect([...element.querySelectorAll('button')].find(button => button.textContent === '保存原笔记')!.disabled).toBe(true); await click('核对当前原文') }
    expect(element.querySelector('[contenteditable=true]')?.textContent).toContain('第二工作面较新编辑')
    expect([...element.querySelectorAll('button')].find(button => button.textContent === '保存原笔记')!.disabled).toBe(false)
    await act(async () => root.render(null)); await act(async () => render())
    expect(element.querySelector('[contenteditable=true]')?.textContent).toContain('第二工作面较新编辑')
    view.rpc.mockImplementation(invoke); await click('保存原笔记')
    expect(view.fileWrite).toHaveBeenCalledTimes(2)
    await vi.waitFor(async () => { await act(async () => new Promise(resolve => setTimeout(resolve, 20))); expect(await readFile(join(view.directory, 'original.note.json'), 'utf8')).toContain('第二工作面较新编辑') })
  })
  it('keeps a reader’s unretained local edit when another reader publishes after storage recovers', async () => {
    localStorage.clear()
    const view = await realNoteView(); await view.click('编辑原笔记')
    const element = document.createElement('div'); document.body.append(element)
    const root = createRoot(element); mounted.push({ element, root })
    await act(async () => root.render(<MobileNoteFile rpc={view.rpc as any} params={view.params} read={view.originalRead} />))
    const node = element.querySelector('[contenteditable=true]') as any
    const fault = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('unretained local edit') })
    await act(async () => node.editor.commands.insertContent('B未持久原编辑'))
    fault.mockRestore()
    await view.edit('A较新原编辑')
    expect(element.querySelector('[contenteditable=true]')?.textContent).toContain('B未持久原编辑')
    const key = Object.keys(localStorage).find(key => key.startsWith('agentmux-mobile-note-draft:'))!
    const retained = JSON.parse(localStorage.getItem(key)!)
    expect(retained.draft).toContain('B未持久原编辑')
    expect(JSON.stringify(retained.alternates)).toContain('A较新原编辑')
  })
  it('preserves an externally newer device draft and explicitly retains both before continuing', async () => {
    localStorage.clear()
    const view = await realNoteView()
    await view.click('编辑原笔记'); await view.edit('当前未丢编辑')
    const key = Object.keys(localStorage).find(key => key.startsWith('agentmux-mobile-note-draft:'))!
    const latest = { ...JSON.parse(localStorage.getItem(key)!), draft: JSON.stringify(newNoteDocument('另一个页面的新草稿', 'note-original', 'block-original')) }
    localStorage.setItem(key, JSON.stringify(latest))
    await view.click('保存原笔记')
    expect(view.fileWrite).not.toHaveBeenCalled()
    expect(view.element.textContent).toContain('另一工作面已保存较新的本机草稿')
    expect(localStorage.getItem(key)).toContain('另一个页面的新草稿')
    await view.click('核对本机笔记草稿'); await view.click('保留当前编辑，采用本机草稿')
    expect(view.element.querySelector('[contenteditable=true]')?.textContent).toContain('另一个页面的新草稿')
    expect(view.element.textContent).toContain('当前未丢编辑')
    await view.click('保存原笔记'); expect(view.fileWrite).toHaveBeenCalledTimes(1)
    await view.remount(); expect(view.element.textContent).toContain('当前未丢编辑')
  })
  it('retains a mismatching unknown write and offers explicit revision recovery without replaying it', async () => {
    localStorage.clear()
    const view = await realNoteView(), invoke = view.rpc.getMockImplementation()!
    view.rpc.mockImplementation(async (method: string, params: unknown) => method === 'file.write' ? { resource: null, result: { status: 'unknown', code: 'LOST', message: 'reply unavailable' } } : invoke(method, params))
    await view.click('编辑原笔记'); await view.edit('不丢手机草稿'); await view.click('保存原笔记')
    await view.click('核对当前原文')
    await view.click('保留未知保存记录，以当前修订继续编辑')
    expect(view.fileWrite).not.toHaveBeenCalled()
    expect(view.element.textContent).toContain('原未知保存记录')
    await view.remount(); expect(view.element.textContent).toContain('原未知保存记录')
    expect(view.element.querySelector('[contenteditable=true]')?.textContent).toContain('不丢手机草稿')
    view.rpc.mockImplementation(invoke)
    await view.click('保存原笔记')
    expect(view.fileWrite).toHaveBeenCalledTimes(1); expect(view.element.textContent).toContain('原未知保存记录')
  })
  it('keeps editing during local storage failure and never sends an unretained save intent', async () => {
    localStorage.clear()
    const view = await realNoteView()
    await view.click('编辑原笔记')
    const fault = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('device storage unavailable') })
    await view.edit('存储故障中仍可编辑'); await view.click('保存原笔记')
    expect(view.element.querySelector('[contenteditable=true]')?.textContent).toContain('存储故障中仍可编辑')
    expect(view.fileWrite).not.toHaveBeenCalled(); expect(view.rpc.mock.calls.some(call => call[0] === 'file.write')).toBe(false)
    expect(view.element.textContent).toContain('本机草稿与保存意图未持久保存')
    fault.mockRestore(); await view.click('保存原笔记'); expect(view.fileWrite).toHaveBeenCalledTimes(1)
  })
  it('reads one exact registered cross Workspace reference through its original Zone and File owner', async () => {
    localStorage.clear()
    const view = await realNoteView(true, true)
    await view.click('读取引用原文')
    await vi.waitFor(async () => { await act(async () => new Promise(resolve => setTimeout(resolve, 20))); expect(view.rpc).toHaveBeenCalledWith('file.read', { zoneId: 'cross-zone', path: 'target.note.json', expectedResource: { hostId: 'local', workspaceId: view.other.id, workspacePath: view.other.path } }) })
    await vi.waitFor(async () => { await act(async () => new Promise(resolve => setTimeout(resolve, 20))); expect(view.element.textContent).toContain('准确跨 Workspace 原块') })
    expect(view.element.querySelector('.mobile-note-reference .mobile-note-body')?.textContent).toBe('准确跨 Workspace 原块')
    expect(view.fileRead.mock.calls.map(call => [call[0].id, call[1]])).toEqual([['note-workspace', 'original.note.json'], ['other-note-workspace', 'target.note.json']])
  })
})

it('keeps an unknown save when a remapped Zone reads an identical Note in another directory', async () => {
  localStorage.clear()
  const view = await realNoteView()
  await view.click('编辑原笔记'); await view.edit('准确原保存')
  view.failReceipt(); await view.click('保存原笔记')
  await vi.waitFor(() => expect(view.element.textContent).toContain('保存回执未知'))
  await mkdir(join(view.directory, 'other')); await writeFile(join(view.directory, 'other/original.note.json'), await readFile(join(view.directory, 'original.note.json')))
  view.remap(join(view.directory, 'other')); await view.click('核对当前原文')
  await vi.waitFor(() => expect(view.element.textContent).toContain('原文件映射已改变'))
  expect([...view.element.querySelectorAll('button')].find(value => value.textContent === '保存原笔记')!.disabled).toBe(true)
  expect(JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key => key.startsWith('agentmux-mobile-note-draft:'))!)!).attempt.phase).toBe('unknown')
})
it('reports an exact pre-write mapping refusal as failed while preserving editing and never claiming possible file delivery', async () => {
  localStorage.clear()
  const view = await realNoteView(); await view.click('编辑原笔记'); await view.edit('仍保原草稿')
  await mkdir(join(view.directory, 'other')); await writeFile(join(view.directory, 'other/original.note.json'), JSON.stringify(view.original))
  view.remap(join(view.directory, 'other')); await view.click('保存原笔记')
  await vi.waitFor(() => expect(view.element.textContent).toContain('保存失败'))
  expect(view.fileWrite).not.toHaveBeenCalled()
  expect([...view.element.querySelectorAll('button')].find(value => value.textContent === '保存原笔记')!.disabled).toBe(false)
  expect(view.element.querySelector('[contenteditable=true]')?.textContent).toContain('仍保原草稿')
  expect(view.element.textContent).not.toContain('保存回执未知')
})

it('preserves the previous Note identity’s draft and unknown save when the same file becomes another Note', async () => {
  localStorage.clear()
  const view = await realNoteView(); await view.click('编辑原笔记'); await view.edit('Note A原草稿')
  view.failReceipt(); await view.click('保存原笔记')
  await vi.waitFor(() => expect(view.element.textContent).toContain('保存回执未知'))
  const keyA = Object.keys(localStorage).find(key => key.startsWith('agentmux-mobile-note-draft:'))!, savedA = localStorage.getItem(keyA)
  await writeFile(join(view.directory, 'original.note.json'), JSON.stringify(newNoteDocument('Note B原正文', 'note-B', 'block-B')))
  const replaced = await view.rpc('file.read', view.params)
  await act(async () => view.root.render(<MobileNoteFile rpc={view.rpc as any} params={view.params} read={replaced} />))
  await view.click('编辑原笔记'); await view.edit('Note B的新草稿')
  expect(localStorage.getItem(keyA)).toBe(savedA)
  expect(Object.keys(localStorage).filter(key => key.startsWith('agentmux-mobile-note-draft:'))).toHaveLength(2)
  await act(async () => view.root.render(<MobileNoteFile rpc={view.rpc as any} params={view.params} read={view.originalRead} />))
  expect(view.element.querySelector('[contenteditable=true]')?.textContent).toContain('Note A原草稿')
  expect(view.element.textContent).toContain('原保存回执未确认')
})

it.each([false, true])('preserves the original mapped file’s unknown save across a new reader of an identical Note in another Zone directory (cold=%s)', async cold => {
  localStorage.clear()
  const view = await realNoteView(); await view.click('编辑原笔记'); await view.edit('原目录A保存草稿')
  view.failReceipt(); await view.click('保存原笔记')
  await vi.waitFor(() => expect(view.element.textContent).toContain('保存回执未知'))
  const keyA = Object.keys(localStorage).find(key => key.startsWith('agentmux-mobile-note-draft:'))!, savedA = localStorage.getItem(keyA)
  await mkdir(join(view.directory, 'other')); await writeFile(join(view.directory, 'other/original.note.json'), await readFile(join(view.directory, 'original.note.json')))
  view.remap(join(view.directory, 'other'))
  const readB = await view.rpc('file.read', view.params)
  if (cold) await act(async () => view.root.render(null))
  await act(async () => view.root.render(<MobileNoteFile rpc={view.rpc as any} params={view.params} read={readB} />))
  expect(view.element.textContent).not.toContain('原保存回执未确认')
  await view.click('编辑原笔记'); await view.edit('目录B另一草稿')
  await view.click('核对当前原文')
  expect(localStorage.getItem(keyA)).toBe(savedA)
  expect(Object.keys(localStorage).filter(key => key.startsWith('agentmux-mobile-note-draft:'))).toHaveLength(2)
  await act(async () => view.root.render(<MobileNoteFile rpc={view.rpc as any} params={view.params} read={view.originalRead} />))
  expect(view.element.querySelector('[contenteditable=true]')?.textContent).toContain('原目录A保存草稿')
  expect(view.element.textContent).toContain('原保存回执未确认')
})
