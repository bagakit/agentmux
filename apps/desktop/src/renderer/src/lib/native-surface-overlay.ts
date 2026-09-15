/**
 * 窗口级原生 Browser 视图（WebContentsView）合成在**所有 renderer 像素之上**。
 * Terminal 与 Monaco Editor 都在 renderer DOM 内，浮层遮挡不能改变它们的实际可见性。
 * 任何画在 DOM 里的浮层——对话框、右键菜单、下拉、命令面板、提示条——都会被它盖住，
 * 与 z-index 无关：它们根本不在同一个合成层里。
 *
 * 已有的出路是一把租约（`nativeSurfaceOverlayCount`）：有人持有就把原生视图藏起来。问题不在
 * 机制，在**覆盖率**——全仓 21 个文件用 Radix 的 Root，而持租约的只有 3 个。于是"弹窗经常被
 * 浏览器挡了"：不是偶发，是取决于你打开的恰好是哪一个。
 *
 * 逐个接线是行不通的：它会漂。新加一个对话框的人不会知道有这条规矩，而**没有任何断言会红**——
 * 那个浮层在开发时看起来完全正常，只有当它恰好开在浏览器上方时才消失。
 *
 * 所以判据落在 Radix **自己的协议**上，而不是我们的接线约定：Radix 把每个 Root 的内容 portal
 * 到 `document.body` 末尾（在 React 根之外），并在上面挂 `data-state="open"`。这是所有
 * Dialog / ContextMenu / DropdownMenu / Popover / Tooltip 共用的同一条 DOM 契约——
 * 一个 MutationObserver 数一次，21 个 Root 全部覆盖，新加的第 22 个自动覆盖。
 *
 * 原则 13：规则只依赖通用事实（portal 到 React 根之外 + data-state），不点名任何一个组件、
 * 不维护一张浮层清单。清单会和代码漂开，而且它一存在，下一个人遇到误报的第一反应就是往里加一行。
 */

/** React 挂载点的 id。它之外的 body 直接子节点就是 portal 出去的内容。 */
const APP_ROOT_ID = 'root'

/*
 * 下面 `isOverlayNode` / `openOverlayCount` 的产品侧调用者**只有本文件的 `observeOverlays`**——
 * 它们导出是为了被直接测到。零调用者检查扫到它们时不要判为"竖切未闭合"：接到产品上的那个符号是
 * `observeOverlays`（App.tsx 订阅它），这两个是它的判定内核，拆开测是为了让"数错了"和"没听见"
 * 分别红在不同的断言上。
 */

/**
 * 这个 body 直接子节点算不算一个"盖在原生视图上的浮层"。
 *
 * 三个条件同时成立才算，逐条都是承重的：
 *  - **不是 React 根**：React 根里是整个应用，它当然一直在。
 *  - **带 `data-state="open"`**：Radix 在关闭动画期间会留下 `data-state="closed"` 的节点，
 *    把它算进来会让租约在浮层已经看不见之后仍被持有，原生视图迟迟不回来。
 *  - **自己或后代**带那个属性：Radix 的 Portal 容器本身是个裸 div，`data-state` 挂在里面的
 *    Content 上。只看直接子节点会一个都数不到——而"数到 0"和"确实没有浮层"在计数上无法区分。
 */
export function isOverlayNode(node: Element): boolean {
  if (node.id === APP_ROOT_ID) return false
  if (node.getAttribute('data-state') === 'open') return true
  return node.querySelector('[data-state="open"]') !== null
}

/**
 * 当前有几个浮层开着。
 *
 * 返回**计数**而不是布尔，因为浮层会叠：对话框里开一个下拉，关掉下拉时布尔会立刻把原生视图放回来，
 * 而对话框还开着——它会被盖住，正是这个缺陷本身。计数让每一层各自收口。
 */
export function openOverlayCount(body: Pick<Element, 'children'>): number {
  let count = 0
  for (const child of body.children) {
    if (child.id === APP_ROOT_ID) continue
    if (child.hasAttribute('data-overlay-host')) {
      const openDescendants = Array.from(child.children).filter((entry) => isOverlayNode(entry))
      count += openDescendants.length > 0 ? openDescendants.length : (isOverlayNode(child) ? 1 : 0)
    } else if (isOverlayNode(child)) {
      count += 1
    }
  }
  return count
}

/**
 * 盯住 body 的直接子节点，把"开着几个浮层"持续喂给 `report`。
 *
 * 为什么是 MutationObserver 而不是让每个浮层自己上报：这正是覆盖率那一半。上报要靠 21 个
 * 调用点各自记得写，而观察 DOM 只需要写一次，且对第 22 个浮层自动成立。
 *
 * `subtree: true` 是必需的，不是保险：`data-state` 挂在 Portal 容器**里面**的 Content 上，
 * Radix 先插入空容器、再往里挂内容。只看直接子节点的增删会错过第二步——容器插入那一刻
 * 里面还什么都没有，数出来是 0。
 *
 * 返回取消订阅函数。进程里只有一个消费者（App），所以不做多播、不做引用计数——那是没人要的复杂度。
 */
export function observeOverlays(
  body: Element,
  report: (count: number) => void,
  ObserverCtor: typeof MutationObserver
): () => void {
  let last = -1
  const publish = (): void => {
    const count = openOverlayCount(body)
    // 只在变化时上报：Radix 打开一个浮层会触发好几次 mutation（插容器、挂内容、置 data-state），
    // 每次都上报会让 store 连着 set 三次同一个值，把整棵树重渲染三遍。
    if (count === last) return
    last = count
    report(count)
  }
  const observer = new ObserverCtor(publish)
  observer.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] })
  publish()
  return () => observer.disconnect()
}
