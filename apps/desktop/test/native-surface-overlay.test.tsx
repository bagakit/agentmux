// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as ContextMenu from '@radix-ui/react-context-menu'
import * as Dialog from '@radix-ui/react-dialog'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as HoverMenu from '../src/renderer/src/components/HoverDropdownMenu'
import { isOverlayNode, observeOverlays, openOverlayCount } from '../src/renderer/src/lib/native-surface-overlay'
import { WindowOverlayHost, WindowOverlayPortal } from '../src/renderer/src/components/WindowOverlayHost'

/**
 * 「弹窗经常被浏览器挡了」的判据。
 *
 * 窗口级原生视图（Browser 的 WebContentsView）合成在**所有 renderer 像素之上**，所以任何画在
 * DOM 里的浮层都会被它盖住，与 z-index 无关。出路是把原生视图藏起来，而判据必须回答
 * 「现在有没有浮层开着」。
 *
 * 这个文件**跑真的 Radix**，不是手搓 DOM：整条机制押在一个外部库的 DOM 契约上（portal 到
 * React 根之外 + `data-state="open"`），而那正是最该被验证、也最可能随升级漂走的一件事。
 * 拿自造的 fixture 测只能证明"我的选择器匹配我自己造的形状"——那什么都没证明
 * （记忆 frozen-fake-hides-the-property）。
 */

function mountAppRoot(): HTMLElement {
  const host = document.createElement('div')
  host.id = 'root'
  document.body.append(host)
  return host
}

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const host = mountAppRoot()
  const root = createRoot(host)
  await act(async () => { root.render(node) })
  return host
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  document.body.innerHTML = ''
})

