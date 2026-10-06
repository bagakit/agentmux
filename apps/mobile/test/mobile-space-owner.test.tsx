import { tmpdir } from 'node:os'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MobileSpatialNavigation, type MobileSpatialContext, type MobileSpatialNavigationProps } from '../src/navigation/MobileSpatialNavigation'
import { FileReadOwner } from '../../desktop/src/main/file-read-owner'
import { WorkspaceFiles } from '../../desktop/src/main/workspace-files'
import { spatialCatalog } from '../../desktop/src/renderer/src/lib/space-agent-control'
import { createWorkbenchTab, addWorkbenchRegion } from '../../desktop/src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '../../../packages/layout/src/index'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { parseSpaceControlSuccessReceipt } from '../../../packages/core/src/space-control-parser'
import { parseBrowserTargetsResult } from '../../../packages/core/src/control-browser-targets'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { newNoteDocument, readNoteDocument } from '@agentmux/client-ui/note/note-document'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const mounted: { root: Root; element: HTMLElement }[] = [], resources: { files: WorkspaceFiles; path: string }[] = []
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  for (const owner of resources.splice(0)) { await owner.files.dispose(); await rm(owner.path, { recursive: true, force: true }) }
  localStorage.clear()
})
async function fixture(initialContext?: MobileSpatialContext | 'RESTORE_EXACT') {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'amux-space-owner-')))
  await mkdir(join(path, 'docs'))
  await writeFile(join(path, 'docs/first.md'), '# 首个无关文件\n\n不能替代原选择。')
  await writeFile(join(path, 'docs/original.md'), '# 准确原 Markdown\n\n原文件的完整正文。')
  await writeFile(join(path, 'docs/original.note.json'), JSON.stringify(newNoteDocument('准确原 Note 正文', 'note-original-owner', 'block-original-owner')))
  const workspace = { id: 'workspace-original-owner', hostId: 'local', name: '原资料', path, kind: 'folder' as const }
  const tabId = 'tab-original-owner'
  let tab = createWorkbenchTab(tabId, { kind: 'file', regionId: 'first-region', workspaceId: workspace.id, path: 'docs/first.md' }, '准确原工作面')
  tab = addWorkbenchRegion(tab, 'first-region', 'right', { kind: 'file', regionId: 'original-region', workspaceId: workspace.id, path: 'docs/original.md' })
  tab = addWorkbenchRegion(tab, 'first-region', 'down', { kind: 'file', regionId: 'note-region', workspaceId: workspace.id, path: 'docs/original.note.json' })
  tab = addWorkbenchRegion(tab, 'first-region', 'up', { kind: 'browser', regionId: 'browser-region', workspaceId: workspace.id, browserId: 'browser-original-owner', url: 'http://original.example/read', title: '准确原网页', status: 'ready' } as any)
  const state = { config: { workspaces: [workspace], executors: {}, hosts: [{ id: 'local', kind: 'local' }] }, sessions: [], tabs: { [tabId]: tab },
    layouts: { 'display-first': createWorkspaceLayout('group-first', [tabId]), 'display-exact-second': createWorkspaceLayout('group-original', [tabId]) },
    spaceZoneBindings: {}, spatialRequests: {} } as any
  let original: AgentMuxSpaceCatalog = spatialCatalog(state, [])
  const spaceId = original.spaces[0]!.spaceId, zone = original.zones[0]!
  let failReceipt = false, directoryFailure = false, empty = false, browserFailure = false
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never, { localWriteFault: () => failReceipt ? 'receipt' : undefined })
  resources.push({ files, path })
  const fileRead = vi.spyOn(files, 'read'), fileWrite = vi.spyOn(files, 'write')
  const owner = new FileReadOwner({ files, workspace: id => id === workspace.id ? workspace : undefined, catalog: async () => original })
  const service = new AgentMuxRpcService({ files: owner, coreClients: () => [] })
  const rpc = vi.fn().mockImplementation(async (method: string, params: any) => {
    if (method === 'space.ls') {
      if (directoryFailure) throw new Error('原目录观察暂缺')
      const catalog = empty ? { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] } : original
      const receipt = parseSpaceControlSuccessReceipt({ schemaVersion: 5, requestId: 'actual-space-owner-read', operation: 'space.ls', ok: true, result: { catalog } })
      return receipt.result
    }
    if (method === 'app.snapshot') return { workspaces: [{ workspaceId: workspace.id, hostId: workspace.hostId, name: workspace.name, path, kind: workspace.kind, projectId: null, repoPath: null, branch: null }], unavailable: [] }
    if (method === 'browser.targets') {
      if (browserFailure) throw new Error('原 Browser 观察暂缺')
      return parseBrowserTargetsResult({ targets: [
        { id: 'wrong-first-browser', title: '干扰网页', url: 'https://wrong.example', status: 'ready', source: 'embedded', workspaceId: workspace.id, navigationId: 'navigation-wrong', capabilities: [] },
        { id: 'browser-original-owner', title: '准确原网页', url: 'http://original.example/read', status: 'ready', source: 'embedded', workspaceId: workspace.id, navigationId: 'navigation-original', capabilities: [] }
      ] })
    }
    return service.call(method as any, params)
  })
  const client = { forwardRpc: rpc } as any, back = vi.fn(), changed = vi.fn(), openSession = vi.fn()
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounted.push({ root, element })
  const props: MobileSpatialNavigationProps = { home: 'space', sessions: [], client, connected: true, openSession, onBackChange: back, onContextChange: changed, ...(initialContext ? { initialContext: initialContext === 'RESTORE_EXACT' ? { spaceId, tabId, regionId: 'original-region' } : initialContext } : {}) }
  const render = async (change: Partial<MobileSpatialNavigationProps> = {}) => act(async () => root.render(<MobileSpatialNavigation {...props} {...change} />))
  await render()
  const click = async (text: string) => {
    const found = [...element.querySelectorAll<HTMLButtonElement>('button')].find(button => !button.closest('[hidden]') && (button.textContent?.includes(text) || button.getAttribute('aria-label')?.includes(text)))
    expect(found, text).toBeDefined(); await act(async () => { found!.click(); await new Promise(resolve => setTimeout(resolve, 30)); if (rpc.mock.calls.at(-1)?.[0] === 'file.read') await rpc.mock.results.at(-1)!.value })
  }
  const stepBack = async () => { const callback = back.mock.calls.at(-1)?.[0]; expect(callback).toBeTypeOf('function'); await act(async () => callback()) }
  const editor = () => element.querySelector<HTMLElement>('[contenteditable=true]') as HTMLElement & { editor: { commands: { insertContent(value: string): void } } }
  return { path, workspace, zone, spaceId, tabId, element, rpc, fileRead, fileWrite, click, stepBack, render, back, changed, editor,
    edit: async (text: string) => { expect(editor()?.editor).toBeDefined(); await act(async () => editor().editor.commands.insertContent(text)) },
    failReceipt: () => { failReceipt = true }, failDirectory: () => { directoryFailure = true }, empty: () => { empty = true }, failBrowser: () => { browserFailure = true },
    remap: (directoryPath: string) => { original = { ...original, zones: [{ ...zone, directoryPath }] } }
  }
}

