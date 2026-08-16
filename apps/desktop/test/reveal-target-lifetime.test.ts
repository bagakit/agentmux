import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AppConfig } from '../src/shared/contracts.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { documentKey } from '../src/renderer/src/lib/workbench-tabs.js'
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore } from '../src/renderer/src/store.js'

// ---------------------------------------------------------------------------
// 「跳到第 N 行」这件事是**一次性**的，而它的存放位置会被复用。
//
// 缺陷形状：`openFile` 在 try 之前就把 reveal target 写进 `documentRevealTargets[key]`
// （store.ts:2828-2830，注释说明了为什么要先写：已开着的文件重点一次链接也要重新跳）。
// 但那之后有四个失败出口，没有一个清它：
//
//   1. 点到的是目录            → `return false`
//   2. 读失败/文件已删          → throw → catch → reportError
//   3. lifetime 作废（tab 关了）→ `return false`
//   4. layout 没了（workspace 撤了）→ `return false`
//
// 而 key 是 `documentKey(workspaceId, path)` = `ws\0path`——**确定性的，会复用**。
// （草稿表那族的 key 是 UUID，所以那族只会涨内存不会串味；这条不一样。）
// 于是陈旧 target 会被**下一次同路径的成功打开**消费掉：用户从文件树点开 foo.ts，
// 没要求任何行号，光标却自己跳到上一次那条失败链接里的第 42 行。
//
// 判据落在「下一次打开会不会跳」这个**行为**上，而不是「某个出口调了清理函数」：
// 四个出口各补一次清理必然漂移（记忆 two-write-sites-need-one-projection），而且新
// 增第五个出口时没人会想起来。实现侧的修法是给 target 绑上写入时刻的 lifetime，消费
// 侧比对——一处判据，出口数无关。
// ---------------------------------------------------------------------------

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

const PATH = 'src/foo.ts'
const KEY = documentKey('workspace', PATH)

/** 一次真能读出来的文件。第二次打开走这条，用来观察「有没有跳」。 */
function fileThatReadsFine(): void {
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined as never)
  vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined as never)
  vi.spyOn(api.files, 'read').mockResolvedValue({
    status: 'read',
    document: {
      workspaceId: 'workspace',
      path: PATH,
      text: 'line1\nline2\nline3\n',
      encoding: 'utf8',
      eol: '\n',
      revision: 1,
      readAt: 1
    }
  } as never)
}

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

describe('失败的打开不许把「跳到某行」留给下一次', () => {
  it('前提自检：成功打开带行号时，target 确实被写下来了（否则下面几条恒真）', async () => {
    workspaceFixture()
    fileThatReadsFine()

    await useAppStore.getState().openFile(PATH, undefined, { line: 42 }, 'workspace')

    // 这一条是**在场证明**：如果 openFile 根本不写 target，下面每一条「不许留下」都会
    // 因为「本来就没有」而绿，整族与被测的事实无关。
    expect(
      useAppStore.getState().documentRevealTargets[KEY],
      'openFile 没有写下 reveal target——下面几条都失去意义'
    ).toEqual({ line: 42 })
  })

  it('点到的是目录：不留 target，之后打开同名文件不跳', async () => {
    workspaceFixture()
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined as never)
    vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined as never)
    vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'directory' } as never)
    vi.spyOn(api.files, 'readDirectory').mockResolvedValue({ entries: [] } as never)

    await useAppStore.getState().openFile(PATH, undefined, { line: 42 }, 'workspace')

    expect(
      useAppStore.getState().documentRevealTargets[KEY],
      '目录分支留下了 target：下次真打开这个路径，光标会跳到用户没要求的第 42 行'
    ).toBeUndefined()
  })

  it('读失败：不留 target', async () => {
    workspaceFixture()
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined as never)
    vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined as never)
    vi.spyOn(api.files, 'read').mockResolvedValue({
      status: 'deleted'
    } as never)

    await useAppStore.getState().openFile(PATH, undefined, { line: 42 }, 'workspace')

    expect(
      useAppStore.getState().documentRevealTargets[KEY],
      '读失败留下了 target：这条路径正是 `foo.ts:42` 链接指向一个已删文件的形状'
    ).toBeUndefined()
  })

  it('等待期间 Workspace 的 layout 没了：不留 target', async () => {
    // 第四个出口。前三个是「读的结果不对」，这个是「读回来时落点已经没了」——用户在等待期间
    // 从设置里撤掉了这个项目，或者切换过程中 layout 被重建。
    workspaceFixture()
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined as never)
    vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined as never)
    vi.spyOn(api.files, 'read').mockImplementation(async () => {
      // 在读返回之前把这个 Workspace 的 layout 撤掉。
      useAppStore.setState({ layouts: {} })
      return {
        status: 'read',
        document: {
          workspaceId: 'workspace',
          path: PATH,
          text: 'x\n',
          encoding: 'utf8',
          eol: '\n',
          revision: 1,
          readAt: 1
        }
      } as never
    })

    await useAppStore.getState().openFile(PATH, undefined, { line: 42 }, 'workspace')

    // 前提自检：这次确实**没有**文档落地（走的是失败出口）。落地了的话这条判据测的是成功
    // 路径，与被测的失败出口无关——那时它恒真。
    expect(
      useAppStore.getState().documents[KEY],
      '前提自检：文档还是落地了，这一条没走到 layout 消失那个出口'
    ).toBeFalsy()
    expect(
      useAppStore.getState().documentRevealTargets[KEY],
      '没有文档落地却留下了 target：下次打开会跳到陈旧的行'
    ).toBeUndefined()
  })

  it('失败之后再成功打开同一路径：光标不跳到上次那条链接的行', async () => {
    // 这是整族的**总判据**，也是用户真正会遇到的那一幕：一次失败的 `foo.ts:42` 点击，
    // 之后从文件树打开 foo.ts（不带任何行号），光标必须停在文件开头。
    workspaceFixture()
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined as never)
    vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined as never)
    const read = vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'directory' } as never)
    vi.spyOn(api.files, 'readDirectory').mockResolvedValue({ entries: [] } as never)

    await useAppStore.getState().openFile(PATH, undefined, { line: 42 }, 'workspace')

    // 第二次：同一路径，这次读得出来，且**不带 location**。
    read.mockResolvedValue({
      status: 'read',
      document: {
        workspaceId: 'workspace',
        path: PATH,
        text: 'line1\nline2\nline3\n',
        encoding: 'utf8',
        eol: '\n',
        revision: 1,
        readAt: 2
      }
    } as never)

    await useAppStore.getState().openFile(PATH, undefined, undefined, 'workspace')

    expect(
      useAppStore.getState().documents[KEY],
      '前提自检：第二次打开没成功，这条判据与陈旧 target 无关了'
    ).toBeTruthy()
    expect(
      useAppStore.getState().documentRevealTargets[KEY],
      '第二次打开没要求任何行号，却带着上一次失败留下的 target：EditorPane 挂载时会把光标跳走'
    ).toBeUndefined()
  })
})