describe('真 Radix：开着的浮层被数到，React 根不被数到', () => {
  it('打开的 Dialog 计为 1', async () => {
    // 这条就是用户报的那个缺陷的正面判据：Dialog 是被挡得最明显的一类（居中、必然压在页面上）。
    await render(
      <Dialog.Root open>
        <Dialog.Portal>
          <Dialog.Content aria-describedby={undefined}><Dialog.Title>t</Dialog.Title></Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    )
    expect(openOverlayCount(document.body)).toBe(1)
  })

  it('关着的 Dialog 计为 0——原生视图必须回来', async () => {
    // 反向的一半。只测"开着时藏起来"会放过"关了之后再也不回来"，那是一块永久空白的浏览器格，
    // 比被挡住更糟。
    await render(
      <Dialog.Root open={false}>
        <Dialog.Portal>
          <Dialog.Content aria-describedby={undefined}><Dialog.Title>t</Dialog.Title></Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    )
    expect(openOverlayCount(document.body)).toBe(0)
  })

  it('另一族原语（DropdownMenu）同样被数到，不是只认 Dialog', async () => {
    // 原则 13：规则依赖的是所有 Radix 原语共用的那条 DOM 协议，不是某一个组件的形状。
    // 只测 Dialog 会过拟合——而右键菜单/下拉正是数量最多的那一类。
    await render(
      <DropdownMenu.Root open>
        <DropdownMenu.Trigger>x</DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content><DropdownMenu.Item>i</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root>
    )
    expect(openOverlayCount(document.body)).toBe(1)
  })

  it('只挂了 React 根、没有任何浮层时计为 0', async () => {
    await render(<div>plain</div>)
    expect(openOverlayCount(document.body)).toBe(0)
  })

  it('ContextMenu（#544 那个菜单）同样被数到', async () => {
    // 这一条接着 #544 的历史：Region 右键菜单是**唯一一个从来没接上让位开关**的菜单，而它正是
    // 被浏览器盖住的那个。逐个接线的机制在这里漏了一个；协议判据要证明它现在自动覆盖了。
    await render(
      <ContextMenu.Root open>
        <ContextMenu.Trigger>x</ContextMenu.Trigger>
        <ContextMenu.Portal><ContextMenu.Content><ContextMenu.Item>i</ContextMenu.Item></ContextMenu.Content></ContextMenu.Portal>
      </ContextMenu.Root>
    )
    expect(openOverlayCount(document.body)).toBe(1)
  })

  it('本仓自己那层 HoverDropdownMenu 适配器也被数到', async () => {
    // 不能从"它 re-export 了 Radix 的 Portal"推断出这一条。那层适配器包了自己的 Root 与 Content，
    // 而承重的是**渲染出来的 DOM 长什么样**，不是 import 关系（记忆
    // import-relation-buys-presence-not-use）。Tab 条上的 Split 下拉走的就是这一层——
    // 删掉它手写的让位开关之前，必须先证明协议判据确实看得见它。
    const hostEl = document.createElement('div')
    hostEl.className = 'window-overlay-host'
    hostEl.dataset.overlayHost = ''
    document.body.append(hostEl)

    await render(
      <HoverMenu.Root open>
        <HoverMenu.Trigger>x</HoverMenu.Trigger>
        <HoverMenu.Portal><HoverMenu.Content><HoverMenu.Item>i</HoverMenu.Item></HoverMenu.Content></HoverMenu.Portal>
      </HoverMenu.Root>
    )
    expect(
      openOverlayCount(document.body),
      'HoverDropdownMenu 渲染出的浮层没有被协议判据数到——它的手写让位开关还不能删'
    ).toBe(1)
  })

  it('叠起来的两个浮层计为 2', async () => {
    // 计数而不是布尔的理由：对话框里开一个下拉，关掉下拉时布尔会立刻把原生视图放回来，
    // 而对话框还开着——它会被盖住，正是这个缺陷本身。
    await render(
      <>
        <Dialog.Root open>
          <Dialog.Portal><Dialog.Content aria-describedby={undefined}><Dialog.Title>a</Dialog.Title></Dialog.Content></Dialog.Portal>
        </Dialog.Root>
        <DropdownMenu.Root open>
          <DropdownMenu.Trigger>x</DropdownMenu.Trigger>
          <DropdownMenu.Portal><DropdownMenu.Content><DropdownMenu.Item>i</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>
      </>
    )
    expect(openOverlayCount(document.body)).toBe(2)
  })

  it('自证：真 Radix 确实把内容 portal 到了 React 根之外', async () => {
    // 整条机制押在这个前提上。若哪天 Radix 改成挂在触发器旁边（或 happy-dom 不再执行 portal），
    // 上面每一条都会安静地数到 0 而这个文件仍然"全绿"——因为 0 既是"没有浮层"也是"扫到空"。
    // 这一条把前提本身钉死。
    await render(
      <Dialog.Root open>
        <Dialog.Portal><Dialog.Content aria-describedby={undefined}><Dialog.Title>t</Dialog.Title></Dialog.Content></Dialog.Portal>
      </Dialog.Root>
    )
    const outside = [...document.body.children].filter((child) => child.id !== 'root')
    expect(outside.length, 'Radix 没有把内容 portal 到 React 根之外——这条机制的前提不成立').toBeGreaterThan(0)
    expect(
      outside.some((child) => isOverlayNode(child)),
      'portal 出去的节点里没有一个带 data-state="open"——判据找不到它要找的东西'
    ).toBe(true)
  })

  it('WindowOverlayHost 在 React 根内声明时，自动挂载到 React 根之外（document.body）', async () => {
    await render(<WindowOverlayHost />)
    const hostNode = document.body.querySelector('[data-overlay-host]')
    expect(hostNode, 'WindowOverlayHost 必须在 DOM 中渲染').toBeTruthy()
    expect(hostNode?.parentElement).toBe(document.body)
    expect(
      hostNode?.closest('#root'),
      'WindowOverlayHost 不得作为 #root 的内部节点，否则 observeOverlays 会忽略它'
    ).toBeNull()
  })

  it('挂载在 WindowOverlayHost 上的打开菜单计为 1', async () => {
    const hostEl = document.createElement('div')
    hostEl.className = 'window-overlay-host'
    hostEl.dataset.overlayHost = ''
    document.body.append(hostEl)

    await render(
      <HoverMenu.Root open>
        <HoverMenu.Trigger>x</HoverMenu.Trigger>
        <HoverMenu.Portal>
          <HoverMenu.Content>
            <HoverMenu.Item>item 1</HoverMenu.Item>
          </HoverMenu.Content>
        </HoverMenu.Portal>
      </HoverMenu.Root>
    )
    expect(openOverlayCount(document.body)).toBe(1)
  })

  it('嵌套菜单在 WindowOverlayHost 中保持持有让位租约', async () => {
    await render(
      <>
        <WindowOverlayHost />
        <DropdownMenu.Root open>
          <DropdownMenu.Trigger>Trigger</DropdownMenu.Trigger>
          <DropdownMenu.Portal container={document.body.querySelector<HTMLElement>('[data-overlay-host]')}>
            <DropdownMenu.Content data-state="open">
              <DropdownMenu.Item>First</DropdownMenu.Item>
              <DropdownMenu.Sub open>
                <DropdownMenu.SubTrigger>More</DropdownMenu.SubTrigger>
                <DropdownMenu.Portal container={document.body.querySelector<HTMLElement>('[data-overlay-host]')}>
                  <DropdownMenu.SubContent data-state="open">
                    <DropdownMenu.Item>Sub Item</DropdownMenu.Item>
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </>
    )
    expect(openOverlayCount(document.body)).toBeGreaterThan(0)
  })

  it('Tooltip 在 WindowOverlayHost 中处于 open 状态时参与让位，关闭后归零', async () => {
    function TooltipFixture({ open }: { open: boolean }) {
      return (
        <>
          <WindowOverlayHost />
          {open ? (
            <WindowOverlayPortal layer="tooltip">
              <span role="tooltip" data-state="open" className="surface-navigation__tooltip">
                Tooltip
              </span>
            </WindowOverlayPortal>
          ) : null}
        </>
      )
    }

    const host = mountAppRoot()
    const root = createRoot(host)
    await act(async () => {
      root.render(<TooltipFixture open={true} />)
    })
    expect(openOverlayCount(document.body), '打开的 tooltip 必须持有让位租约').toBe(1)

    await act(async () => {
      root.render(<TooltipFixture open={false} />)
    })
    expect(openOverlayCount(document.body), '关闭的 tooltip 必须释放让位租约').toBe(0)
  })
})

