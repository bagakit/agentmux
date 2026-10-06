import { fixturePath } from '../../../test/fixture-values.mjs'
import { act, useLayoutEffect, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { AgentMuxRpcService, type ExecutionHost } from '@agentmux/core'
import { parseFileListResult, parseFileReadResult } from '@agentmux/core/files'
import { readNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { FileReadOwner } from '../../desktop/src/main/file-read-owner'
import { WorkspaceFiles } from '../../desktop/src/main/workspace-files'
import { MobileTopicSource, type MobileTopicSourceProps } from '../src/topics/MobileTopicSource'
import { parseMobileTopicSourceContentReference, type MobileTopicSourceContentReference } from '../src/topics/source-reference'
import type { TopicsRpc } from '../src/topics/MobileTopicKnowledge'
import { mount, mounted } from './conversation-fixture'

const roots: string[] = [], originalFiles: WorkspaceFiles[] = []
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  for (const files of originalFiles.splice(0)) await files.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  localStorage.clear(); vi.restoreAllMocks()
})
async function click(element: HTMLElement, text: string) {
  const button = [...element.querySelectorAll<HTMLButtonElement>('button')].find(button => !button.closest('[hidden]') && button.textContent === text)
  expect(button, `Visible original action ${text}`).toBeDefined()
  await act(async () => button!.click())
}
async function waitFor(check: () => void) {
  await vi.waitFor(async () => { await act(async () => {}); check() })
}
async function unmount(element: HTMLElement) {
  const index = mounted.findIndex(item => item.element === element), item = mounted.splice(index, 1)[0]!
  await act(async () => item.root.unmount()); item.element.remove()
}
const workspace = { workspaceId: 'original-workspace', hostId: 'original-host', projectId: 'original-project', name: '原资源项目', path: fixturePath("original"), kind: 'folder', repoPath: null, branch: null }
const zone = { zoneId: 'original-zone', workspaceId: workspace.workspaceId, hostId: workspace.hostId, directoryPath: workspace.path, kind: 'directory', branch: null }
const expectedResource = { hostId: workspace.hostId, workspaceId: workspace.workspaceId, workspacePath: workspace.path }
const source = { kind: 'file' as const, hostId: workspace.hostId, projectId: workspace.projectId, path: fixturePath("original/docs") }
const filePin = (path: string) => ({ target: { zoneId: zone.zoneId, path, expectedResource }, resource: { ...expectedResource, zoneId: zone.zoneId, zonePath: zone.directoryPath, path } })
const savedFile = (): MobileTopicSourceContentReference => ({ kind: 'file', trail: [filePin('docs'), filePin('docs/second.md')] })
function originalRead(path: string, content = '# 准确第二文件') {
  return { resource: filePin(path).resource, result: { status: 'read', document: { path, content, revision: 'sha256:' + 'a'.repeat(64) } } }
}
const callbacks = () => ({ onBack: vi.fn(), onBackChange: vi.fn(), openScope: vi.fn(), onReferenceChange: vi.fn() })
function scopeRpc(extra: (method: string, params: any) => unknown) {
  const call = vi.fn(async (method: string, params: any) => method === 'app.snapshot' ? { workspaces: [workspace], unavailable: [] }
    : method === 'space.ls' ? { catalog: { zones: [zone] } } : extra(method, params))
  return { call, rpc: call as unknown as TopicsRpc }
}
async function actualFiles(receiptFault = false) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'amx-topic-source-reference-'))); roots.push(path)
  const originalWorkspace = { ...workspace, path }, originalZone = { ...zone, directoryPath: path }
  const files = new WorkspaceFiles(() => ({ kind: 'local' } as ExecutionHost), receiptFault ? { localWriteFault: () => 'receipt' } : {})
  originalFiles.push(files)
  const owner = new FileReadOwner({ files, workspace: id => id === workspace.workspaceId
    ? { id, hostId: workspace.hostId, name: workspace.name, path, kind: 'folder' } : undefined,
  catalog: async () => ({ spaces: [], zones: [originalZone], tabs: [], regions: [], bindings: [], locations: [] } as AgentMuxSpaceCatalog) })
  return { path, originalWorkspace, originalZone, owner, service: new AgentMuxRpcService({ files: owner, coreClients: () => [] }) }
}

