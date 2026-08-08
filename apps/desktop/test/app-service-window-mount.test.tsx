// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
// Canvas rendering is covered by native probes; this test owns the App service-window wiring.
vi.mock('../src/renderer/src/components/TerminalView.js', () => ({ TerminalView: () => null }))
import { App } from '../src/renderer/src/App.js'
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore } from '../src/renderer/src/store.js'
import type { RuntimeEvent, RuntimeSnapshot } from '../src/shared/contracts.js'

/**
 * 两块服务窗（Runtime 归属 / 本机 shell 环境）**真的挂在窗口上**，且 Runtime 那块的两个写入点都能把
 * 它点亮。
 *
 * 为什么这个文件必须存在，而 `runtime-ownership-notice.test.tsx` / `shell-environment-notice.test.tsx`
 * 不够：那两个文件渲染的是**裸组件**，`root.render(<RuntimeOwnershipNotice />)`。于是「App.tsx 里那行
 * `<RuntimeOwnershipNotice />` 被删掉」这个变异对它们完全隐身——组件本身照样正确地把 store 投影成告示，
 * 只是全窗口没有任何人渲染它，用户永远看不到。实测：删掉 App.tsx 里任一行，那两个 suite 全绿。
 *
 * 同理，那两个文件只驱动 `initialize`，所以 `runtimeOwnershipWarnings` 的**第二个**写入点——
 * `startSessionMembershipResync` 里那句 `runtimeOwnershipWarnings: snapshot.runtimeOwnershipWarnings ?? []`
 * ——可以被改成恒 `[]` 而无人发现。那不是可有可无的一路：daemon 的启动凭据在**运行期**才不可核实时
 * （连上了一个别人起的兼容 daemon），只有 resync 这条路会把它带进 store；initialize 那条路早就跑完了。
 * 两个写入点写同一个字段、只有一个被钉住，正是「两个写入点要收成一处投影」那一族的活样本。
 *
 * 所以这里挂**真的 `<App />`**、配**真的 store**（happy-dom + `act`，effect 真跑），两半各一条：
 *  1. initialize 侧：两块告示都出现在 `main.main-shell` 里，且各自说的是自己那件事。
 *  2. resync 侧：initialize 时干净（无告示），随后一条指向未知 Agent 的事件触发成员重同步，重同步读到的
 *     快照带上归属警告，界面上就得亮起来。
 */

const initial = useAppStore.getState()
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

let mounted: { root: Root; element: HTMLElement } | null = null
afterEach(async () => {
  if (mounted) {
    const { root, element } = mounted
    mounted = null
    await act(async () => { root.unmount() })
    element.remove()
  }
  vi.restoreAllMocks()
  useAppStore.setState(initial, true)
})

function emptySnapshot(): RuntimeSnapshot {
  return { sessions: [], timelines: {}, recoveryCandidates: [] }
}

/** 一条指向 store 里不存在的 Agent 的事件——`projectRuntimeEvent` 唯一的 `sessionMembershipGap` 生产条件。 */
function unknownAgentEvent(): RuntimeEvent {
  return {
    type: 'core',
    hostId: 'local',
    event: {
      type: 'agent-status',
      agentSessionId: 'agent-not-in-store',
      state: 'working',
      evidence: { source: 'native-hook', observedAt: 1 }
    }
  }
}

/**
 * 挂真 App 并等它走完启动。
 *
 * 不手工调 `initialize()`：App 自己的 effect 就是被守的接线之一，替它调等于把那条路也换成替身。等待条件
 * 用 `loading` 落下而不是固定轮数——`loading` 为真时 App 渲染的是启动屏，`main.main-shell` 连同两块告示
 * 都还不在树上，断言会对着启动屏空跑。
 */