describe('isOverlayNode：逐条判据', () => {
  it('React 根永远不算浮层', () => {
    const root = document.createElement('div')
    root.id = 'root'
    root.setAttribute('data-state', 'open')
    // 即使根上恰好有这个属性（应用里任何一个组件都可能用它）也不能算——否则原生视图永不显示。
    expect(isOverlayNode(root)).toBe(false)
  })

  it('data-state="closed" 不算——关闭动画期间不能继续占着原生视图', () => {
    // Radix 在退场动画期间留下 closed 节点。把它算进来，原生视图会在浮层已经看不见之后
    // 仍迟迟不回来，看起来就是"浏览器闪一下才出现"。
    const node = document.createElement('div')
    node.setAttribute('data-state', 'closed')
    expect(isOverlayNode(node)).toBe(false)
  })

  it('属性挂在后代上也算——Portal 容器本身是个裸 div', () => {
    // 这条是承重的：只看直接子节点会一个都数不到，而"数到 0"和"确实没有浮层"在计数上无法区分。
    const container = document.createElement('div')
    const content = document.createElement('div')
    content.setAttribute('data-state', 'open')
    container.append(content)
    expect(isOverlayNode(container)).toBe(true)
  })

  it('后代是 data-state="closed" 也不算——Portal 容器留在原地，内容正在退场', () => {
    // 上面那条只盖住了「属性直接挂在这个节点上」的一半。Radix 真实的形状是属性挂在**容器里面**，
    // 而退场动画期间容器还在、里面的 Content 变成 closed。把后代那条判据放宽成"有 data-state 就算"，
    // 上面那条照旧全绿（它测的节点没有后代），而原生视图会在浮层消失后迟迟不回来。
    const container = document.createElement('div')
    const content = document.createElement('div')
    content.setAttribute('data-state', 'closed')
    container.append(content)
    expect(isOverlayNode(container)).toBe(false)
  })

  it('既不是根、也没有 open 后代的节点不算', () => {
    const node = document.createElement('div')
    node.append(document.createElement('span'))
    expect(isOverlayNode(node)).toBe(false)
  })
})

