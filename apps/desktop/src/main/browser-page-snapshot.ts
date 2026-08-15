import type {
  BrowserPageFrameFailure,
  BrowserPageNode,
  BrowserPageSnapshot
} from '../shared/contracts.js'

/**
 * 页面语义快照：把一页 DOM 走成一棵带 ref 的角色树，交给 Agent 指名操作。
 *
 * 实现改编自一个 MIT 许可的参考实现（署名见 THIRD_PARTY_NOTICES.md），但**错误模型是我方的**：
 * 原实现对取不到的跨域 iframe 是「catch 住什么都不做」——静默跳过。那违反 AGENTS.md:32-52
 * 原则 11，也正是本文件要避免的那种失败：Agent 拿到一张缺了半页的地图，却以为页面上就只有这些。
 * 这里改成缺失必须浮现（`missingFrames`），不阻断、不静默。
 *
 * 这一层只跟一个 CDP 闭包打交道，不引 Electron。于是它可以用一个假的 CDP 对端完整测试——
 * 但**假对端只能证明走查逻辑**，证不了 CDP 域本身可用。后者由真起 Electron 的
 * browser-cdp-render-domain.test.ts 单独判定，两者缺一不可。
 */

/** 向某个 CDP 对端发一条命令。主 frame 与每个 iframe 各有自己的 sender。 */
export type BrowserCdpSender = (method: string, params?: Record<string, unknown>) => Promise<unknown>

/** CDP `Accessibility.getFullAXTree` 返回的节点形状，只取我们用到的字段。 */
type AxNode = {
  nodeId: string
  backendDOMNodeId?: number
  role?: { value?: string }
  name?: { value?: string }
  properties?: { name: string; value?: { value?: unknown } }[]
  childIds?: string[]
  ignored?: boolean
}

/**
 * 这些角色是**容器**，本身不值得占一个 ref，但它们的孩子值得。走查要穿过去而不是停下。
 * 与 `ignored` 节点同等对待。
 */
const PASSTHROUGH_ROLES = new Set(['none', 'presentation', 'generic'])

/** 可以被 Agent 操作的角色。只有这些拿 ref——给不可操作的节点发 ref 是在制造无效把手。 */
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch',
  'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'treeitem'
])

/** 结构地标。它们不拿 ref，但要占一行并让孩子缩进——Agent 靠这个理解页面分区。 */
const LANDMARK_ROLES = new Set([
  'banner', 'navigation', 'main', 'complementary', 'contentinfo', 'region', 'form', 'search'
])

/** 交互角色的展示归一。CDP 的角色名对人不友好，Agent 读到的应该是它能理解的词。 */
const ROLE_LABELS: Record<string, string> = {
  textbox: 'text input',
  searchbox: 'text input',
  spinbutton: 'number input',
  menuitem: 'menu item',
  menuitemcheckbox: 'menu item',
  menuitemradio: 'menu item',
  treeitem: 'tree item'
}

/** 无名地标的展示名。有名字时直接用名字。 */
const LANDMARK_LABELS: Record<string, string> = {
  banner: 'Header',
  navigation: 'Navigation',
  main: 'Main Content',
  complementary: 'Sidebar',
  contentinfo: 'Footer',
  search: 'Search'
}

/**
 * 节点是否可聚焦。**缺省是可聚焦**——只有 CDP 明说 `focusable: false` 才当作不可聚焦。
 * 反过来写（缺省不可聚焦）会把大量真能点的元素挡在快照外，而那种缺失是静默的。
 */
function isFocusable(node: AxNode): boolean {
  const focusable = node.properties?.find((property) => property.name === 'focusable')
  return focusable?.value?.value !== false
}

function interactiveLabel(role: string): string {
  return ROLE_LABELS[role] ?? role
}

function landmarkLabel(role: string, name: string): string {
  if (name) return `[${name}]`
  return `[${LANDMARK_LABELS[role] ?? role}]`
}

