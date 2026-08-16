import { afterEach, describe, expect, it, vi } from 'vitest'

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
  })

  it('about:blank 没地址可存：如实抛，不写文件', async () => {
    const write = vi.spyOn(api.files, 'write')

    await expect(
      useAppStore.getState().saveBrowserBookmark('workspace', 'about:blank', 'New Tab')
    ).rejects.toThrow(/no address/i)

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
    ).rejects.toThrow('permission denied')
  })
})
