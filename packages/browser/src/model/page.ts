import type { AgentMuxControlBrowserRunOutcome, AgentMuxControlBrowserOperation } from '@agentmux/core'

export const BROWSER_PNG_MAX_BASE64_CHARS = 24 * 1024 * 1024
export const BROWSER_PNG_MAX_BYTES = 18 * 1024 * 1024
export const BROWSER_PNG_MAX_PIXELS = 32 * 1024 * 1024
export const BROWSER_PNG_MAX_DIMENSION = 16_384

export type BrowserPng = {
  mimeType: 'image/png'
  dataUrl: string
  width: number
  height: number
  byteLength: number
}

export type BrowserScreenshotCapture = {
  browserId: string
  navigationId: string
  image: BrowserPng
  source: {
    url: string | null
    title: string | null
    /** CSS viewport observed around this capture; image pixels remain independent. */
    viewport: { width: number; height: number; deviceScaleFactor: number | null } | null
    viewportWarning: string | null
    /** Requested viewport region and output density, when explicitly selected. */
    region?: { x: number; y: number; width: number; height: number; pixelRatio: number } | null
    /** Exact host feedback was excluded for these pixels, independently of input isolation. */
    hostOverlays?: 'excluded' | 'unconfirmed'
  }
}

/**
 * 一段 Agent 程序跑完之后，Main 交回 Renderer 的东西。
 *
 * 形状**刻意与 Control 回执（core 的 browser.run result）一致**：Renderer 那一层不做翻译，只是把它
 * 原样交出去。两侧各定义一次自己的形状、中间做一次映射的话，映射漏一个字段是静默的——四类结局里
 * 少接住一类，会表现为"某些失败被报成了成功"。
 */
export type BrowserScriptRunReport = {
  /** 程序 return 的值。它 return 什么就是什么，我们不规定形状。 */
  result: unknown
  /** 程序 console 出来的每一行，**失败时照样有**——炸掉之前打的那几行往往正是要看的。 */
  logs: string[]
  outcome: AgentMuxControlBrowserRunOutcome
  runOperation: AgentMuxControlBrowserOperation
}

export type BrowserElementRect = {
  x: number
  y: number
  width: number
  height: number
}

export type BrowserElementSelection = {
  browserId: string
  navigationId: string
  pageTitle: string
  pageUrl: string
  tagName: string
  role: string
  accessibleName: string
  selector: string
  text: string
  nearbyText: string[]
  attributes: Record<string, string>
  html: string
  rectViewport: BrowserElementRect
  rectPage: BrowserElementRect
  isFixed: boolean
}

export type BrowserAnnotationMarker = {
  id: string
  index: number
  rectViewport: BrowserElementRect
  rectPage: BrowserElementRect
  isFixed: boolean
}

/**
 * 页面语义快照里的一个节点。
 *
 * `ref` 是本次快照发给 Agent 的**指名句柄**——Agent 后续要操作哪个元素，只说 ref，不说坐标。
 * 这是「结构化 ref 寻址 ≠ 键鼠模拟」那条线在类型上的落点：ref 由我方快照发出，解不开就是解不开，
 * 不存在"点空了但返回成功"这种结局。
 *
 * `backendNodeId` 是 ref 的身份键，把 ref 解回真实 DOM 节点全靠它。**没有它的节点不进快照**：
 * 一个解不开的 ref 发给 Agent，等于让它拿着一个永远失败的把手。
 */
export type BrowserPageNode = {
  /** 本次快照内唯一的指名句柄，形如 `@e1`。跨快照不保证稳定——导航或重建后要重新取快照。 */
  ref: string
  /** 可读角色名。交互元素做了展示归一（如 textbox → text input）。 */
  role: string
  /** 可访问名称。交互节点没有名称时为 `(unlabeled)`，不是空串——空串会让 Agent 以为字段缺失。 */
  name: string
  /** 解析用的身份键，来自 CDP。 */
  backendNodeId: number
  /** 结构缩进层级，仅用于把树渲染成文本给 Agent 看。 */
  depth: number
  /** 实际 CDP document frame；同一派发 session 可以服务多个不同 document。 */
  frameId?: string
  /** 该节点的 CDP 派发通道；共享主通道的 document 为 undefined。 */
  sessionId?: string
}

/**
 * 一次页面快照的完整结局。
 *
 * `missingFrames` 是这个类型存在的主要理由：跨域 iframe 取不到时**不静默跳过**。取不到就在这里
 * 列出来——缺了哪个 frame、为什么缺。快照本身照常返回（不阻断），但 Agent 能看见自己拿到的是
 * 一张有洞的地图，而不是误以为页面上就只有这些元素。
 */
export type BrowserPageSnapshot = {
  url: string
  title: string
  /** 取快照时的导航身份。与之不符的 ref 一律作废——页面已经换了。 */
  navigationId: string
  nodes: BrowserPageNode[]
  missingFrames: BrowserPageFrameFailure[]
}

/** 一个没能取到的 frame。`reason` 是原始错误文本，不做归类——归类会把没见过的原因吃掉。 */
export type BrowserPageFrameFailure = {
  frameId: string
  reason: string
}
