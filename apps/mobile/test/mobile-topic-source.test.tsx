import { fixturePath } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileTopicSource } from '../src/topics/MobileTopicSource'
import type { TopicsRpc } from '../src/topics/MobileTopicKnowledge'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const mounted: { root: Root; element: HTMLDivElement }[] = []
async function mount(props: Parameters<typeof MobileTopicSource>[0]) {
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounted.push({ root, element })
  await act(async () => root.render(<MobileTopicSource {...props} />))
  return { element, render: async (next: Parameters<typeof MobileTopicSource>[0]) => { await act(async () => root.render(<MobileTopicSource {...next} />)) } }
}
afterEach(async () => { for (const { root, element } of mounted.splice(0)) { await act(async () => root.unmount()); element.remove() } })
async function click(element: HTMLElement, text: string) {
  const found = [...element.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)
  expect(found, text).toBeDefined(); await act(async () => found!.click())
}
const workspace = { workspaceId: 'workspace-id-not-a-title', hostId: 'original-host', name: '原配置项目', projectId: 'project', path: fixturePath("projects/original"), kind: 'folder', repoPath: null, branch: null }
const zone = { zoneId: 'original-zone', workspaceId: workspace.workspaceId, hostId: workspace.hostId, directoryPath: workspace.path, kind: 'directory', branch: null }
const source = { kind: 'file' as const, hostId: workspace.hostId, projectId: 'project', path: fixturePath("projects/original/docs/a.md"), revision: 'old-revision' }
const expectedResource = { hostId: workspace.hostId, workspaceId: workspace.workspaceId, workspacePath: workspace.path }
const originalRead = { resource: { ...expectedResource, zoneId: zone.zoneId, zonePath: zone.directoryPath, path: 'docs/a.md' }, result: { status: 'read', document: { path: 'docs/a.md', content: '# 原文件正文\n\n完整阅读', revision: 'new-revision' } } }
function fixture(extra?: (method: string, params: any) => unknown) {
  const call = vi.fn(async (method: string, params: any) => extra ? extra(method, params) : method === 'app.snapshot' ? { workspaces: [workspace], unavailable: [] } : method === 'space.ls' ? { catalog: { zones: [zone] } } : originalRead)
  return { call, rpc: call as unknown as TopicsRpc }
}
describe('original knowledge source read', () => {
  it('reads a unique exact Host/Project/Zone using the original file owner and configured path label', async () => {
    const { rpc, call } = fixture(), openScope = vi.fn(), back = vi.fn()
    const { element } = await mount({ source, rpc, onBack: back, openScope, displayPath: path => path.replace(fixturePath("projects/original"), '项目根') })
    expect(call).toHaveBeenCalledWith('file.read', { zoneId: zone.zoneId, path: 'docs/a.md', expectedResource })
    expect(element.querySelector('article h1')?.textContent).toBe('原文件正文')
    expect(element.textContent).toContain('当前保存版本与来源记录的版本不同')
    expect(element.textContent).toContain('项目根'); expect(element.textContent).not.toContain(workspace.workspaceId)
    await click(element, '打开原工作面'); expect(openScope).toHaveBeenCalledWith({ zoneId: zone.zoneId, path: 'docs/a.md', workspace, directoryPath: zone.directoryPath })
    await click(element, '返回知识'); expect(back).toHaveBeenCalledOnce()
  })
  it('does not pick the first of multiple exact scopes or read from a different Host or path sibling', async () => {
    const nested = { ...zone, zoneId: 'nested-zone', directoryPath: fixturePath("projects/original/docs") }
    const { rpc, call } = fixture((method) => method === 'app.snapshot' ? { workspaces: [workspace], unavailable: [] }
      : method === 'space.ls' ? { catalog: { zones: [zone, nested, { ...zone, zoneId: 'wrong-host', hostId: 'other' }, { ...zone, zoneId: 'wrong-boundary', directoryPath: fixturePath("projects/orig") }] } } : originalRead)
    const { element } = await mount({ source, rpc, onBack: vi.fn(), openScope: vi.fn() })
    expect(call.mock.calls.filter(value => value[0] === 'file.read')).toHaveLength(0)
    const choices = [...element.querySelectorAll<HTMLButtonElement>('li button')].filter(button => button.textContent !== '打开此原工作面')
    expect(choices).toHaveLength(2)
    await act(async () => choices[1]!.click())
    expect(call).toHaveBeenLastCalledWith('file.read', { zoneId: nested.zoneId, path: 'a.md', expectedResource })
  })
  it('keeps confirmed source prose on an unknown reread and recovers in band without writes', async () => {
    let unknown = false
    const { rpc, call } = fixture(method => method === 'app.snapshot' ? { workspaces: [workspace], unavailable: [] }
      : method === 'space.ls' ? { catalog: { zones: [zone] } } : unknown ? { resource: null, result: { status: 'unknown', message: 'read unavailable', code: 'UNAVAILABLE' } } : originalRead)
    const { element } = await mount({ source, rpc, onBack: vi.fn(), openScope: vi.fn() })
    unknown = true; await click(element, '重试读取')
    expect(element.querySelector('article h1')?.textContent).toBe('原文件正文'); expect(element.textContent).toContain('read unavailable')
    unknown = false; await click(element, '重试原文件')
    expect(element.textContent).not.toContain('read unavailable')
    expect(call.mock.calls.map(value => value[0])).toEqual(['app.snapshot', 'space.ls', 'file.read', 'app.snapshot', 'space.ls', 'file.read', 'file.read'])
  })
  it('keeps a confirmed original workface actionable even when the first file read is unknown', async () => {
    const { rpc } = fixture(method => method === 'app.snapshot' ? { workspaces: [workspace], unavailable: [] }
      : method === 'space.ls' ? { catalog: { zones: [zone] } } : { resource: null, result: { status: 'unknown', code: 'UNAVAILABLE', message: 'reader unavailable' } })
    const openScope = vi.fn()
    const { element } = await mount({ source, rpc, onBack: vi.fn(), openScope })
    expect(element.textContent).toContain('reader unavailable')
    await click(element, '打开原工作面')
    expect(openScope).toHaveBeenCalledWith({ zoneId: zone.zoneId, path: 'docs/a.md', workspace, directoryPath: zone.directoryPath })
  })
  it('lists an original directory and joins owner-relative file names to its exact requested directory', async () => {
    const { rpc, call } = fixture((method, params) => method === 'app.snapshot' ? { workspaces: [workspace], unavailable: [] }
      : method === 'space.ls' ? { catalog: { zones: [zone] } } : method === 'file.list' ? { resource: originalRead.resource, result: { status: 'listed', files: ['nested/a.md'], complete: false, partialReason: 'budget', omitted: 'git-ignored' } }
        : params.path === 'docs' ? { resource: originalRead.resource, result: { status: 'directory' } } : originalRead)
    const { element } = await mount({ source: { ...source, path: fixturePath("projects/original/docs") }, rpc, onBack: vi.fn(), openScope: vi.fn() })
    expect(call).toHaveBeenCalledWith('file.list', { zoneId: zone.zoneId, path: 'docs', expectedResource })
    expect(element.textContent).toContain('budget')
    await click(element, 'nested/a.md')
    expect(call).toHaveBeenLastCalledWith('file.read', { zoneId: zone.zoneId, path: 'docs/nested/a.md', expectedResource })
  })
  it('reports an unregistered Note resource gap without guessing a path or scanning files', async () => {
    const { rpc, call } = fixture(() => ({ pages: [], notebook: null }))
    const { element } = await mount({ source: { kind: 'note', noteId: 'unregistered-note', blockId: 'original-block' }, rpc, onBack: vi.fn(), openScope: vi.fn() })
    expect(call.mock.calls.map(value => value[0])).toEqual(['notebook.inspect'])
    expect(element.textContent).toContain('不能仅凭 Note ID 定位正文')
  })
  it('asks the original owner for a registered Note logical mapping and shares NoteReader without duplicating Scratch rules', async () => {
    const physicalZone = { ...zone, directoryPath: fixturePath("outside/topic") }
    const noteContent = JSON.stringify({ schema: 'agentmux.note.v1', noteId: 'original-note', content: { type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: 'original-block' }, content: [{ type: 'text', text: '原笔记正文' }] }] } })
    const { rpc, call } = fixture(method => method === 'notebook.inspect' ? { pages: [{ noteId: 'original-note', resource: { ...expectedResource, path: 'logical-topic/note.note.json' }, workface: { zoneId: zone.zoneId, workspaceId: workspace.workspaceId } }] }
      : method === 'app.snapshot' ? { workspaces: [workspace], unavailable: [] } : method === 'space.ls' ? { catalog: { zones: [physicalZone] } }
        : method === 'file.list' ? { resource: { ...originalRead.resource, path: 'logical-topic' }, result: { status: 'listed', files: [], complete: true, omitted: 'none', partialReason: null } }
          : { resource: originalRead.resource, result: { status: 'read', document: { path: 'logical-topic/note.note.json', content: noteContent, revision: 'sha256:' + 'a'.repeat(64) } } })
    const { element } = await mount({ source: { kind: 'note', noteId: 'original-note', blockId: 'original-block' }, rpc, onBack: vi.fn(), openScope: vi.fn() })
    expect(call).toHaveBeenCalledWith('file.list', { zoneId: zone.zoneId, path: '.', expectedResource })
    expect(call).toHaveBeenCalledWith('file.read', { zoneId: zone.zoneId, path: 'note.note.json', expectedResource })
    expect(element.textContent).toContain('原笔记正文'); expect(element.querySelector('[data-target-block="original-block"]')).not.toBeNull(); expect(element.textContent).toContain('引用的原块')
  })
  it('reads the original Notebook directory without fabricating a Notebook body or automatically opening its first page', async () => {
    const { rpc, call } = fixture(() => ({ notebook: { notebookId: 'original-book', name: '原笔记本名' }, pages: [{ noteId: 'page-id', title: '原页标题', resource: { ...expectedResource, path: 'a.note.json' } }] }))
    const { element } = await mount({ source: { kind: 'notebook', notebookId: 'original-book' }, rpc, onBack: vi.fn(), openScope: vi.fn() })
    expect(call).toHaveBeenCalledExactlyOnceWith('notebook.inspect', { notebookId: 'original-book' })
    expect(element.textContent).toContain('原笔记本名'); expect(element.textContent).toContain('原页标题')
    expect(element.querySelector('article')).toBeNull()
  })
  it('does not substitute a current unrelated workspace when the original resource is absent', async () => {
    const { rpc, call } = fixture(method => method === 'app.snapshot' ? { workspaces: [{ ...workspace, hostId: 'another-host' }], unavailable: [] } : { catalog: { zones: [zone] } })
    const { element } = await mount({ source, rpc, onBack: vi.fn(), openScope: vi.fn() })
    expect(call.mock.calls.map(value => value[0])).toEqual(['app.snapshot', 'space.ls'])
    expect(element.textContent).toContain('尚未共同确认'); expect(element.textContent).toContain(source.path)
  })
  it('ignores a late file body from a prior source instead of changing the later source reading', async () => {
    let resolve!: (value: unknown) => void
    const later = { ...source, path: fixturePath("projects/original/later.md") }
    const { rpc } = fixture((method, params) => method === 'app.snapshot' ? { workspaces: [workspace], unavailable: [] }
      : method === 'space.ls' ? { catalog: { zones: [zone] } } : params.path === 'docs/a.md' ? new Promise(value => { resolve = value })
        : { ...originalRead, result: { status: 'read', document: { path: 'later.md', content: '# 后来的正文', revision: 'later' } } })
    const callbacks = { rpc, onBack: vi.fn(), openScope: vi.fn() }
    const view = await mount({ ...callbacks, source })
    await view.render({ ...callbacks, source: later })
    await act(async () => resolve(originalRead))
    expect(view.element.querySelector('article h1')?.textContent).toBe('后来的正文')
  })
})
