import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { CONFIG_VERSION, SCRATCH_WORKSPACE_ID, type AppConfig } from '../src/shared/contracts.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { documentKey, fileTabId } from '../src/renderer/src/lib/workbench-tabs.js'
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore } from '../src/renderer/src/store.js'

// ---------------------------------------------------------------------------
// 每个被 `observe` 的文件都必须在它的 Tab 消失时被 `unobserve` —— 否则 Main 侧那个
// 每观察一个文件就 spawn 一个的子进程永不退出。leak 的度量单位不是「内部标志」而是
// 「observe 与 unobserve 的调用是否配平」：注册表按 `${workspaceId}\0${path}` 记账、
// 不做引用计数，所以一个被观察却从不 unobserve 的 key 就是一个泄漏的子进程。
//
// 这里驱动的是**移除 workspace**这条路：删 host 连带删掉它上面的全部 workspace（HostSettingsPane
// 的 filter → setConfig），删项目删掉一整组。这些写入都经 `adoptedConfig`，它只写
// `{config, activeWorkspaceId}`，既不动 `tabs` 也不发一次 `unobserve`。于是被移除的
// workspace 的文件 Tab 连同它们的观察者一起被留下，直到 app 退出。
// ---------------------------------------------------------------------------

function config(): AppConfig {
  return {
    version: CONFIG_VERSION,
    hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
    executors: {},
    workspaces: [
      { id: 'project-a', name: 'A', hostId: 'local', path: '/a', kind: 'folder' },
      { id: SCRATCH_WORKSPACE_ID, name: 'Scratch', hostId: 'local', path: '/scratch', kind: 'folder' }
    ],
    appearance: { terminalTheme: 'graphite' },
    browser: {
      toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true }
    }
  }
}

const PATH = 'src/leaked.ts'
const KEY = documentKey('project-a', PATH)

const initialState = useAppStore.getState()

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

async function openFileInProjectA(): Promise<void> {
  vi.spyOn(api.files, 'read').mockResolvedValue({
    status: 'read',
    document: { path: PATH, content: 'body', revision: 'r1' }
  } as never)
  useAppStore.setState({
    config: config(),
    activeWorkspaceId: 'project-a',
    layouts: { 'project-a': createWorkspaceLayout('pane') },
    documents: {},
    tabs: {}
  })
  await useAppStore.getState().openFile(PATH, undefined, undefined, 'project-a')
}

describe('removing a workspace disposes its file observers', () => {
  it('closing the tab normally unobserves — the control that pins the leak to removal', async () => {
    const unobserve = vi.spyOn(api.files, 'unobserve')

    await openFileInProjectA()
    expect(useAppStore.getState().documents[KEY], 'file did not open — the rest is vacuous').toBeTruthy()

    // 正常关 Tab 走 disposeClosedFileOwners，它应当把这个 key 撤掉。这一条证明「配平」这条路本身是通的，
    // 于是移除路那条红不是「整个机制都没接」的假象，而是恰好这一条出口漏了。
    await useAppStore.getState().closeTab('project-a', 'pane', fileTabId('project-a', PATH))
    await Promise.resolve()

    expect(
      unobserve.mock.calls,
      'even the normal tab-close path never unobserved — the test harness is not exercising disposal'
    ).toContainEqual(['project-a', PATH])
  })

  it('unobserves an open file when its workspace is dropped from config', async () => {
    const observe = vi.spyOn(api.files, 'observe')
    const unobserve = vi.spyOn(api.files, 'unobserve')

    await openFileInProjectA()

    // 前提自检：Tab 真的开起来了，且它的观察者真的注册了。否则下面的「应被撤销」恒真。
    expect(useAppStore.getState().documents[KEY], 'file did not open — the rest is vacuous').toBeTruthy()
    expect(observe, 'the open never registered an observer — nothing to leak').toHaveBeenCalledWith('project-a', PATH)

    // 删掉 project-a（删 host / 删项目的形状）：config 里只剩 Scratch。
    const next: AppConfig = {
      ...config(),
      workspaces: config().workspaces.filter((workspace) => workspace.id !== 'project-a')
    }
    useAppStore.getState().setConfig(next)
    // setConfig 后可能有异步收尾，给它一轮微任务。
    await Promise.resolve()

    expect(
      unobserve.mock.calls,
      'the removed workspace kept its file observer alive: Main leaks that subprocess until app quit'
    ).toContainEqual(['project-a', PATH])
  })
})
