import { tmpdir } from 'node:os'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MobileSurveySurface, type MobileSurveyContext, type MobileSurveyProps } from '../src/survey/MobileSurveySurface'
import { FileReadOwner } from '../../desktop/src/main/file-read-owner'
import { WorkspaceFiles } from '../../desktop/src/main/workspace-files'
import { readSurveyPresentation } from '../../desktop/src/renderer/src/lib/mobile-presentation'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { parseSpaceControlSuccessReceipt } from '../../../packages/core/src/space-control-parser'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { newNoteDocument, readNoteDocument } from '@agentmux/client-ui/note/note-document'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const mounted: { root: Root; element: HTMLElement }[] = [], resources: { files: WorkspaceFiles; path: string }[] = []
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  for (const owner of resources.splice(0)) { await owner.files.dispose(); await rm(owner.path, { recursive: true, force: true }) }
  localStorage.clear()
})
async function fixture(initialContext?: MobileSurveyContext) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'amux-survey-owner-')))
  await mkdir(join(path, 'docs'))
  await writeFile(join(path, 'docs/first.md'), '# 首个无关文件\n\n不能替代原选择。')
  await writeFile(join(path, 'docs/original.md'), '# 准确原 Markdown\n\n原文件的完整正文。')
  await writeFile(join(path, 'docs/original.note.json'), JSON.stringify(newNoteDocument('准确原 Note 正文', 'note-original-owner', 'block-original-owner')))
  const workspace = { id: 'workspace-original-owner', hostId: 'local', name: '原资料', path, kind: 'folder' as const }
  const zone = { zoneId: 'zone-original-owner', workspaceId: workspace.id, kind: 'directory' as const, hostId: workspace.hostId, directoryPath: join(path, 'docs'), branch: null }
  const tabId = 'tab-original-owner'
  let original: AgentMuxSpaceCatalog = { spaces: [], zones: [zone], tabs: [{ tabId, zoneId: zone.zoneId, workspaceId: workspace.id, name: '准确原工作面', regionIds: ['first-region', 'original-region', 'note-region', 'browser-region'] }],
    regions: ['first', 'original', 'note'].map((name, index) => ({ regionId: ['first-region', 'original-region', 'note-region'][index]!, tabId, kind: 'file', agentSessionId: null, runId: null, execution: null,
      file: { workspaceId: workspace.id, path: name === 'note' ? 'docs/original.note.json' : `docs/${name}.md`, zoneRelativePath: name === 'note' ? 'original.note.json' : `${name}.md` } })), bindings: [], locations: [] }
  original.regions.push({ regionId: 'browser-region', tabId, kind: 'browser', browserId: 'browser-original-owner', agentSessionId: null, runId: null, execution: null })
  original.locations = original.regions.flatMap(region => ['display-first', 'display-exact-second'].map(displayWorkspaceId => ({ spaceId: null, zoneId: zone.zoneId, workspaceId: workspace.id, displayWorkspaceId, groupId: 'group-original', tabId, regionId: region.regionId })))
  const state = { surveyCollectedZones: { [zone.zoneId]: true }, surveyExplorationNames: { [zone.zoneId]: '原研究目录' }, surveyZoneSelection: { zoneId: zone.zoneId, selection: [{ tabId, regionId: 'first-region' }], active: { tabId, regionId: 'first-region' } }, tabs: { [tabId]: { id: tabId, regions: {} } } } as any
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
      const survey = readSurveyPresentation(state, catalog as AgentMuxSpaceCatalog)
      const receipt = parseSpaceControlSuccessReceipt({ schemaVersion: 5, requestId: 'actual-survey-owner-read', operation: 'space.ls', ok: true, result: { catalog: { ...catalog, survey } } })
      return receipt.result
    }
    if (method === 'app.snapshot') return { workspaces: [{ workspaceId: workspace.id, hostId: workspace.hostId, name: workspace.name, path, kind: workspace.kind, projectId: null, repoPath: null, branch: null }], unavailable: [] }
    if (method === 'browser.targets') {
      if (browserFailure) throw new Error('原 Browser 观察暂缺')
      return { targets: [{ id: 'wrong-first-browser', title: '干扰网页', url: 'https://wrong.example', status: 'ready' }, { id: 'browser-original-owner', title: '准确原网页', url: 'http://original.example/read', status: 'ready' }] }
    }
    return service.call(method as any, params)
  })
  const client = { forwardRpc: rpc } as any, back = vi.fn(), changed = vi.fn(), openSession = vi.fn()
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounted.push({ root, element })
  const props: MobileSurveyProps = { client, connected: true, openSession, onBackChange: back, onContextChange: changed, ...(initialContext ? { initialContext } : {}) }
  const render = async (change: Partial<MobileSurveyProps> = {}) => act(async () => root.render(<MobileSurveySurface {...props} {...change} />))
  await render()
  const click = async (text: string) => {
    const found = [...element.querySelectorAll<HTMLButtonElement>('button')].find(button => !button.closest('[hidden]') && button.textContent?.includes(text))
    expect(found, text).toBeDefined(); await act(async () => { found!.click(); await new Promise(resolve => setTimeout(resolve, 30)) })
  }
  const stepBack = async () => { const callback = back.mock.calls.at(-1)?.[0]; expect(callback).toBeTypeOf('function'); await act(async () => callback()) }
  const editor = () => element.querySelector<HTMLElement>('[contenteditable=true]') as HTMLElement & { editor: { commands: { insertContent(value: string): void } } }
  return { path, workspace, zone, tabId, element, rpc, fileRead, fileWrite, click, stepBack, render, back, changed, editor,
    edit: async (text: string) => { expect(editor()?.editor).toBeDefined(); await act(async () => editor().editor.commands.insertContent(text)) },
    failReceipt: () => { failReceipt = true }, failDirectory: () => { directoryFailure = true }, empty: () => { empty = true }, failBrowser: () => { browserFailure = true },
    remap: (directoryPath: string) => { original = { ...original, zones: [{ ...zone, directoryPath }] } }
  }
}

