// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('../src/renderer/src/components/TerminalView.js', () => ({ TerminalView: () => null }))
import { App } from '../src/renderer/src/App.js'
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore } from '../src/renderer/src/store.js'

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
  window.history.replaceState({}, '', '/')
})

describe('renderer-update ready handshake', () => {
  // 行为 spec: initialize() 挂住时(mock 成永不 resolve 的 Promise),cold-start token 的 ready
  // 报告仍要发出。此外 ready 只发一次——App.tsx 曾经同时通过独立 useEffect 和 beginRendererStartup
  // 的 announceReady 各发一次(1b4fdabb 独立 fix + 后来加的 startup helper),test 抓到 double-fire。
  // 现在只有 beginRendererStartup 一处 fire,`toEqual([['token']])` 精确匹配一次调用。
  //
  // 曾有另一条源码扫描 test grep 过 `void initialize().then` 结构,peer 把 startup 拆成
  // beginRendererStartup helper 后那条 grep 找不到锚点,是 [[indexof-anchor-gone-slices-to-empty-string]]
  // 那族的失效守卫。删掉——本条 mock-initialize-then-check-ready 已直接钉住行为。
  it('reports ready exactly once while Session recovery is still running', async () => {
    const ready = vi.spyOn(api.ui, 'rendererUpdateReady').mockResolvedValue(undefined)
    useAppStore.setState({
      initialize: () => new Promise(() => {})
    })
    window.history.replaceState({}, '', '/index.html?renderer-update=token-cold-start')
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    mounted = { root, element }
    await act(async () => { root.render(<App />) })
    expect(ready.mock.calls).toEqual([['token-cold-start']])
  })
})
