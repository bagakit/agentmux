import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { subscribeWhileOpen } from '../src/renderer/src/lib/resource-usage-panel.js'
import type { UsageSnapshot } from '../src/shared/contracts.js'

/**
 * 折叠态零采样。
 *
 * 这是 T-004 的首要约束，也是这个功能最容易悄悄退化的一条：把订阅从「面板打开时」挪到
 * 「组件挂载时」，或者动一下 useEffect 的依赖数组，代码看着都对、测试全绿，只有用户的电池
 * 会变短——一个常驻的全主机 `ps` 轮询不会让任何断言变红。
 *
 * 两头夹才夹得住：
 *   1. 采样器那头（process-resource-sampler.test.ts）断言没有订阅者时定时器不存在；
 *   2. 这里断言 UI 关着的时候根本不去订阅，关上时退订真的被调用。
 * 少任何一头，另一头都能被绕过——采样器再省电，UI 一挂载就订阅也是白搭。
 */

const fixture = vi.hoisted(() => ({
  subscribe: vi.fn(() => vi.fn()),
  sessions: [] as unknown[]
}))

vi.mock('../src/renderer/src/lib/api.js', () => ({
  api: { resourceUsage: { subscribe: fixture.subscribe } }
}))

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: (selector: (state: { sessions: unknown[] }) => unknown) =>
    selector({ sessions: fixture.sessions })
}))

import { ResourceUsagePanel } from '../src/renderer/src/components/ResourceUsagePanel.js'

const panelSource = readFileSync(
  new URL('../src/renderer/src/components/ResourceUsagePanel.tsx', import.meta.url),
  'utf8'
)

beforeEach(() => {
  fixture.subscribe.mockClear()
})

describe('订阅只在面板打开期间存在', () => {
  it('关着时不订阅，一次都不调', () => {
    const subscribe = vi.fn(() => vi.fn())
    const onSnapshot = vi.fn()
    const cleanup = subscribeWhileOpen(false, subscribe, onSnapshot)
    // 这一条就是本 task 的首要约束：折叠态零采样。
    expect(subscribe).not.toHaveBeenCalled()
    // 没有订阅就没有要清理的东西——返回一个假的 cleanup 会让 React 每次都白跑一趟。
    expect(cleanup).toBeUndefined()
  })

  it('关着时把上一帧清掉，再打开不会先闪一个过期的数字', () => {
    const onSnapshot = vi.fn()
    subscribeWhileOpen(false, vi.fn(() => vi.fn()), onSnapshot)
    expect(onSnapshot).toHaveBeenCalledWith(null)
  })

  it('打开时订阅一次，并把退订原样交回去', () => {
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(() => unsubscribe)
    const onSnapshot = vi.fn()
    const cleanup = subscribeWhileOpen(true, subscribe, onSnapshot)
    expect(subscribe).toHaveBeenCalledTimes(1)
    // 订阅拿到的就是 setSnapshot 本身，中间不再包一层——包一层就有机会漏掉退订。
    expect(subscribe).toHaveBeenCalledWith(onSnapshot)
    expect(cleanup).toBe(unsubscribe)
    // 关上时 React 调这个 cleanup，采样器那头的最后一个订阅者就走了，定时器随之停掉。
    cleanup?.()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('打开时不清帧——清了会把刚到的第一帧盖掉', () => {
    const onSnapshot = vi.fn()
    subscribeWhileOpen(true, vi.fn(() => vi.fn()), onSnapshot)
    expect(onSnapshot).not.toHaveBeenCalled()
  })

  it('订阅推来的快照原样交给回调', () => {
    const onSnapshot = vi.fn()
    let push: ((snapshot: UsageSnapshot) => void) | null = null
    subscribeWhileOpen(true, (listener) => { push = listener; return vi.fn() }, onSnapshot)
    const snapshot: UsageSnapshot = { observedAt: 1, runs: [], app: null, unavailable: null }
    push!(snapshot)
    expect(onSnapshot).toHaveBeenCalledWith(snapshot)
  })
})

describe('面板把订阅生命周期绑在 open 上，而不是挂载上', () => {
  it('effect 依赖 open，且订阅只经由 subscribeWhileOpen', () => {
    // 直接读源码，是因为这个仓库的测试用 renderToStaticMarkup，不跑 effect——退化恰恰发生在
    // effect 里，没有断言够得着。绑在挂载上（依赖数组为空）或绕过这个函数直接订阅都会红。
    expect(panelSource).toContain('subscribeWhileOpen(open, api.resourceUsage.subscribe, setSnapshot)')
    expect(panelSource).toContain('[open]')
    // 组件里不许再有第二处订阅。
    expect(panelSource.match(/api\.resourceUsage\.subscribe/gu)).toHaveLength(1)
  })

  it('折叠态渲染出来只是一枚按钮，不渲染任何读数', () => {
    const markup = renderToStaticMarkup(createElement(ResourceUsagePanel))
    // 连 "Sampling…" 的空态都不该出现——出现就说明它已经在等数了。
    expect(markup).not.toContain('resource-usage__list')
    expect(markup).not.toContain('Sampling')
    expect(markup).toContain('aria-label="Show CPU and memory use per agent"')
    // 渲染路径上也没有同步订阅。
    expect(fixture.subscribe).not.toHaveBeenCalled()
  })
})
