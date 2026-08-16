import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AppConfig } from '../src/shared/contracts.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { documentKey } from '../src/renderer/src/lib/workbench-tabs.js'
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore } from '../src/renderer/src/store.js'

/**
 * T-002：`openFile` 把书签文件默认开进 Browser，不进 Monaco（用户原话「应该是默认 browser」）。
 *
 * 承重的两条：
 *  1. 书签 + URL 取得出 → 开 Browser（`api.browser.create` 被喂那个 URL），且**不建 document**
 *     （不进 Monaco）——这正是「默认 browser」。
 *  2. URL 取不出（二进制读不回、坏文件）→ **落穿**到既有文本打开路径（`api.files.read` 被调、
 *     document 落地）。诚实失败，不静默丢一个点击。
 *
 * 判据落在**行为**（开了 Browser / 建了 document）上，而不是「某个分支被走到」：
 * 分开判会漂移，且加第三种文件类型时没人记得两处都改。
 */

const initialState = useAppStore.getState()

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: {
    toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true }
  }
}

function workspaceFixture(): void {
  useAppStore.setState({
    config,
    activeWorkspaceId: 'workspace',
    layouts: { workspace: createWorkspaceLayout('pane') },
    documents: {},
    documentRevealTargets: {},
    documentIssues: {},
    error: null
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

describe('openFile 把书签默认开进 Browser', () => {
  it('URL 取得出：开 Browser 喂那个 URL，且不进 Monaco（不建 document）', async () => {
    workspaceFixture()
    const PATH = 'links/Example.webloc'
    const URL = 'https://example.com/'
    const readBookmark = vi.spyOn(api.files, 'readBookmark').mockResolvedValue({ url: URL, binary: false })
    const browserCreate = vi.spyOn(api.browser, 'create')
    // 若书签分支失灵、落到文本路径，这两个 spy 会暴露它：不该有人读文件内容当文档。
    const filesRead = vi.spyOn(api.files, 'read')

    await useAppStore.getState().openFile(PATH, undefined, undefined, 'workspace')

    expect(readBookmark).toHaveBeenCalledWith('workspace', PATH)
    // 开进 Browser，且导航到书签指向的 URL。
    expect(browserCreate).toHaveBeenCalledTimes(1)
    expect(browserCreate.mock.calls[0]?.[1]).toBe(URL)
    // 不进 Monaco：既没读文件内容，也没有 document 落地。
    expect(filesRead).not.toHaveBeenCalled()
    expect(useAppStore.getState().documents[documentKey('workspace', PATH)]).toBeUndefined()
  })

  it('URL 取不出：落穿到文本打开（读文件、建 document），不开 Browser', async () => {
    workspaceFixture()
    const PATH = 'links/Broken.webloc'
    vi.spyOn(api.files, 'readBookmark').mockResolvedValue({ url: null, binary: false })
    const browserCreate = vi.spyOn(api.browser, 'create')
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
    vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
    const filesRead = vi.spyOn(api.files, 'read').mockResolvedValue({
      status: 'read',
      document: { path: PATH, content: 'bplist00 garbage', revision: 'r1' }
    })

    await useAppStore.getState().openFile(PATH, undefined, undefined, 'workspace')

    // 落穿：走既有文本路径，不开 Browser。
    expect(browserCreate).not.toHaveBeenCalled()
    expect(filesRead).toHaveBeenCalledWith('workspace', PATH)
    expect(useAppStore.getState().documents[documentKey('workspace', PATH)]).toBeDefined()
  })

  it('非书签文件：完全不碰书签 IPC，走文本打开', async () => {
    workspaceFixture()
    const PATH = 'src/foo.ts'
    const readBookmark = vi.spyOn(api.files, 'readBookmark')
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
    vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
    vi.spyOn(api.files, 'read').mockResolvedValue({
      status: 'read',
      document: { path: PATH, content: 'export const x = 1\n', revision: 'r1' }
    })

    await useAppStore.getState().openFile(PATH, undefined, undefined, 'workspace')

    expect(readBookmark).not.toHaveBeenCalled()
    expect(useAppStore.getState().documents[documentKey('workspace', PATH)]).toBeDefined()
  })

  // T-004：「查看源码」——同一个 openFile 带 openAsText=true 就绕过书签→Browser 分支，回到文本路径（§2.6）。
  it('openAsText=true：绕过书签分支，把 .webloc 当文本开进 Monaco（看源码），不碰书签 IPC、不开 Browser', async () => {
    workspaceFixture()
    const PATH = 'links/Example.webloc'
    // 若 openAsText 没绕过分支，readBookmark 会被调、Browser 会开——这两个 spy 就会翻红（变异判据）。
    const readBookmark = vi.spyOn(api.files, 'readBookmark').mockResolvedValue({
      url: 'https://example.com/',
      binary: false
    })
    const browserCreate = vi.spyOn(api.browser, 'create')
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
    vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
    const filesRead = vi.spyOn(api.files, 'read').mockResolvedValue({
      status: 'read',
      document: { path: PATH, content: '<?xml version="1.0"?>\n', revision: 'r1' }
    })

    await useAppStore.getState().openFile(PATH, undefined, undefined, 'workspace', true)

    expect(readBookmark).not.toHaveBeenCalled()
    expect(browserCreate).not.toHaveBeenCalled()
    // 看到的是文件本身的源码：走文本路径、document 落地。
    expect(filesRead).toHaveBeenCalledWith('workspace', PATH)
    expect(useAppStore.getState().documents[documentKey('workspace', PATH)]).toBeDefined()
  })

  // 默认打开时书签来历（含 binary）要挂到 Browser 面上——「查看源码」按钮显示与灰不灰全靠它。
  it('默认开 Browser 时把 bookmarkOrigin（path+binary）挂到 browser 面上', async () => {
    workspaceFixture()
    const PATH = 'links/Example.webloc'
    vi.spyOn(api.files, 'readBookmark').mockResolvedValue({ url: 'https://example.com/', binary: true })

    await useAppStore.getState().openFile(PATH, undefined, undefined, 'workspace')

    const tabs = Object.values(useAppStore.getState().tabs)
    const surfaces = tabs.flatMap((tab) => Object.values(tab.regions))
    const browser = surfaces.find((surface) => surface.kind === 'browser')
    expect(browser?.kind === 'browser' ? browser.bookmarkOrigin : undefined).toEqual({
      path: PATH,
      binary: true
    })
  })
})