/**
 * 递归走查 AX 树。
 *
 * 三条不显然的规则：
 * 1. **过滤掉的容器不消耗层级**——`ignored`/passthrough 节点的孩子接着用当前 depth，
 *    否则一堆无意义的 div 会把真实结构推到很深的缩进里。
 * 2. **交互节点是叶子**，不再往下走。一个按钮里面的 span 不该单独成为可点目标。
 * 3. **没有 backendNodeId 的节点不发 ref**。ref 的唯一用途就是解回 DOM 节点；解不回去的
 *    ref 是个永远失败的把手，发出去比不发更糟。
 */
function walk(
  node: AxNode,
  byId: Map<string, AxNode>,
  depth: number,
  out: BrowserPageNode[],
  nextRef: () => string
): void {
  const descend = (childDepth: number): void => {
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId)
      if (child) walk(child, byId, childDepth, out, nextRef)
    }
  }

  const role = node.role?.value ?? ''
  if (node.ignored === true || PASSTHROUGH_ROLES.has(role)) return descend(depth)

  const name = node.name?.value ?? ''
  const isLandmark = LANDMARK_ROLES.has(role)
  const isInteractive = INTERACTIVE_ROLES.has(role)

  // 地标可以无名（`[Navigation]` 本身就有信息）；交互节点也可以无名——纯图标按钮在真实页面里
  // 到处都是，把它们挡在外面等于让 Agent 点不到一整类控件，而且是静默点不到。其余节点无名就
  // 没有指称价值，穿过去。
  if (!name && !isLandmark && !isInteractive) return descend(depth)

  if (isLandmark) {
    out.push({
      ref: '',
      role: landmarkLabel(role, name),
      name: name || role,
      backendNodeId: node.backendDOMNodeId ?? 0,
      depth
    })
    return descend(depth + 1)
  }

  if (role === 'heading') {
    out.push({ ref: '', role: 'heading', name, backendNodeId: node.backendDOMNodeId ?? 0, depth })
    return
  }

  if (role === 'StaticText' || role === 'staticText') {
    const text = name.trim()
    if (text) out.push({ ref: '', role: 'text', name: text, backendNodeId: node.backendDOMNodeId ?? 0, depth })
    return
  }

  if (isInteractive) {
    // 没有 backendNodeId 就发不出可用的 ref，这个节点对 Agent 没有价值——穿过去看它的孩子。
    if (!node.backendDOMNodeId || !isFocusable(node)) return descend(depth)
    out.push({
      ref: nextRef(),
      role: interactiveLabel(role),
      name: name || '(unlabeled)',
      backendNodeId: node.backendDOMNodeId,
      depth
    })
    return
  }

  descend(depth)
}

/**
 * 在页面里找 AX 树漏掉的可点元素。
 *
 * 为什么需要这一步：一个挂了 `onclick` 的 `<div>` 对 AX 树是隐形的，但用户能点、Agent 也该能点。
 * 判据取三个属性加计算样式 `cursor: pointer`——后者是"这看起来可点"在 Web 上事实上的约定。
 */
const CURSOR_INTERACTIVE_EXPRESSION = `(() => {
  const SKIP_ROLES = new Set(['button','link','textbox','checkbox','radio','tab','menuitem','option',
    'switch','slider','combobox','searchbox','spinbutton','treeitem','menuitemcheckbox','menuitemradio'])
  const SKIP_TAGS = new Set(['input','button','select','textarea','a'])
  const seen = new Set()
  const found = []
  const matched = []
  const LIMIT = 50

  function check(el) {
    if (found.length >= LIMIT || seen.has(el)) return
    seen.add(el)
    if (SKIP_TAGS.has(el.tagName.toLowerCase())) return
    const role = el.getAttribute('role')
    if (role && SKIP_ROLES.has(role)) return
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const text = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 80)
    if (!text) return
    found.push(text)
    matched.push(el)
  }

  document.querySelectorAll('[onclick], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]').forEach(check)
  document.querySelectorAll('div, span, li, td, img, svg, label').forEach((el) => {
    try { if (window.getComputedStyle(el).cursor === 'pointer') check(el) } catch {}
  })

  window.__agentmuxClickable = matched
  return JSON.stringify(found)
})()`

/** 清理页面上那个临时全局。留着它会污染被测页面，也会让下一次快照读到上一次的残留。 */
const CURSOR_CLEANUP_EXPRESSION = 'delete window.__agentmuxClickable'