describe('observeOverlays：变化被上报，且不重复上报', () => {
  /** 一个同步触发的 MutationObserver 替身——happy-dom 的真 observer 是微任务异步的。 */
  function syncObserver(): {
    ctor: typeof MutationObserver
    fire: () => void
    disconnected: () => boolean
    options: () => MutationObserverInit | undefined
  } {
    const callbacks: Array<(records: MutationRecord[]) => void> = []
    let disconnected = false
    let options: MutationObserverInit | undefined
    class Fake {
      constructor(callback: (records: MutationRecord[]) => void) { callbacks.push(callback) }
      observe(_target: Node, init?: MutationObserverInit): void { disconnected = false; options = init }
      disconnect(): void { disconnected = true }
      takeRecords(): [] { return [] }
    }
    return {
      ctor: Fake as unknown as typeof MutationObserver,
      fire: () => {
        for (const callback of callbacks) callback([{
          type: 'childList', target: document.body,
          addedNodes: document.createDocumentFragment().childNodes,
          removedNodes: document.createDocumentFragment().childNodes,
          previousSibling: null, nextSibling: null,
          attributeName: null, attributeNamespace: null, oldValue: null
        }])
      },
      disconnected: () => disconnected,
      options: () => options
    }
  }


  function overlay(): HTMLElement {
    const node = document.createElement('div')
    node.setAttribute('data-state', 'open')
    return node
  }

  it('订阅时立刻上报一次当前值', () => {
    // 订阅发生在挂载时，而浮层可能在那之前就开着（恢复出来的状态）。不立刻报一次，
    // 第一个浮层要等到下一次 DOM 变化才被看见。
    const report = vi.fn<(count: number) => void>()
    observeOverlays(document.body, report, syncObserver().ctor)
    expect(report.mock.calls).toEqual([[0]])
  })

  it('浮层出现后上报新的计数', () => {
    const report = vi.fn<(count: number) => void>()
    const observer = syncObserver()
    observeOverlays(document.body, report, observer.ctor)
    document.body.append(overlay())
    observer.fire()
    expect(report.mock.calls).toEqual([[0], [1]])
  })

  it('计数没变时不重复上报', () => {
    // Radix 打开一个浮层会触发好几次 mutation（插容器、挂内容、置 data-state）。每次都上报
    // 会让 store 连着 set 同一个值，把整棵树重渲染好几遍。
    const report = vi.fn<(count: number) => void>()
    const observer = syncObserver()
    observeOverlays(document.body, report, observer.ctor)
    document.body.append(overlay())
    observer.fire()
    observer.fire()
    observer.fire()
    expect(report.mock.calls).toEqual([[0], [1]])
  })

  it('浮层消失后报回 0——原生视图必须回来', () => {
    const report = vi.fn<(count: number) => void>()
    const observer = syncObserver()
    observeOverlays(document.body, report, observer.ctor)
    const node = overlay()
    document.body.append(node)
    observer.fire()
    node.remove()
    observer.fire()
    expect(report.mock.calls).toEqual([[0], [1], [0]])
  })

  it('取消订阅会断开观察器', () => {
    const observer = syncObserver()
    const stop = observeOverlays(document.body, vi.fn(), observer.ctor)
    stop()
    expect(observer.disconnected()).toBe(true)
  })

  it('真观察器：后代的 data-state 变化也要被听见', async () => {
    // 这一条跑**真的** MutationObserver，因为承重的是订阅选项而不是我们自己的计数逻辑：
    // `data-state` 挂在 Portal 容器**里面**的 Content 上，Radix 先插空容器、再往里挂内容。
    // 少了 `subtree: true`，第二步就听不见——容器插入那一刻里面还什么都没有，永远停在 0。
    // 用替身测不到这一点：替身根本不看选项，把 subtree 改成 false 它照样全绿（实测如此）。
    const report = vi.fn<(count: number) => void>()
    const container = document.createElement('div')
    document.body.append(container)
    const stop = observeOverlays(document.body, report, MutationObserver)
    expect(report.mock.calls, '容器是空的，此刻不该有浮层').toEqual([[0]])

    const content = document.createElement('div')
    container.append(content)
    content.setAttribute('data-state', 'open')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(report.mock.calls.at(-1), '后代挂上 data-state="open" 之后没有被上报').toEqual([1])
    stop()
  })

  it('订阅选项覆盖 data-state 的属性变化', () => {
    // Radix 复用同一个节点在 open/closed 之间切换（退场动画），那是一次**属性**变化而不是增删。
    // 只订阅 childList 会让原生视图在浮层关掉后再不回来。
    const observer = syncObserver()
    document.body.append(document.createElement('div'))
    observeOverlays(document.body, vi.fn(), observer.ctor)
    expect(observer.options()).toMatchObject({ childList: true, subtree: true, attributes: true })
    expect(observer.options()?.attributeFilter, '没有按 data-state 过滤，每一次属性变化都要重算').toEqual([
      'data-state'
    ])
  })
})