describe('T-007 original Space selected content frame', () => {
  it('reads only the explicit second Region through original Files and codec, retaining it across back, empty and failed catalog reads', async () => {
    const view = await fixture()
    expect(view.fileRead).not.toHaveBeenCalled()
    await view.click('原资料'); expect(view.fileRead).not.toHaveBeenCalled()
    await view.click('original.md')
    expect(view.fileRead.mock.calls.map(call => call[1])).toEqual(['docs/original.md'])
    expect(view.element.querySelector('.mobile-region-content h1')?.textContent).toBe('准确原 Markdown')
    expect(view.changed).toHaveBeenLastCalledWith({ spaceId: view.spaceId, tabId: view.tabId, regionId: 'original-region' })
    const reads = view.fileRead.mock.calls.length
    await view.stepBack(); expect(view.element.querySelector('.mobile-spatial-tab')).not.toBeNull()
    await view.click('original.md'); expect(view.fileRead).toHaveBeenCalledTimes(reads)
    view.empty(); await view.click('刷新空间目录')
    expect(view.element.textContent).toContain('当前绑定尚未重新确认')
    expect(view.element.querySelector('.mobile-region-content h1')?.textContent).toBe('准确原 Markdown')
    view.failDirectory(); await view.click('刷新空间目录')
    expect(view.element.textContent).toContain('原目录观察暂缺')
    expect(view.fileRead).toHaveBeenCalledTimes(reads)
  })
  it('keeps the exact mounted Note editor and unknown save across Region back and a different Browser, without retrying or selecting the first file', async () => {
    const view = await fixture()
    await view.click('原资料'); await view.click('original.note.json'); await view.click('编辑原笔记')
    await view.edit('本机未确认保存的原补充')
    const originalEditor = view.editor(), registrations = view.back.mock.calls.length
    await view.edit('后来编辑不重注册Back'); expect(view.back.mock.calls).toHaveLength(registrations)
    view.failReceipt(); await view.click('保存原笔记')
    await vi.waitFor(() => expect(view.element.textContent).toContain('保存回执未知'))
    const saved = readNoteDocument(await readFile(join(view.path, 'docs/original.note.json'), 'utf8'))
    expect(saved.status).toBe('valid'); expect(JSON.stringify(saved)).toContain('本机未确认保存的原补充')
    expect(JSON.stringify(saved)).toContain('note-original-owner'); expect(JSON.stringify(saved)).toContain('block-original-owner')
    const reads = view.fileRead.mock.calls.length
    await view.stepBack(); await view.click('查看原网页')
    expect(view.element.querySelector('a')?.href).toBe('http://original.example/read')
    expect(view.element.textContent).toContain('不控制 Mac 原 Browser')
    await view.stepBack(); await view.click('original.note.json')
    expect(view.editor()).toBe(originalEditor); expect(view.editor().textContent).toContain('后来编辑不重注册Back')
    expect(view.fileRead).toHaveBeenCalledTimes(reads); expect(view.fileWrite).toHaveBeenCalledTimes(1)
    expect(view.element.textContent).toContain('保存回执未知')
    expect(Object.keys(localStorage).filter(key => key.startsWith('agentmux-mobile-note-draft:'))).toHaveLength(1)
    await view.render({ connected: false })
    expect(view.editor()).toBe(originalEditor); expect(view.editor().textContent).toContain('本机未确认保存')
    expect(view.fileWrite).toHaveBeenCalledTimes(1)
  })
  it('restores only the exact original Region while a later directory lookup cannot choose its active first neighbour', async () => {
    const view = await fixture('RESTORE_EXACT')
    await vi.waitFor(async () => { await act(async () => new Promise(resolve => setTimeout(resolve, 10))); expect(view.element.querySelector('.mobile-region-content h1')?.textContent).toBe('准确原 Markdown') })
    expect(view.fileRead.mock.calls.map(call => call[1])).toEqual(['docs/original.md'])
    expect(view.element.querySelector('.mobile-region-content h1')?.textContent).toBe('准确原 Markdown')
    await view.click('刷新空间目录')
    expect(view.changed).toHaveBeenLastCalledWith({ spaceId: view.spaceId, tabId: view.tabId, regionId: 'original-region' })
    expect(view.fileRead).toHaveBeenCalledTimes(1)
    await view.stepBack(); await view.stepBack()
    expect(view.back).toHaveBeenLastCalledWith(null)
    expect(view.changed).toHaveBeenLastCalledWith({ spaceId: null, tabId: null, regionId: null })
  })
  it('refuses the later mapping of the same Zone, preserving the original file body and exact resource reference', async () => {
    const view = await fixture()
    await view.click('原资料'); await view.click('original.md')
    await mkdir(join(view.path, 'remapped/docs'), { recursive: true }); await writeFile(join(view.path, 'remapped/docs/original.md'), '# 另一个映射的正文')
    view.remap(join(view.path, 'remapped')); await view.click('刷新原文件')
    expect(view.rpc).toHaveBeenLastCalledWith('file.read', { zoneId: view.zone.zoneId, path: 'docs/original.md', expectedResource: { hostId: 'local', workspaceId: view.workspace.id, workspacePath: view.path } })
    await act(async () => { await view.rpc.mock.results.at(-1)!.value })
    expect(view.element.querySelector('.mobile-region-content h1')?.textContent).toBe('准确原 Markdown')
    expect(view.element.textContent).not.toContain('另一个映射的正文')
    expect(view.element.textContent).toContain('原文件资源或 Zone 映射未确认一致')
    expect(view.fileWrite).not.toHaveBeenCalled()
  })
  it('keeps the exact Browser URL after observation failure and does not read hidden visited file bodies', async () => {
    const view = await fixture()
    await view.click('原资料'); await view.click('查看原网页')
    expect(view.fileRead).not.toHaveBeenCalled()
    expect(view.element.querySelector('a')?.getAttribute('target')).toBe('_blank')
    view.failBrowser(); await view.click('刷新原 Browser')
    expect(view.element.textContent).toContain('原 Browser 观察暂缺')
    expect(view.element.querySelector('a')?.href).toBe('http://original.example/read')
    const calls = view.rpc.mock.calls.length
    await view.stepBack(); await view.render({ visible: false })
    expect(view.rpc).toHaveBeenCalledTimes(calls)
  })
  it('never reopens the original selected file when a directory observation arrives after the user returned to the list', async () => {
    const view = await fixture()
    await view.click('原资料'); await view.click('original.md')
    const observed = await view.rpc('space.ls', { target: {}, presentation: true })
    let resolve!: (value: unknown) => void
    view.rpc.mockImplementationOnce(() => new Promise(value => { resolve = value }))
    await view.click('刷新空间目录'); await view.stepBack(); await view.stepBack()
    await act(async () => resolve(observed))
    expect(view.changed).toHaveBeenLastCalledWith({ spaceId: null, tabId: null, regionId: null })
    expect(view.element.querySelector('.mobile-space-directory .mobile-space-tree')).not.toBeNull()
    expect(view.element.querySelector('.mobile-spatial-tab')).toBeNull()
    expect(view.fileRead.mock.calls.map(call => call[1])).toEqual(['docs/original.md'])
  })
  it('retains the original Space frame across Focus and Mote without using its Space reference as a Mote fallback', async () => {
    const view = await fixture('RESTORE_EXACT')
    await vi.waitFor(async () => { await act(async () => new Promise(resolve => setTimeout(resolve, 10))); expect(view.element.querySelector('.mobile-region-content h1')?.textContent).toBe('准确原 Markdown') })
    const originalReader = view.element.querySelector('.mobile-region-content'), reads = view.fileRead.mock.calls.length
    const reference = { spaceId: view.spaceId, tabId: view.tabId, regionId: 'original-region' }
    await view.render({ home: 'focus', initialContext: reference })
    expect(originalReader?.closest('[hidden]')).not.toBeNull()
    await view.render({ home: 'mote', initialContext: reference })
    expect(view.element.querySelector('.mobile-spatial-tab')).toBeNull()
    expect(view.changed).toHaveBeenLastCalledWith(reference)
    await view.render({ home: 'space', initialContext: reference })
    expect(view.element.querySelector('.mobile-region-content')).toBe(originalReader)
    expect(originalReader?.closest('[hidden]')).toBeNull()
    expect(view.fileRead).toHaveBeenCalledTimes(reads)
    await view.stepBack(); expect(view.element.querySelector('.mobile-spatial-tab')).not.toBeNull()
  })
  it('does not apply a late original file read over the later Browser or restart the hidden reader automatically', async () => {
    const view = await fixture()
    const normalRpc = view.rpc.getMockImplementation()!
    let release!: () => void, started!: () => void
    const pending = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    view.rpc.mockImplementation(async (method: string, params: any) => {
      const result = await normalRpc(method, params)
      if (method === 'file.read') { started(); await gate }
      return result
    })
    await view.click('原资料')
    const file = [...view.element.querySelectorAll<HTMLButtonElement>('button')].find(button => !button.closest('[hidden]') && button.textContent?.includes('original.md'))!
    await act(async () => file.click())
    await pending
    await view.stepBack(); await view.click('查看原网页')
    await act(async () => release())
    expect(view.element.querySelector('a')?.href).toBe('http://original.example/read')
    expect(view.element.querySelector('.mobile-region-content h1')).toBeNull()
    expect(view.changed).toHaveBeenLastCalledWith({ spaceId: view.spaceId, tabId: view.tabId, regionId: 'browser-region' })
    const reads = view.fileRead.mock.calls.length
    await view.stepBack(); await view.click('original.md')
    expect(view.fileRead).toHaveBeenCalledTimes(reads)
    expect(view.element.querySelector('.mobile-region-content h1')).toBeNull()
    expect(view.element.textContent).toContain('原内容尚未确认')
  })

})