async function mountApp(): Promise<HTMLElement> {
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  mounted = { root, element }
  await act(async () => { root.render(<App />) })
  for (let attempt = 0; attempt < 50 && useAppStore.getState().loading; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }
  // 自检：启动没走完的话下面每一条「告示不在」都会恒真地通过。
  expect(useAppStore.getState().loading, 'App 仍停在启动屏，后面的告示断言全部不可观测').toBe(false)
  expect(element.querySelector('main.main-shell'), '主壳没挂出来').not.toBeNull()
  return element
}

/** 窗口上那一组服务窗的标题行。告示形态同构（都是 `.service-window`），所以按标题区分是哪一块。 */
function serviceWindowSteps(element: HTMLElement): string[] {
  return [...element.querySelectorAll('main.main-shell .service-window')]
    .map((notice) => notice.querySelector('.service-window__step')?.textContent ?? '')
}

describe('窗口把两块服务窗真的挂了出来', () => {
  it('initialize 读到的归属警告与 shell 环境警告，各自在主壳里亮成一块告示', async () => {
    vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({
      ...emptySnapshot(),
      runtimeOwnershipWarnings: ['local'],
      environmentWarning: 'Your login shell did not export PATH; terminals may not find your tools.'
    })

    const element = await mountApp()

    // 两块都要在，且**各说各的那件事**：只断言「有两块告示」会被同一块渲染两次满足，而把 App.tsx 里
    // 两行换成同一个组件正是最像的手滑。
    expect(serviceWindowSteps(element)).toEqual([
      'Local shell environment is incomplete',
      'Runtime launch record is unavailable'
    ])
    expect(
      element.querySelector('main.main-shell')?.textContent,
      'Runtime 归属告示没挂在窗口上——组件自己是对的，只是没人渲染它'
    ).toContain('Existing Agents remain usable')
    expect(
      element.querySelector('main.main-shell')?.textContent,
      'shell 环境告示没挂在窗口上'
    ).toContain('Your login shell did not export PATH')
  })

  it('没有警告时主壳里一块告示都没有（证上一条不是恒真）', async () => {
    vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue(emptySnapshot())

    const element = await mountApp()

    expect(serviceWindowSteps(element), '无警告时窗口上凭空挂了服务窗').toEqual([])
  })
})

describe('成员重同步这条路也能点亮归属告示', () => {
  it('启动时干净、随后重同步读到警告，窗口上就亮起来', async () => {
    vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    const snapshot = vi.spyOn(api.sessions, 'snapshot')
      // 启动这一次干净：于是下面亮起来的那块**只能**来自 resync 的写入，不可能是 initialize 那句留下的。
      .mockResolvedValueOnce(emptySnapshot())
      .mockResolvedValue({ ...emptySnapshot(), runtimeOwnershipWarnings: ['studio'] })

    const element = await mountApp()
    expect(serviceWindowSteps(element), '启动快照没有警告，却已经亮了告示').toEqual([])
    expect(snapshot).toHaveBeenCalledTimes(1)

    // 一条指向未知 Agent 的事件 → projectRuntimeEvent 报成员缺口 → startSessionMembershipResync 重读快照。
    await act(async () => {
      useAppStore.getState().applyEvent(unknownAgentEvent())
      // resync 是 fire-and-forget 的 async，让出一个 macrotask 让它跑完；只泵 microtask 的话
      // 缺陷（写入点被改成恒 []）与修好都同样「还没写」，断言测不出差别。
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // 自检：重同步真的发生了。没发生的话下面那条断言测的是「事件根本没触发重读」，与写入点无关。
    expect(snapshot, '成员缺口没有触发重同步——下面的断言测不到写入点').toHaveBeenCalledTimes(2)
    expect(
      useAppStore.getState().runtimeOwnershipWarnings,
      '重同步读到了归属警告却没写进 store（只有 initialize 那侧写了）'
    ).toEqual(['studio'])
    expect(serviceWindowSteps(element)).toEqual(['Runtime launch record is unavailable'])
    expect(
      element.querySelector('main.main-shell')?.textContent,
      '重同步点亮的告示没有出现在窗口上'
    ).toContain('Connected to the compatible Runtime on studio')
  })
})