describe('真实观察范围：只为外部浮层产生回调', () => {
  // Count delivery at the real platform callback, before the implementation can filter records.
  // The subclass delegates observe/disconnect/delivery unchanged to happy-dom's MutationObserver.
  function countedObserver() {
    const delivered = vi.fn<(records: MutationRecord[]) => void>()
    class CountedObserver extends MutationObserver {
      constructor(callback: MutationCallback) {
        super((records, observer) => { delivered(records); callback(records, observer) })
      }
    }
    return { ctor: CountedObserver, delivered }
  }

  const settleMutations = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  it('非空终端正文 childList 和 data-state 变化产生零观察回调', async () => {
    const root = mountAppRoot()
    const observer = countedObserver()
    const report = vi.fn<(count: number) => void>()
    const stop = observeOverlays(document.body, report, observer.ctor)
    try {
      for (let line = 0; line < 256; line++) root.append(document.createElement('span'))
      root.firstElementChild!.setAttribute('data-state', 'open')
      root.setAttribute('data-state', 'open')
      await settleMutations()
      expect(root.children).toHaveLength(256)
      expect(observer.delivered.mock.calls).toEqual([])
      expect(report.mock.calls).toEqual([[0]])
    } finally { stop() }
  })

  it('空 portal 后挂内容、嵌套 open 和 closed 都被真实观察', async () => {
    mountAppRoot()
    const portal = document.createElement('div')
    document.body.append(portal)
    const observer = countedObserver()
    const report = vi.fn<(count: number) => void>()
    const stop = observeOverlays(document.body, report, observer.ctor)
    try {
      const content = document.createElement('div')
      portal.append(content)
      await settleMutations()
      content.setAttribute('data-state', 'open')
      await settleMutations()
      const nested = document.createElement('div')
      nested.setAttribute('data-state', 'open')
      content.append(nested)
      content.setAttribute('data-state', 'closed')
      await settleMutations()
      nested.setAttribute('data-state', 'closed')
      await settleMutations()
      expect(Array.from(portal.children)).toEqual([content])
      expect(Array.from(content.children)).toEqual([nested])
      expect(observer.delivered.mock.calls.length).toBeGreaterThan(0)
      expect(report.mock.calls).toEqual([[0], [1], [0]])
    } finally { stop() }
  })

  it('成员同批移除、新增与打开会重绑；已移除子树不再产生回调', async () => {
    mountAppRoot()
    const removed = document.createElement('div')
    removed.setAttribute('data-state', 'open')
    document.body.append(removed)
    const observer = countedObserver()
    const report = vi.fn<(count: number) => void>()
    const stop = observeOverlays(document.body, report, observer.ctor)
    try {
      const replacement = document.createElement('div')
      const content = document.createElement('div')
      replacement.append(content)
      removed.remove()
      document.body.append(replacement)
      content.setAttribute('data-state', 'open')
      await settleMutations()
      expect(Array.from(document.body.children)).toEqual([document.getElementById('root'), replacement])
      expect(observer.delivered.mock.calls.length).toBeGreaterThan(0)
      observer.delivered.mockClear()
      removed.append(document.createElement('span'))
      removed.setAttribute('data-state', 'closed')
      await settleMutations()
      expect(removed.children).toHaveLength(1)
      expect(observer.delivered.mock.calls).toEqual([])
      content.setAttribute('data-state', 'closed')
      await settleMutations()
      expect(observer.delivered.mock.calls.length).toBeGreaterThan(0)
      expect(report.mock.calls).toEqual([[1], [0]])
    } finally { stop() }
  })

  it('新插空 portal 后来的内容可见；stop 后当前子树与 body 都不再回调', async () => {
    mountAppRoot()
    const observer = countedObserver()
    const report = vi.fn<(count: number) => void>()
    const stop = observeOverlays(document.body, report, observer.ctor)
    try {
      const portal = document.createElement('div')
      portal.setAttribute('data-overlay-host', '')
      document.body.append(portal)
      await settleMutations()
      const outer = document.createElement('div')
      const nested = document.createElement('div')
      outer.setAttribute('data-state', 'open')
      nested.setAttribute('data-state', 'open')
      portal.append(outer, nested)
      await settleMutations()
      outer.setAttribute('data-state', 'closed')
      await settleMutations()
      nested.remove()
      await settleMutations()
      expect(Array.from(portal.children)).toEqual([outer])
      expect(observer.delivered.mock.calls.length).toBeGreaterThan(0)
      expect(report.mock.calls).toEqual([[0], [2], [1], [0]])
      stop()
      observer.delivered.mockClear()
      outer.setAttribute('data-state', 'open')
      document.body.append(document.createElement('div'))
      await settleMutations()
      expect(observer.delivered.mock.calls).toEqual([])
      expect(report.mock.calls).toEqual([[0], [2], [1], [0]])
    } finally { stop() }
  })
})