async function findClickableElements(
  send: BrowserCdpSender,
  known: Set<number>
): Promise<BrowserPageNode[]> {
  const evaluated = (await send('Runtime.evaluate', {
    expression: CURSOR_INTERACTIVE_EXPRESSION,
    returnByValue: true
  })) as { result?: { value?: string } }

  const labels = JSON.parse(evaluated.result?.value ?? '[]') as string[]
  const found: BrowserPageNode[] = []

  for (let index = 0; index < labels.length; index += 1) {
    const handle = (await send('Runtime.evaluate', {
      expression: `window.__agentmuxClickable[${index}]`
    })) as { result?: { objectId?: string } }
    const objectId = handle.result?.objectId
    if (!objectId) continue

    const described = (await send('DOM.describeNode', { objectId })) as {
      node?: { backendNodeId?: number }
    }
    const backendNodeId = described.node?.backendNodeId
    // AX 树已经收了这个节点就不重复收——重复的 ref 会让 Agent 以为页面上有两个一样的东西。
    if (!backendNodeId || known.has(backendNodeId)) continue
    known.add(backendNodeId)

    found.push({ ref: '', role: 'clickable', name: labels[index]!, backendNodeId, depth: 0 })
  }

  await send('Runtime.evaluate', { expression: CURSOR_CLEANUP_EXPRESSION, returnByValue: true })
  return found
}

async function collectAxNodes(send: BrowserCdpSender): Promise<AxNode[]> {
  await send('Accessibility.enable')
  const tree = (await send('Accessibility.getFullAXTree')) as { nodes?: AxNode[] }
  return tree.nodes ?? []
}

function indexById(nodes: AxNode[]): Map<string, AxNode> {
  const byId = new Map<string, AxNode>()
  for (const node of nodes) byId.set(node.nodeId, node)
  return byId
}

export type BrowserPageSnapshotInput = {
  send: BrowserCdpSender
  url: string
  title: string
  navigationId: string
  /** frameId → 该 frame 的 sender。跨域 iframe 各有自己的 CDP session。 */
  frames?: Map<string, BrowserCdpSender>
}

/**
 * 取一次页面快照。
 *
 * 失败模型：主 frame 取不到就抛（没有主 frame 就没有快照，返回一个空树会是谎言）；
 * **某个 iframe 取不到不抛**——它进 `missingFrames`，快照照常返回。这对应原则 11 的第二类
 * 「我们的流程坏了」：页面好好的，是我们少看了一块，不阻断但必须说出来。
 */
export async function captureBrowserPageSnapshot(
  input: BrowserPageSnapshotInput
): Promise<BrowserPageSnapshot> {
  const nodes: BrowserPageNode[] = []
  const missingFrames: BrowserPageFrameFailure[] = []
  let counter = 0
  const nextRef = (): string => `@e${(counter += 1)}`

  const mainNodes = await collectAxNodes(input.send)
  const mainRoot = mainNodes[0]
  if (mainRoot) walk(mainRoot, indexById(mainNodes), 0, nodes, nextRef)

  // AX 树先走完，可点元素提升才知道哪些 backendNodeId 已经收过了。
  const known = new Set(nodes.map((node) => node.backendNodeId))
  for (const clickable of await findClickableElements(input.send, known)) {
    nodes.push({ ...clickable, ref: nextRef() })
  }

  for (const [frameId, frameSend] of input.frames ?? new Map()) {
    try {
      const frameNodes = await collectAxNodes(frameSend)
      const frameRoot = frameNodes[0]
      if (!frameRoot) continue
      const before = nodes.length
      // iframe 内容从 depth 1 起，读起来就知道它嵌在父页面里。
      walk(frameRoot, indexById(frameNodes), 1, nodes, nextRef)
      // 这些节点的动作要发到 iframe 自己的 session，否则 backendNodeId 解不开。
      for (let index = before; index < nodes.length; index += 1) {
        nodes[index] = { ...nodes[index]!, sessionId: frameId }
      }
    } catch (error) {
      // 静默跳过是原实现的做法，这里不跟。取不到就说出来：缺了哪个 frame、为什么。
      missingFrames.push({ frameId, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  return {
    url: input.url,
    title: input.title,
    navigationId: input.navigationId,
    nodes,
    missingFrames
  }
}