describe('T-007 original Survey selected content frame', () => {
  it('reads only the explicit second Region through original Files and codec, retaining it across back, empty and failed catalog reads', async () => {
    const view = await fixture()
    expect(view.fileRead).not.toHaveBeenCalled()
    await view.click('原研究目录'); expect(view.fileRead).not.toHaveBeenCalled()
    await view.click('original.md')
    expect(view.fileRead.mock.calls.map(call => call[1])).toEqual(['docs/original.md'])
    await vi.waitFor(async () => {
      await act(async () => new Promise(resolve => setTimeout(resolve, 10)))
      expect(view.element.querySelector('.mobile-region-content h1')?.textContent).toBe('准确原 Markdown')
    })
    expect(view.changed).toHaveBeenLastCalledWith({ zoneId: view.zone.zoneId, tabId: view.tabId, regionId: 'original-region' })
    const reads = view.fileRead.mock.calls.length
    await view.stepBack(); expect(view.element.querySelector('[aria-label="研究工作面"]')).not.toBeNull()
    await view.click('original.md'); expect(view.fileRead).toHaveBeenCalledTimes(reads)
    view.empty(); await view.click('刷新原研究')
    expect(view.element.textContent).toContain('当前绑定尚未重新确认')
    expect(view.element.querySelector('.mobile-region-content h1')?.textContent).toBe('准确原 Markdown')
    view.failDirectory(); await view.click('刷新原研究')
    expect(view.element.textContent).toContain('原目录观察暂缺')
    expect(view.fileRead).toHaveBeenCalledTimes(reads)
  })
  it('keeps the exact mounted Note editor and unknown save across Region back and a different Browser, without retrying or selecting the first file', async () => {
    const view = await fixture()
    await view.click('原研究目录'); await view.click('original.note.json'); await view.click('编辑原笔记')
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
    const view = await fixture({ zoneId: 'zone-original-owner', tabId: 'tab-original-owner', regionId: 'original-region' })
    await vi.waitFor(async () => { await act(async () => new Promise(resolve => setTimeout(resolve, 10))); expect(view.element.querySelector('.mobile-region-content h1')?.textContent).toBe('准确原 Markdown') })
    expect(view.fileRead.mock.calls.map(call => call[1])).toEqual(['docs/original.md'])
    expect(view.element.querySelector('.mobile-region-content h1')?.textContent).toBe('准确原 Markdown')
    await view.click('刷新原研究')
    expect(view.changed).toHaveBeenLastCalledWith({ zoneId: view.zone.zoneId, tabId: view.tabId, regionId: 'original-region' })
    expect(view.fileRead).toHaveBeenCalledTimes(1)
    await view.stepBack(); await view.stepBack()
    expect(view.back).toHaveBeenLastCalledWith(null)
    expect(view.changed).toHaveBeenLastCalledWith({ zoneId: null, tabId: null, regionId: null })
  })
  it('refuses the later mapping of the same Zone, preserving the original file body and exact resource reference', async () => {
    const view = await fixture()
    await view.click('原研究目录'); await view.click('original.md')
    await mkdir(join(view.path, 'remapped')); await writeFile(join(view.path, 'remapped/original.md'), '# 另一个映射的正文')
    view.remap(join(view.path, 'remapped')); await view.click('刷新原文件')
    expect(view.rpc).toHaveBeenLastCalledWith('file.read', { zoneId: view.zone.zoneId, path: 'original.md', expectedResource: { hostId: 'local', workspaceId: view.workspace.id, workspacePath: view.path } })
    await act(async () => { await view.rpc.mock.results.at(-1)!.value })
    expect(view.element.querySelector('.mobile-region-content h1')?.textContent).toBe('准确原 Markdown')
    expect(view.element.textContent).not.toContain('另一个映射的正文')
    expect(view.element.textContent).toContain('原文件资源或 Zone 映射未确认一致')
    expect(view.fileWrite).not.toHaveBeenCalled()
  })
  it('keeps the exact Browser URL after observation failure and does not read hidden visited file bodies', async () => {
    const view = await fixture()
    await view.click('原研究目录'); await view.click('查看原网页')
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
    await view.click('原研究目录'); await view.click('original.md')
    const observed = await view.rpc('space.ls', { target: {}, presentation: true })
    let resolve!: (value: unknown) => void
    view.rpc.mockImplementationOnce(() => new Promise(value => { resolve = value }))
    await view.click('刷新原研究'); await view.stepBack(); await view.stepBack()
    await act(async () => resolve(observed))
    expect(view.changed).toHaveBeenLastCalledWith({ zoneId: null, tabId: null, regionId: null })
    expect(view.element.querySelector('nav[aria-label="原研究列表"]')).not.toBeNull()
    expect(view.element.querySelector('[aria-label="研究工作面"]')).toBeNull()
    expect(view.fileRead.mock.calls.map(call => call[1])).toEqual(['docs/original.md'])
  })
})