describe('source content references without saved bodies or substituted resources', () => {
  it('parses original Files mapping pins and rejects bodies, an escaped target and the wrong outer source kind', () => {
    const reference = savedFile()
    expect(parseMobileTopicSourceContentReference(reference, source)).toEqual(reference)
    expect(() => parseMobileTopicSourceContentReference({ ...reference, body: 'not a reference' }, source)).toThrow()
    expect(() => parseMobileTopicSourceContentReference({ kind: 'file', trail: [{ ...filePin('docs'), target: { ...filePin('docs').target, path: '../second.md' } }] }, source)).toThrow()
    expect(() => parseMobileTopicSourceContentReference(reference, { kind: 'notebook', notebookId: 'original-book' })).toThrow()
    expect(() => parseMobileTopicSourceContentReference({ kind: 'file', trail: [{ ...filePin('docs'), resource: { ...filePin('docs').resource, path: 'another.md' } }] }, source)).toThrow()
    const mapping = { noteId: 'second-note', blockId: 'second-block', resource: { ...expectedResource, path: 'second.note.md' }, workface: { zoneId: zone.zoneId, workspaceId: workspace.workspaceId } }
    const note = { kind: 'note' as const, mapping, trail: [filePin('second.note.md')] }
    expect(parseMobileTopicSourceContentReference(note, { kind: 'note', noteId: mapping.noteId, blockId: mapping.blockId })).toEqual(note)
    expect(() => parseMobileTopicSourceContentReference(note, { kind: 'note', noteId: 'other-note', blockId: mapping.blockId })).toThrow()
    expect(() => parseMobileTopicSourceContentReference({ ...note, trail: [filePin('first.note.md')] }, { kind: 'note', noteId: mapping.noteId, blockId: mapping.blockId })).toThrow()
  })

  it('rejects a second independently valid File resource under the same original Note ID', () => {
    const mapping = { noteId: 'second-note', resource: { ...expectedResource, path: 'second.note.md' }, workface: { zoneId: zone.zoneId, workspaceId: workspace.workspaceId } }
    const first = filePin('second.note.md'), copy = filePin('same-note-copy.note.md')
    // Each resource is valid in the original Files protocol. The Source Note contract rejects the second file.
    for (const pin of [first, copy]) expect(parseFileReadResult({ resource: pin.resource, result: { status: 'directory' } }, pin.target).resource).toEqual(pin.resource)
    const reference = { kind: 'note' as const, mapping, trail: [first, copy] }
    expect(() => parseMobileTopicSourceContentReference(reference, { kind: 'note', noteId: mapping.noteId })).toThrow()
    expect(() => parseMobileTopicSourceContentReference({ kind: 'notebook', selectedNote: { ...mapping, trail: [first, copy] } }, { kind: 'notebook', notebookId: 'original-book' })).toThrow()
  })

  it('rejects a valid File child pin from another selected scope, retaining the original same-scope trail contract', () => {
    const first = filePin('docs'), child = filePin('docs/second.md')
    const other = { target: { ...child.target, zoneId: 'another-zone' }, resource: { ...child.resource, zoneId: 'another-zone' } }
    expect(parseFileReadResult({ resource: other.resource, result: { status: 'directory' } }, other.target).resource).toEqual(other.resource)
    expect(() => parseMobileTopicSourceContentReference({ kind: 'file', trail: [first, other] }, source)).toThrow()
    expect(parseMobileTopicSourceContentReference({ kind: 'file', trail: [first, child] }, source)).toEqual({ kind: 'file', trail: [first, child] })
  })

  it('registers the restored inner Back at the first parent layout commit without waiting for metadata', async () => {
    let back: (() => void) | null = null
    const observed: boolean[] = [], changes = vi.fn()
    function FirstCommit({ children }: { children: ReactNode }) {
      useLayoutEffect(() => { observed.push(typeof back === 'function'); back?.() }, [])
      return children
    }
    const rpc = vi.fn(() => new Promise(() => {})) as unknown as TopicsRpc
    await mount(<FirstCommit><MobileTopicSource source={source} rpc={rpc} initialReference={savedFile()}
      onBack={vi.fn()} openScope={vi.fn()} onBackChange={value => { back = value }} onReferenceChange={changes} /></FirstCommit>)
    expect(observed).toEqual([true])
    expect(changes).toHaveBeenCalledOnce()
    expect(changes.mock.calls[0]![0].trail.map((item: { target: { path: string } }) => item.target.path)).toEqual(['docs'])
  })

  it('re-reads the actual owner trail after a new mount and returns to its cached directory without another RPC', async () => {
    const actual = await actualFiles()
    await mkdir(join(actual.path, 'docs')); await writeFile(join(actual.path, 'docs/first.md'), '# 不应自动选择的第一文件')
    await writeFile(join(actual.path, 'docs/second.md'), '# 准确第二文件\n\n原 owner 的非空正文。')
    const call = vi.fn(async (method: string, params: any) => method === 'app.snapshot' ? { workspaces: [actual.originalWorkspace], unavailable: [] }
      : method === 'space.ls' ? { catalog: { zones: [actual.originalZone] } }
        : method === 'file.read' ? parseFileReadResult(await actual.owner.read(params), params)
          : method === 'file.list' ? parseFileListResult(await actual.owner.list(params), params) : Promise.reject(new Error(`Unexpected ${method}`)))
    const original = { ...source, path: join(actual.path, 'docs') }
    let record: MobileTopicSourceContentReference | undefined
    const props = { ...callbacks(), source: original, rpc: call as unknown as TopicsRpc,
      onReferenceChange: (value: MobileTopicSourceContentReference) => { record = parseMobileTopicSourceContentReference(value, original) } }
    const first = await mount(<MobileTopicSource {...props} />)
    await waitFor(() => expect(first.element.textContent).toContain('second.md'))
    await click(first.element, 'second.md')
    await waitFor(() => expect(first.element.querySelector('article h1')?.textContent).toBe('准确第二文件'))
    expect(record!.kind).toBe('file')
    if (!record || record.kind !== 'file') throw new Error('The original Source must save a File trail')
    expect(record!.trail.map(item => item.target.path)).toEqual(['docs', 'docs/second.md'])
    expect(JSON.stringify(record)).not.toContain('原 owner 的非空正文')
    await unmount(first.element)
    const before = call.mock.calls.length
    const reopened = await mount(<MobileTopicSource {...props} initialReference={record} />)
    await waitFor(() => expect(reopened.element.querySelector('article h1')?.textContent).toBe('准确第二文件'))
    expect(call.mock.calls.slice(before).filter(([method]) => method === 'file.read').map(([, params]) => params.path)).toEqual(['docs', 'docs/second.md'])
    const reads = call.mock.calls.length
    await act(async () => props.onBackChange.mock.calls.at(-1)![0]())
    expect(reopened.element.querySelector('article h1')).toBeNull()
    expect(reopened.element.textContent).toContain('first.md'); expect(reopened.element.textContent).toContain('second.md')
    expect(call.mock.calls).toHaveLength(reads); expect(props.onBack).not.toHaveBeenCalled()
    expect(record.kind === 'file' && record.trail.map(item => item.target.path)).toEqual(['docs'])
  })

  it('keeps an offline pending child reference until its exact owner can re-read it', async () => {
    let offline = true
    const call = vi.fn(async (method: string, params: any) => {
      if (offline) throw new Error('原 Host 当前不可读')
      return method === 'app.snapshot' ? { workspaces: [workspace], unavailable: [] } : method === 'space.ls' ? { catalog: { zones: [zone] } }
        : method === 'file.list' ? { resource: filePin('docs').resource, result: { status: 'listed', files: ['first.md', 'second.md'], complete: true, partialReason: null, omitted: 'none' } }
          : params.path === 'docs' ? { resource: filePin('docs').resource, result: { status: 'directory' } } : originalRead(params.path)
    })
    const props = { ...callbacks(), source, rpc: call as unknown as TopicsRpc, initialReference: savedFile() }
    const view = await mount(<MobileTopicSource {...props} />)
    expect(props.onReferenceChange).not.toHaveBeenCalled()
    expect(view.element.querySelector('header h1')?.textContent).toBe('second.md')
    expect(view.element.textContent).toContain('原引用、已确认范围')
    offline = false; await click(view.element, '重试读取')
    await waitFor(() => expect(view.element.querySelector('article h1')?.textContent).toBe('准确第二文件'))
    expect(props.onReferenceChange).not.toHaveBeenCalled()
    expect(call.mock.calls.filter(([method]) => method === 'file.read').map(([, params]) => params.path)).toEqual(['docs', 'docs/second.md'])
  })

  it('rejects a changed original File mapping before rendering its other body, retaining the saved trail', async () => {
    const { rpc, call } = scopeRpc((method, params) => method === 'file.read'
      ? { ...originalRead(params.path, '# 不能冒充的另一正文'), resource: { ...filePin(params.path).resource, zonePath: fixturePath("different"), logicalDirectory: '' } }
      : Promise.reject(new Error(`Unexpected ${method}`)))
    const props = { ...callbacks(), source, rpc, initialReference: savedFile() }
    const view = await mount(<MobileTopicSource {...props} />)
    expect(view.element.textContent).toContain('Zone 文件映射已改变')
    expect(view.element.textContent).not.toContain('不能冒充的另一正文')
    expect(props.onReferenceChange).not.toHaveBeenCalled()
    expect(call.mock.calls.filter(([method]) => method === 'file.read')).toHaveLength(1)
  })

  it('restores the second Notebook Note with its original unknown input, later draft and block identity after remount', async () => {
    const actual = await actualFiles(true), noteId = 'second-note'
    const note = (id: string, text: string) => serializeNoteDocument({ schema: 'agentmux.note.v1', noteId: id, content: { type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: `${id}-block` }, content: [{ type: 'text', text }] }] } })
    await writeFile(join(actual.path, 'first.note.md'), note('first-note', '不自动选择的第一页'))
    await writeFile(join(actual.path, 'second.note.md'), note(noteId, '准确原第二页'))
    const pages = ['first', 'second'].map(name => ({ noteId: `${name}-note`, title: name === 'first' ? '第一页' : '第二页', resource: {
      ...expectedResource, workspacePath: actual.path, path: `${name}.note.md` }, workface: { zoneId: zone.zoneId, workspaceId: workspace.workspaceId } }))
    const call = vi.fn(async (method: string, params: any) => method === 'notebook.inspect' ? { notebook: { notebookId: 'original-book', name: '原笔记本' }, pages: params.noteId ? pages.filter(page => page.noteId === params.noteId) : pages }
      : method === 'app.snapshot' ? { workspaces: [actual.originalWorkspace], unavailable: [] }
        : method === 'space.ls' ? { catalog: { zones: [actual.originalZone] } } : actual.service.call(method as any, params))
    const original = { kind: 'notebook' as const, notebookId: 'original-book' }
    let record: MobileTopicSourceContentReference | undefined
    const props = { ...callbacks(), source: original, rpc: call as unknown as TopicsRpc,
      onReferenceChange: (value: MobileTopicSourceContentReference) => { record = parseMobileTopicSourceContentReference(value, original) } }
    const first = await mount(<MobileTopicSource {...props} />)
    await click(first.element, '第二页second.note.md')
    await waitFor(() => expect(first.element.querySelector('[data-note-id]')?.getAttribute('data-note-id')).toBe(noteId))
    await click(first.element, '编辑原笔记')
    const editor = first.element.querySelector<HTMLElement>('[contenteditable="true"]') as HTMLElement & { editor: { commands: { insertContent(text: string): void } } }
    await act(async () => editor.editor.commands.insertContent('明确写入的原未知稿'))
    await click(first.element, '保存原笔记')
    await waitFor(() => expect(first.element.textContent).toContain('保存回执未知'))
    await act(async () => editor.editor.commands.insertContent('后来未发送稿'))
    const persisted = [...Array(localStorage.length)].map((_, i) => localStorage.key(i)!).find(key => key.startsWith('agentmux-mobile-note-draft:'))!
    const draft = JSON.parse(localStorage.getItem(persisted)!)
    expect(draft.attempt.phase).toBe('unknown'); expect(draft.attempt.content).toContain('明确写入的原未知稿')
    expect(draft.attempt.content).not.toContain('后来未发送稿'); expect(draft.draft).toContain('后来未发送稿')
    expect(record!.kind === 'notebook' && record!.selectedNote?.noteId).toBe(noteId)
    if (!record || record.kind !== 'notebook') throw new Error('The original Source must save its Notebook Note reference')
    await unmount(first.element)
    const before = call.mock.calls.length
    const reopened = await mount(<MobileTopicSource {...props} initialReference={record} />)
    await waitFor(() => expect(reopened.element.querySelector('[data-note-id]')?.getAttribute('data-note-id')).toBe(noteId))
    const newEditor = reopened.element.querySelector<HTMLElement>('[contenteditable="true"]')!
    expect(newEditor).not.toBe(editor); expect(newEditor.textContent).toContain('后来未发送稿')
    expect(reopened.element.querySelector('[data-block-id="second-note-block"]')).not.toBeNull()
    expect(reopened.element.textContent).toContain('原保存回执未确认')
    expect(call.mock.calls.slice(before).filter(([method]) => method === 'file.read').map(([, params]) => params.path)).toEqual(['second.note.md'])
    expect(call.mock.calls.filter(([method]) => method === 'file.write')).toHaveLength(1)
    const saved = readNoteDocument(await readFile(join(actual.path, 'second.note.md'), 'utf8'))
    expect(saved.status === 'valid' && saved.note.noteId).toBe(noteId)
    expect(JSON.stringify(saved)).not.toContain('后来未发送稿')
  })

  it('does not replace a restored second Note with the first page or a same-ID different resource', async () => {
    const original = { kind: 'notebook' as const, notebookId: 'original-book' }
    const saved: MobileTopicSourceContentReference = { kind: 'notebook', selectedNote: { noteId: 'second-note', resource: {
      ...expectedResource, path: 'second.note.md' }, workface: { zoneId: zone.zoneId, workspaceId: workspace.workspaceId }, trail: [] } }
    const call = vi.fn(async () => ({ notebook: { notebookId: original.notebookId, name: '原笔记本' }, pages: [
      { noteId: 'first-note', title: '第一页', resource: { ...expectedResource, path: 'first.note.md' } },
      { noteId: 'second-note', title: '第二页', resource: { ...expectedResource, path: 'wrong/second.note.md' }, workface: { zoneId: zone.zoneId, workspaceId: workspace.workspaceId } }] }))
    const props = { ...callbacks(), source: original, rpc: call as unknown as TopicsRpc, initialReference: saved }
    const view = await mount(<MobileTopicSource {...props} />)
    expect(view.element.querySelector('[aria-label="原笔记页待核实"]')?.textContent).toContain('映射尚未确认或已改变')
    expect(call).toHaveBeenCalledExactlyOnceWith('notebook.inspect', { notebookId: original.notebookId })
    expect(props.onReferenceChange).not.toHaveBeenCalled(); expect(view.element.querySelector('[data-note-id]')).toBeNull()
  })

  it('does not read a hidden source, or publish a late old/unmounted read into later references', async () => {
    let resolve!: (value: unknown) => void, resolveLater!: (value: unknown) => void, laterReads = 0
    const { rpc, call } = scopeRpc((method, params) => method === 'file.read' && params.path === 'docs'
      ? new Promise(done => { resolve = done }) : method === 'file.read' && ++laterReads > 1
        ? new Promise(done => { resolveLater = done }) : originalRead(params.path, '# 后来的准确正文'))
    const cb = callbacks(), props: MobileTopicSourceProps = { ...cb, source, rpc, initialReference: savedFile(), visible: false }
    const view = await mount(<MobileTopicSource {...props} />)
    expect(call).not.toHaveBeenCalled(); expect(props.onReferenceChange).not.toHaveBeenCalled()
    await view.render(<MobileTopicSource {...props} visible />)
    await waitFor(() => expect(resolve).toBeTypeOf('function'))
    const next = { ...source, path: fixturePath("original/later.md") }
    const { initialReference: _previousReference, ...laterProps } = props
    await view.render(<MobileTopicSource {...laterProps} source={next} visible />)
    await act(async () => resolve(originalRead('docs', '# 已过时正文')))
    expect(view.element.querySelector('article h1')?.textContent).toBe('后来的准确正文')
    expect(JSON.stringify(cb.onReferenceChange.mock.calls)).not.toContain('docs/second.md')
    const reads = cb.onReferenceChange.mock.calls.length
    await click(view.element, '刷新原文件')
    expect(resolveLater).toBeTypeOf('function')
    await unmount(view.element)
    await act(async () => resolveLater(originalRead('later.md', '# 卸载后的迟到正文')))
    expect(cb.onReferenceChange.mock.calls).toHaveLength(reads)
  })
})
