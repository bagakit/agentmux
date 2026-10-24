import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost } from '@agentmux/core'
import { WorkspaceFiles } from '../src/main/workspace-files.js'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { NotesStorageOwner } from '../src/main/notes-storage-owner.js'
import { readBookmark } from '../src/main/bookmark-file.js'
import { bookmarkFileNameFromTitle, parseWeblocUrl } from '../src/shared/bookmark-file.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs.js'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { WorkspaceFileWriteResult } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore } from '../src/renderer/src/store.js'

/**
 * T-003：`saveBrowserBookmark` 把当前 Browser 页面存成 workspace 里的 `.webloc`。
 *
 * 承重的一条是**撞名退避**：`files.write` 带 `expectedRevision: null`，文件已存在时返回
 * conflict（不覆盖），于是换下一个候选名，而不是默默盖掉用户已有的书签。判据落在
 * 「conflict → 换名重试 → 落到没被占的那个」这条真实行为上：若把 conflict 当成功/错误、
 * 或不递增候选名，这个用例就会红。
 *
 * 另外两条守边界：about:blank 没地址可存要如实抛（不写文件）；write 真报 error 要往上抛。
 */

const initialState = useAppStore.getState()

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

describe('saveBrowserBookmark 存书签', () => {
  it.each(['中文项目'.repeat(80), '🙂🚀'.repeat(80), '中文🙂'.repeat(80)])('saves a whole-character long title at collision candidate fifty through the real filesystem owner: %s', async (title) => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-bookmark-name-'))
    const workspace = { id: 'workspace', name: 'Project', kind: 'folder' as const, hostId: 'local', path: root }
    const files = new WorkspaceFiles(() => new LocalExecutionHost())
    const base = bookmarkFileNameFromTitle(title), url = 'https://example.invalid/?a=1&b=中🙂'
    try {
      const occupied = Array.from({ length: 49 }, (_, n) => n === 0 ? `${base}.webloc` : `${base} ${n + 1}.webloc`)
      await Promise.all(occupied.map(name => writeFile(join(root, name), 'original bookmark bytes')))
      const write = vi.spyOn(api.files, 'write').mockImplementation(async (_id, input) => files.write(workspace, input))
      const saved = await useAppStore.getState().saveBrowserBookmark(workspace.id, url, title)
      expect(saved).toBe(`${base} 50.webloc`)
      expect(write).toHaveBeenCalledTimes(50)
      expect(Buffer.byteLength(saved)).toBeLessThanOrEqual(255)
      expect(parseWeblocUrl(await readFile(join(root, saved), 'utf8'))).toBe(url)
      expect(await readFile(join(root, occupied[0]!), 'utf8')).toBe('original bookmark bytes')
      expect(Array.from(base).length).toBeLessThanOrEqual(120)
      expect(Buffer.byteLength(base)).toBeLessThanOrEqual(240)
    } finally { await files.dispose(); await rm(root, { recursive: true, force: true }) }
  })
  it('撞名退避：第一个候选被占（conflict）就换下一个，最终落到没被占的名字', async () => {
    useAppStore.setState({ workspaceFileRevisions: {} })
    const taken = new Set(['Example.webloc'])
    const write = vi.spyOn(api.files, 'write').mockImplementation(async (_workspaceId, input) => {
      if (taken.has(input.path)) {
        return { status: 'conflict', observedRevision: 'r-existing' } satisfies WorkspaceFileWriteResult
      }
      return { status: 'written', revision: 'r1' } satisfies WorkspaceFileWriteResult
    })

    const path = await useAppStore
      .getState()
      .saveBrowserBookmark('workspace', 'https://example.com/', 'Example')

    // 撞名后落到 `Example 2.webloc`，不是盖掉 `Example.webloc`。
    expect(path).toBe('Example 2.webloc')
    expect(write.mock.calls.map((call) => call[1]?.path)).toEqual([
      'Example.webloc',
      'Example 2.webloc'
    ])
    // 每次写都用 expectedRevision: null —— 这正是「文件存在就冲突不覆盖」的判据。
    for (const call of write.mock.calls) {
      expect(call[1]?.expectedRevision).toBeNull()
      expect(call[1]?.content).toContain('<string>https://example.com/</string>')
    }
    // 写成了要让文件树看到新文件：失效计数器被 bump。
    expect(useAppStore.getState().workspaceFileRevisions.workspace).toBe(1)

    write.mockClear().mockResolvedValue({ status: 'conflict', observedRevision: 'r-existing' })
    await expect(useAppStore.getState().saveBrowserBookmark('workspace', 'https://example.com/', 'Example'))
      .rejects.toMatchObject({ status: 'error', message: 'Could not save the bookmark: Example 50.webloc already exists' })
    expect(write).toHaveBeenCalledTimes(50)
    expect(useAppStore.getState().workspaceFileRevisions.workspace).toBe(1)
  })

  it('about:blank 没地址可存：如实抛，不写文件', async () => {
    const write = vi.spyOn(api.files, 'write')

    await expect(
      useAppStore.getState().saveBrowserBookmark('workspace', 'about:blank', 'New Tab')
    ).rejects.toMatchObject({ status: 'error', message: 'This page has no address to bookmark yet' })

    expect(write).not.toHaveBeenCalled()
  })

  it('write 真报 error：往上抛，不吞', async () => {
    vi.spyOn(api.files, 'write').mockResolvedValue({
      status: 'error',
      code: 'EACCES',
      message: 'permission denied'
    })

    await expect(
      useAppStore.getState().saveBrowserBookmark('workspace', 'https://example.com/', 'Example')
    ).rejects.toMatchObject({ message: 'permission denied', status: 'error', code: 'EACCES', path: 'Example.webloc' })
  })

  it('retains the original candidate after a transport rejection and never guesses another filename', async () => {
    const write = vi.spyOn(api.files, 'write').mockRejectedValue(Object.assign(new Error('write receipt lost'), { code: 'TRANSPORT_LOST' }))
    await expect(useAppStore.getState().saveBrowserBookmark('workspace', 'https://example.invalid/', 'Example'))
      .rejects.toMatchObject({ message: 'write receipt lost', status: 'unknown', code: 'TRANSPORT_LOST', path: 'Example.webloc' })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('saves, reads and opens the original standard file through real file owners while preserving its source; lost receipt=%s', async lostReceipt => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-bookmark-owner-'))
    const workspace = { id: 'workspace', name: 'Project', kind: 'folder' as const, hostId: 'local', path: root }
    const files = new WorkspaceFiles(() => new LocalExecutionHost(), lostReceipt ? { localWriteFault: 'receipt' } : {})
    const writer = new NoteFileWriter(files), notes = new NotesStorageOwner({} as never, {} as never, () => {})
    const original = createWorkbenchTab('original-browser-tab', { regionId: 'original-browser-region', kind: 'browser',
      workspaceId: workspace.id, browserId: 'original-browser', mode: 'normal', profileId: 'original-profile', navigationId: 'original-navigation',
      url: 'https://example.invalid/original?a=1&b=2', title: 'Original page', loading: false, canGoBack: true, canGoForward: false,
      viewport: 'responsive', driving: false, error: null, appLinkPrompt: null })
    const source = original.regions[original.layout.activeRegionId]!
    if (source.kind !== 'browser') throw new Error('The original Browser fixture is missing')
    useAppStore.setState({ config: { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {},
      workspaces: [workspace], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } },
      activeWorkspaceId: workspace.id, tabs: { [original.id]: original }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', [original.id]) },
      documents: {}, documentIssues: {}, dirtyDocuments: {}, workspaceFileRevisions: {}, error: null })
    try {
      const write = vi.spyOn(api.files, 'write').mockImplementation(async (_id, input) => notes.write(workspace, input, actual => writer.write(actual, input)))
      const request = useAppStore.getState().saveBrowserBookmark(workspace.id, source.url, source.title), path = 'Original page.webloc'
      if (lostReceipt) await expect(request).rejects.toMatchObject({ status: 'unknown', code: 'INJECTED_WRITE_RECEIPT', path })
      else expect(await request).toBe(path)
      expect(write).toHaveBeenCalledTimes(1)
      const document = await writer.read(workspace, path)
      expect(document.status).toBe('read')
      if (document.status !== 'read') throw new Error('The original bookmark bytes are unavailable')
      expect(parseWeblocUrl(document.document.content)).toBe(source.url)
      const preview = vi.spyOn(api.files, 'readBookmark').mockImplementation(async (_id, requested) => {
        const bytes = await files.readBookmarkBytes(workspace, requested)
        return bytes ? readBookmark('webloc', bytes, async () => { throw new Error('XML bookmarks require no subprocess conversion') }) : { url: null, binary: false }
      })
      const create = vi.spyOn(api.browser, 'create').mockImplementation(async (id, url) => ({ ...source, id, url, navigationId: 'opened-navigation' }))
      await useAppStore.getState().openFile(path, undefined, undefined, workspace.id)
      expect(preview).toHaveBeenCalledExactlyOnceWith(workspace.id, path)
      expect(create).toHaveBeenCalledTimes(1)
      expect(create.mock.calls[0]?.[1]).toBe(source.url)
      expect(useAppStore.getState().tabs[original.id]).toBe(original)
      expect(useAppStore.getState().documents[documentKey(workspace.id, path)]).toBeUndefined()
      expect(write).toHaveBeenCalledTimes(1)
    } finally { await files.dispose(); await rm(root, { recursive: true, force: true }) }
  })
})
