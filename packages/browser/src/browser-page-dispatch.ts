import type { BrowserPageNode, BrowserPageSnapshot } from './model/page.js'
import type { BrowserScopedSnapshot, BrowserSnapshotObservation } from './model/browser-snapshot-query.js'
import type { BrowserReplayTarget } from './model/browser-operation.js'
import type { BrowserPageTransport } from './browser-page-transport.js'
import { captureBrowserPageSnapshot, type BrowserPageCapture, type BrowserPageSnapshotInput } from './browser-page-snapshot.js'
import { parseBrowserSnapshotQuery, projectBrowserSnapshot, type NormalizedBrowserSnapshotQuery } from './browser-snapshot-query.js'
import { healRef, ledgerFromSnapshot, type BrowserRefLedger } from './browser-ref-ledger.js'
import { resolveBrowserRef } from './browser-ref-resolve.js'
import { buildBrowserElementContextDeclaration } from './browser-selection-script.js'
import { sanitizeBrowserElementSelection } from './browser-selection.js'
import { readBrowserResultArtifact, type BrowserResultArtifactStore } from './browser-result-artifact.js'
import { BrowserUploadUnconfirmedError, type BrowserUploadPort, type BrowserDownloadPort } from './browser-file-port.js'
import type { BrowserDownloadReference, BrowserDownloadReadOptions } from './model/browser-download.js'
import type { BrowserResultArtifactReference, BrowserResultContext, BrowserResultCurrentOwner, BrowserResultReadOptions } from './model/browser-result-artifact.js'
import { extractBrowserStructuredOutput, parseBrowserStructuredOutputRequest } from './browser-structured-output.js'
import { resolveBrowserStructuredTarget } from './browser-structured-target.js'
import { BrowserLocalRecoveryFailure } from './browser-recovery-failure.js'
import type { BrowserCdpSender } from './browser-page-snapshot.js'
import type { BrowserNativeInput } from './browser-page-transport.js'
import {
  SCROLL_INTO_VIEW, BROWSER_NATIVE_INPUT_WORLD, OWNS_HIT_DECLARATION, PREPARE_POINTER_WITNESS_DECLARATION, PREPARE_TOUCH_WITNESS_DECLARATION, PREPARE_TEXT_DECLARATION, SET_PICKER_VALUE_DECLARATION, READ_TEXT_DECLARATION, RESTORE_TEXT_FOCUS_DECLARATION, nativeKeyFor, parseKeyChord, editingCommandFor, FOCUS_FOR_KEY_DECLARATION
} from './browser-page-input-scripts.js'
import { browserCdpScopeRefusal, isBrowserCdpNativeInput } from './browser-cdp-scope.js'
import type { BrowserPageInterrupts } from './browser-page-interrupts.js'
import { createBrowserNetworkObservations } from './browser-network-observation.js'
import { createBrowserNetworkRouting } from './browser-network-routing.js'

/**
 * 页面函数真正干活的那一头。
 *
 * 子进程里那段 Agent 程序调 `click('@e3')`，请求经 IPC 回到主进程，落到这里。这一层的职责只有
 * 三件：**按 ref 解出句柄、在句柄上派发、把失败说清楚**。
 *
 * 为什么单独成文件而不是留在 `browser-view-manager.ts` 里：那个类已经管着 view 生命周期、profile
 * 切换、选区、标注、截图。页面派发挂进去会让它继续长，而这一层**不需要 Electron**——它只吃一个
 * CDP 会话和一个 `pageInfo` 闭包。分出来之后它可以用假会话完整测掉分派逻辑，真机那条只用来证
 * CDP 域本身可用（两者缺一不可，见 browser-drive-e2e.test.ts 的分工说明）。
 *
 * **快照缓存是这一层存在的第二个理由**：ref 是上一次 `snapshot()` 发出的，下一次 `click(ref)` 要
 * 解开它就必须还记得那张快照。缓存只活在一次驱动之内；跨轮次、跨重启那一半由 ref 账本
 * （`browser-ref-ledger.ts`）承担——它记的是内容身份而不是 backendNodeId，因为后者随 CDP 会话消亡。
 */

/** 一次驱动期间，这一层需要从 Browser 那里知道的东西。传闭包而不是传整个 manager：依赖收到最小。 */
export type BrowserPageContext = {
  /** Original program owner awaits protocol cleanup before releasing its native session. */
  registerCleanup?(cleanup: () => Promise<void>): void
  session: BrowserPageTransport
  /** 当前页面身份。每次调用现取——导航可能发生在两次页面函数之间。 */
  pageInfo(): { url: string; title: string; navigationId: string; faviconDataUrl?: string;
    navigation?: import('@agentmux/core').AgentMuxBrowserNavigationObservation }
  /** 导航到一个地址，等它停下来。 */
  gotoUrl(url: string): Promise<void>
  /** 截图走 Electron 的 capturePage，与 Agent 无关的那条既有路径。 */
  captureScreenshot(): Promise<unknown>
  /** 这个 Browser 上一轮留下的 ref 账本；没有就是 null。 */
  readLedger(): Promise<BrowserRefLedger | null>
  /** 记下这一轮最新的一批 ref，供下一轮（乃至下次启动）认回来。 */
  writeLedger(ledger: BrowserRefLedger): Promise<void>
  /**
   * 报一件「做了，但有损」的事——目前只有 ref 自愈。
   *
   * 必须有这个出口：自愈按外观匹配，可能落在一个长得一样的**另一个**元素上。不说出来，Agent 收到的
   * 是一次干净的成功（AGENTS.md:32-52 明令不许把分不清的当成好的）。抛又是错的——页面好好的，
   * 是我们的中间步骤没跟上，属第 2 类，不许阻断。
   */
  note(text: string): void
  /** Receives the semantic identity of the ref that is about to be acted on. */
  recordTarget?(target: BrowserReplayTarget, endpoint?: 'destination'): void
  /** Main rechecks original stop/control/view after resolving a handle, before an action is sent. */
  beforeAction?(): void
  /** Passive feedback uses the actually resolved node/sender, never old-ref lookup or input values. */
  actionFeedback?(node: BrowserPageNode, send: BrowserPageTransport['sendCommand']): Promise<void>
  /** Result source identity lives in storage; a continuation run supplies only its current authorization. */
  resultArtifacts?: { store: BrowserResultArtifactStore; owner: BrowserResultCurrentOwner }
  /** Main supplies the actual operation and live-entry facts; scripts cannot relabel observations. */
  structuredOutput?: { source(): BrowserResultContext; isCurrent(navigationId: string): boolean }
  uploads?: BrowserUploadPort
  downloads?: BrowserDownloadPort
  /**
   * Begins one action's native input on the original page under Main's own-dispatch receipt.
   * Main's input consumers ask that receipt, not `isTrusted`, who sent an input (browser-own-dispatch.ts).
   * Absent (a shared external tab) means the commands are sent without a Main receipt.
   */
  beginNativeInput?(): Promise<BrowserNativeInput>
  /** Cancellation of this exact original program; a held touch must not send a late end. */
  signal?: AbortSignal
  /** The run's page-dialog owner; absent (a shared external tab, a probe) means dialogs are not answered here. */
  interrupts?: BrowserPageInterrupts
  /** Page CSS pixels → `Input.*` coordinates under the execution Viewport Main actually applied. Absent means 1. */
  inputScale?(): number
  /**
   * Milliseconds left before the whole program is stopped; absent means no program budget. A wait is
   * cut to this so it ends with its own reason, while the program still runs, rather than the program
   * being killed in the middle of the wait with nothing said about what it was waiting for.
   */
  remainingMillis?(): number
}

/** 默认的等待上限。脚本整体还有自己的超时兜底，这里只防"一个 wait 把整轮吃光"。 */
const DEFAULT_WAIT_MS = 10_000
/** Time a cut-short wait leaves for its reason to reach the program before the program's budget ends. */
const WAIT_RETURN_MARGIN_MS = 1_500
/** 网络安静判定：这么久没有新请求就算静了。取自 CDP 惯例，不是可调项——调它只会让判据变模糊。 */
const NETWORK_IDLE_QUIET_MS = 500

/** Center of the first content quad with area. Inline boxes that wrap lines have several quads. */
function quadCenter(quads: unknown, fraction = 0.5): { x: number; y: number } | null {
  if (!Array.isArray(quads)) return null
  for (const quad of quads) {
    if (!Array.isArray(quad) || quad.length !== 8 || !quad.every((value) => typeof value === 'number' && Number.isFinite(value))) continue
    const q = quad as number[]
    let doubled = 0
    for (let index = 0; index < 4; index += 1) {
      const next = (index + 1) % 4
      doubled += q[index * 2]! * q[next * 2 + 1]! - q[next * 2]! * q[index * 2 + 1]!
    }
    if (Math.abs(doubled) < 1e-6) continue
    return { x: ((q[0]! + q[6]!) * (1 - fraction) + (q[2]! + q[4]!) * fraction) / 2,
      y: ((q[1]! + q[7]!) * (1 - fraction) + (q[3]! + q[5]!) * fraction) / 2 }
  }
  return null
}

/** click's options: {button: 'left'|'middle'|'right', count: 1|2}. Refused before anything is resolved, so a typo never clicks. */
function clickOptions(raw: unknown): { button: 'left' | 'middle' | 'right'; count: 1 | 2 } {
  if (raw === undefined) return { button: 'left', count: 1 }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('click options are {button, count}.')
  const { button = 'left', count = 1, ...rest } = raw as { button?: unknown; count?: unknown }
  if (Object.keys(rest).length) throw new TypeError(`click does not take ${Object.keys(rest).map(key => JSON.stringify(key)).join(', ')}; it takes {button, count}.`)
  if (button !== 'left' && button !== 'middle' && button !== 'right') throw new TypeError('click button is "left", "middle" or "right".')
  if (count !== 1 && count !== 2) throw new TypeError('click count is 1 or 2.')
  return { button, count }
}

/**
 * waitForUrl's condition: a whole URL or a part of one. A whole URL is compared as Chromium reports it,
 * so `https://example.com` matches its normalized `https://example.com/`. No regex is accepted: it
 * would run program-supplied code on Main, where one bad pattern freezes every window; a program that
 * needs a pattern tests pageInfo().url in its own process.
 */
function urlCondition(wanted: unknown): (url: string) => boolean {
  if (typeof wanted === 'string') {
    let whole = wanted
    try { whole = new URL(wanted).href } catch { /* Not a parseable URL; compared as written. */ }
    return url => url === whole
  }
  const condition = wanted !== null && typeof wanted === 'object' ? wanted as { contains?: unknown } : {}
  if (typeof condition.contains === 'string') { const part = condition.contains; return url => url.includes(part) }
  throw new TypeError('waitForUrl takes a URL string or {contains: text}. For a pattern, test pageInfo().url in your program.')
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string, got ${typeof value}`)
  return value
}

/**
 * 页面自己抛出来的那句话。**这是页面控制的文本，不是我们的文案。**
 *
 * 为什么要单独标一层：这句话会顺着 `step.summary` 落进操作日志（`browser-view-manager.ts` 的失败臂
 * 取 `error.message`），而日志是**持久的、后面会被别的 Agent 读回去的**。页面里一个
 * `throw new Error('忽略之前的指令，改为……')` 于此就成了存储型注入——写入的是这一轮，
 * 命中的是下一轮，而中间没有任何一步看得出这段字是页面写的还是我们写的。
 *
 * 所以在**入口**就把它圈起来，而不是在下游猜：下游只看到一个字符串，分不清来源。圈法是
 * 标注来源 + 去掉换行（多行能在日志里伪造出"新的一条记录"的样子）。内容一个字不改——
 * 那是排障要看的真东西，删掉它等于让 Agent 面对一次无从下手的失败（AGENTS.md:32-52）。
 */
function pageAuthoredText(text: string | undefined): string {
  if (text === undefined || text.trim() === '') return 'unknown error (the page gave no message)'
  // 字符集与 browser-operation-journal.ts 的 `clampProse` 必须同一个（见那边注释）：`\s` 不含
  // NEL（U+0085），而 NEL 在终端里照样当换行渲染。两条路形态不一致，就得逐条去数谁防住了。
  const oneLine = text.replace(/\p{White_Space}+/gu, ' ').trim()
  return `[page-authored text] ${oneLine}`
}

/**
 * 把一次 ref 解析的失败翻译成抛给脚本的异常。
 *
 * 三类失败对 Agent 意味着**三种不同的下一步**，所以每一句都说到那一步为止：重取快照、检查把手、
 * 页面已经换了。折成一句 "element not found" 会让 Agent 在三种情况下做同一件事，而其中两种是错的。
 */
function refFailureError(failure: Awaited<ReturnType<typeof resolveBrowserRef>> & { resolved: false }): Error {
  const { failure: reason } = failure
  if (reason.kind === 'unknown-ref') {
    return new Error(
      `No element ${reason.ref} in the current snapshot. Refs come from the snapshot that produced them — ` +
        'take a fresh snapshot() and use a ref from it.'
    )
  }
  if (reason.kind === 'stale-snapshot') {
    return new BrowserLocalRecoveryFailure(
      `The page navigated since that snapshot was taken (${reason.snapshotNavigationId} → ` +
        `${reason.currentNavigationId}), so every ref in it is void, ${reason.ref} included. Take a new snapshot().`,
      'locator-changed', 'not-dispatched'
    )
  }
  return new BrowserLocalRecoveryFailure(`Element ${reason.ref} is gone from the page (${reason.reason}). Take a new snapshot().`,
    'locator-changed', 'not-dispatched')
}

/**
 * 把一棵快照渲染成给 Agent 读的文本。
 *
 * 缩进表示结构，`@eN` 是可操作的把手。**缺失的 frame 附在末尾**——一张有洞的地图必须自己说明哪里
 * 有洞，否则 Agent 会把"没列出来"读成"页面上没有"。
 */
export function renderBrowserSnapshotText(snapshot: BrowserPageSnapshot, observation?: BrowserSnapshotObservation): string {
  const lines = [`${snapshot.title} — ${snapshot.url}`]
  if (observation) {
    lines.push(`(observation ${observation.scope.kind}, document ${observation.scope.document ?? 'all discovered documents'}: ${observation.fullObserved} observed, ${observation.scoped} scoped, ${observation.matched} matched, ${observation.returned} returned; truncated=${observation.truncated})`)
    if (observation.omittedFrames.length) lines.push(`(documents excluded by scope, not failed reads: ${observation.omittedFrames.join(', ')})`)
    if (observation.unlocated) lines.push(`(${observation.unlocated} nodes omitted because their viewport location could not be established)`)
  }
  for (const node of snapshot.nodes) {
    const indent = '  '.repeat(node.depth)
    const handle = node.ref === '' ? '' : `${node.ref} `
    lines.push(`${indent}${handle}${node.role}: ${node.name}`)
  }
  for (const missing of snapshot.missingFrames) {
    lines.push(`(frame ${missing.frameId} could not be read: ${missing.reason})`)
  }
  return lines.join('\n')
}

/**
 * 建一个页面函数派发器。
 *
 * 返回的闭包就是 `runBrowserScript` 的 `onPageCall`——**这是那两个模块唯一的生产调用点**，
 * 也是 T-010 验收里那条零调用者 grep 要看到的答案。
 */
type BrowserPageActionScope = { feedback?: BrowserPageContext['actionFeedback']; beforeAction?: BrowserPageContext['beforeAction']; recordTarget?: BrowserPageContext['recordTarget']; dispatched?(): void | Promise<void> }

export function createBrowserPageDispatch(
  context: BrowserPageContext
): (name: string, args: unknown[], scope?: BrowserPageActionScope) => Promise<unknown> {
  const { session } = context
  let network: ReturnType<typeof createBrowserNetworkObservations> | undefined
  const networkObservations = () => network ??= createBrowserNetworkObservations(context)
  let routes: ReturnType<typeof createBrowserNetworkRouting> | undefined
  const networkRouting = () => routes ??= createBrowserNetworkRouting(context)
  // 最近一张快照。ref 只在发出它的那张快照里有意义，所以这里只留一张——留多张等于允许
  // Agent 拿两轮之前的 ref 说话，而那些 ref 指向的元素早就不在了。
  let current: BrowserPageSnapshot | null = null
  /**
   * **本轮真正交到 Agent 手里的那批 ref**，没交过任何一张快照时为 null。
   *
   * 完整身份图还包含被范围或预算裁掉的节点；它们的 ref 没有交付，不能被猜出来后使用。
   * 本轮编号单调递增，旧快照已交付的 ref 明确过期；上一轮的编号预留，沿原账本有损认回。
   * 不能把「完整图里存在」等同于「这轮授权了这个把手」。
   */
  let issued: Set<string> | null = null
  const expired = new Set<string>()
  let refCounter: number | null = null
  // 上一轮的账本**在任何快照落盘之前**读出来。晚一步读到的就是本轮自己刚写下的那份，
  // 于是跨轮自愈会静默退化成「永远认不出旧 ref」。
  const prior = context.readLedger()

  async function takeSnapshot(query?: NormalizedBrowserSnapshotQuery, withinTarget?: BrowserPageSnapshotInput['withinTarget'], onCapture?: (snapshot: BrowserPageCapture) => void): Promise<BrowserPageCapture> {
    if (refCounter === null) {
      const previous = await prior
      // Reserve the prior run's names: publishing a new graph must not turn an
      // earlier run's appearance-based ref into an unmarked identity match.
      refCounter ??= Math.max(0, ...(previous?.entries ?? []).map((entry) => Number(/^@e(\d+)$/.exec(entry.ref)?.[1] ?? 0)))
    }
    const info = context.pageInfo()
    const snapshot = await captureBrowserPageSnapshot({
      send: session.sendCommand,
      url: info.url,
      title: info.title,
      navigationId: info.navigationId,
      frames: session.frames,
      nextRef: () => `@e${(refCounter! += 1)}`,
      ...(query ? { query } : {}),
      ...(withinTarget ? { withinTarget } : {})
    })
    // Discovery can fail after some embedded documents were attached and read.
    // Preserve those observations, but disclose the unknown remainder rather
    // than presenting an empty missingFrames list as complete discovery.
    const discovery = session.frameDiscoveryFailure
    if (discovery !== null) {
      snapshot.missingFrames.push({
        frameId: '(undiscovered embedded documents)',
        reason:
          `Frame discovery was incomplete (${discovery}). Some embedded documents may be missing; ` +
          'see identified missingFrames and retry snapshot(). Already observed documents remain available.'
      })
    }
    if (context.pageInfo().navigationId !== info.navigationId) throw new Error('The page navigated during snapshot capture. Take a new snapshot() of the current page.')
    onCapture?.(snapshot)
    current = snapshot
    return snapshot
  }

  /**
   * 取一张快照并交给 Agent。
   *
   * 与 {@link takeSnapshot} 的区别只有一件事：**这些 ref 现在归本轮所有**。自愈内部那次取快照
   * 走的是前者——它的编号从没离开过这个进程，认领它等于把旧 ref 洗成新 ref。
   */
  async function publishSnapshot(query: NormalizedBrowserSnapshotQuery): Promise<BrowserScopedSnapshot> {
    const work = { axTrees: 0, axNodes: 0, layoutTrees: 0, cdpCommands: 0 }
    const recordCapture = (capture: BrowserPageCapture): void => {
      for (const key of ['axTrees', 'axNodes', 'layoutTrees', 'cdpCommands'] as const) work[key] += capture.scopeFacts.work[key]
    }
    const within = query.withinRef ? await handleFor(query.withinRef, recordCapture) : undefined
    const snapshot = await takeSnapshot(query, within ? { objectId: within.objectId,
      ...(within.node.frameId ? { frameId: within.node.frameId } : {}),
      ...(within.node.sessionId ? { sessionId: within.node.sessionId } : {}) } : undefined, recordCapture)
    // A prior-run withinRef can require an initial full capture for appearance
    // recovery. Count that capture too instead of hiding its AX work.
    snapshot.scopeFacts.work = work
    const projected = projectBrowserSnapshot(snapshot, snapshot.scopeFacts, query)
    for (const ref of issued ?? []) expired.add(ref)
    issued = new Set(projected.nodes.filter((node) => node.ref !== '').map((node) => node.ref))
    // Ordinals come from the full graph; only handles actually handed out go on
    // disk. Computing nth after clipping would recover a same-named neighbour.
    const ledger = ledgerFromSnapshot(snapshot)
    ledger.entries = ledger.entries.filter((entry) => issued!.has(entry.ref))
    await context.writeLedger(ledger)
    return projected
  }

  /** 在一张指定的快照里把 ref 解成句柄。三类失败各自成话。 */
  async function handleIn(
    snapshot: BrowserPageSnapshot,
    ref: string
  ): Promise<{ objectId: string; send: typeof session.sendCommand; node: BrowserPageNode; navigationId: string }> {
    const resolution = await resolveBrowserRef({
      snapshot,
      ref,
      send: session.sendCommand,
      frames: session.frames,
      currentNavigationId: context.pageInfo().navigationId
    })
    if (!resolution.resolved) throw refFailureError(resolution)
    const send = resolution.sessionId ? session.frames.get(resolution.sessionId) : session.sendCommand
    // 解开的那一刻 frame 还在，取 sender 时没了。这条极少发生，但不判就会变成一句
    // "cannot read property of undefined"——那看起来像我们的 bug，而不是页面变了。
    if (!send) throw new BrowserLocalRecoveryFailure(`The frame holding ${ref} went away. Take a new snapshot().`,
      'locator-changed', 'not-dispatched')
    return { objectId: resolution.objectId, send, node: snapshot.nodes.find((node) => node.ref === ref)!, navigationId: snapshot.navigationId }
  }

  /** 把 ref 解成可派发的句柄。本轮没发出过的 ref 交给账本认领，绝不撞进新快照的编号。 */
  async function handleFor(ref: string, onCapture?: (snapshot: BrowserPageCapture) => void): Promise<{ objectId: string; send: typeof session.sendCommand; node: BrowserPageNode; navigationId: string }> {
    if (expired.has(ref)) throw new Error(`${ref} was superseded by a later snapshot in this run. Use a ref from the latest snapshot().`)
    if (issued !== null && current !== null && issued.has(ref)) return await handleIn(current, ref)

    // 到这里说明这个 ref 不是本轮发出的：可能来自上一轮（甚至上次启动），也可能是拼错的。
    const ledger = await prior
    const fresh = current ?? (await takeSnapshot(undefined, undefined, onCapture))
    if (!ledger) {
      // 两种"账本帮不上忙"要分开说，因为下一步不同：这一轮取过快照就说明 ref 确实不在页面上
      // （Agent 拼错了或记串了）；一次都没取过则是它在用一个更早的 ref，而更早的那批没留下来。
      throw new Error(
        issued === null
          ? `No element ${ref} in this Browser. This run has not taken a snapshot yet, and no earlier ` +
            'run left any refs on it either. Call snapshot() and use a ref from it.'
          : `No element ${ref} in the current snapshot, and no earlier run left that ref on this ` +
            'Browser either. Take a fresh snapshot() and use a ref from it.'
      )
    }
    const heal = healRef(ledger, ref, fresh)
    // Nothing was dispatched: the ref could not be matched, so the same typed fact as any other gone
    // element lets reviewed recovery and the program's own catch treat it as a safe miss.
    if (!heal.healed) throw new BrowserLocalRecoveryFailure(heal.reason, 'locator-changed', 'not-dispatched')
    // 自愈是有损的，所以它必须留下痕迹。不阻断（页面好好的，是我们的快照没了——原则 11 第 2 类），
    // 但也绝不静默：静默自愈让一次"点中了长得一样的邻居"看起来和一次干净的成功完全一致。
    context.note(heal.note)
    return await handleIn(fresh, heal.node.ref)
  }

  /** Resolves the ref, records its semantic target and passes the first dispatch guard. Every action starts here. */
  async function actionTarget(scope: BrowserPageActionScope | undefined, ref: string, endpoint?: 'destination') {
    const { objectId, send, node, navigationId } = await handleFor(ref)
    const actionFeedback = scope?.feedback ?? context.actionFeedback
    const beforeAction = scope?.beforeAction ?? context.beforeAction
    const guard = () => {
      beforeAction?.()
      if (context.pageInfo().navigationId !== navigationId) throw new BrowserLocalRecoveryFailure(
        'The original document changed before this action was dispatched. Take a new snapshot().', 'locator-changed', 'not-dispatched')
      if (node.sessionId && session.frames.get(node.sessionId) !== send) throw new BrowserLocalRecoveryFailure(
        'The original frame sender changed before this action was dispatched. Take a new snapshot().', 'locator-changed', 'not-dispatched')
    }
    if (node) {
      const same = current?.nodes.filter((candidate) => candidate.role === node.role && candidate.name === node.name) ?? []
      const recordTarget = scope?.recordTarget ?? context.recordTarget
      recordTarget?.({ role: node.role, name: node.name, ordinal: same.findIndex((candidate) => candidate.ref === node.ref) + 1, count: same.length }, endpoint)
    }
    guard()
    return { objectId, send, node, guard, actionFeedback }
  }

  /** A failure that happened before any input reached the page; local recovery may retry it after a new snapshot. */
  function notDispatched(message: string): BrowserLocalRecoveryFailure {
    return new BrowserLocalRecoveryFailure(message, 'locator-changed', 'not-dispatched')
  }

  /**
   * Where a native press on this target lands, in top-level `Input.*` coordinates, after proving the
   * target is the topmost node at that point.
   *
   * Nothing is sent to the page here. A target without a box, one covered by another element, or one
   * in a frame whose position in the top-level page cannot be established is refused before input.
   */
  async function nativePoint(ref: string, send: BrowserCdpSender, objectId: string, node: BrowserPageNode, world: number, fraction = 0.5) {
    const quads = await read<{ quads?: unknown }>(send, 'DOM.getContentQuads', { objectId })
    const local = quadCenter(quads.value?.quads, fraction)
    if (!local) throw notDispatched(`${ref} has no visible box to click${quads.reason}. Nothing was pressed; inspect the page or take a new snapshot().`)
    const x = Math.round(local.x), y = Math.round(local.y)
    const located = await read<{ backendNodeId?: number; frameId?: string }>(send, 'DOM.getNodeForLocation',
      { x, y, includeUserAgentShadowDOM: false, ignorePointerEventsNone: false })
    const hit = located.value
    if (!hit?.backendNodeId) throw notDispatched(`The element at the center of ${ref} could not be checked${located.reason}, so whether it is covered is unknown. ` +
      'Nothing was pressed; retry after a new snapshot().')
    const covered = notDispatched(`${ref} is not the topmost element at its center: another element covers it, or its position could not be confirmed. ` +
      'Nothing was pressed; close what covers it or take a new snapshot().')
    if (hit.frameId && node.frameId && hit.frameId !== node.frameId) throw covered
    const resolved = await send('DOM.resolveNode', { backendNodeId: hit.backendNodeId, executionContextId: world })
      .catch(() => null) as { object?: { objectId?: string } } | null
    const hitObject = resolved?.object?.objectId
    if (!hitObject) throw covered
    try {
      const owned = await inWorld(send, objectId, OWNS_HIT_DECLARATION, [{ objectId: hitObject }])
      if (owned !== true) throw covered
    } finally { await send('Runtime.releaseObject', { objectId: hitObject }).catch(() => {}) }
    if (!node.sessionId) return { x, y }
    // Out-of-process frame: its quads are in its own document. Add the frame owner's content origin in
    // the top-level document, and prove that origin is what the top-level hit test sees at the sum.
    const owner = await read<{ backendNodeId?: number }>(session.sendCommand, 'DOM.getFrameOwner', { frameId: node.frameId })
    const ownerId = owner.value?.backendNodeId
    const box = ownerId === undefined ? owner
      : await read<{ model?: { content?: number[] } }>(session.sendCommand, 'DOM.getBoxModel', { backendNodeId: ownerId })
    const origin = (box.value as { model?: { content?: number[] } } | undefined)?.model?.content
    const unconverted = (reason: string) => notDispatched(`The position of the frame holding ${ref} in the top-level page could not be established${reason}, ` +
      'so a native press could land on the wrong element. Nothing was pressed; use an element of the top-level document or inspect the frame.')
    if (!origin || origin.length < 2 || !Number.isFinite(origin[0]) || !Number.isFinite(origin[1])) throw unconverted(box.reason)
    const top = { x: Math.round(x + origin[0]!), y: Math.round(y + origin[1]!) }
    const topHit = await read<{ backendNodeId?: number }>(session.sendCommand, 'DOM.getNodeForLocation',
      { ...top, includeUserAgentShadowDOM: false, ignorePointerEventsNone: false })
    if (topHit.value?.backendNodeId !== ownerId) throw unconverted(topHit.reason)
    return top
  }

  /**
   * One read-only geometry command. A refusal or protocol error is returned as its reason, so a
   * not-dispatched failure names what actually stopped it (for example a shared tab that does not
   * allow the method) instead of a generic "could not be confirmed".
   */
  async function read<T>(sender: BrowserCdpSender, method: string, params: Record<string, unknown>): Promise<{ value?: T; reason: string }> {
    try { return { value: await sender(method, params) as T, reason: '' } }
    catch (error) {
      // Protocol or bridge text, one line and bounded, so it cannot fake a new log record.
      const text = (error instanceof Error ? error.message : String(error)).replace(/\p{White_Space}+/gu, ' ').trim().slice(0, 300)
      return { reason: ` (${method}: ${text || 'no message'})` }
    }
  }

  /** Run a declaration on a handle that lives in the native-input isolated world. Page text never becomes a fact here. */
  async function inWorld(send: BrowserCdpSender, objectId: string, functionDeclaration: string, args: unknown[] = []): Promise<unknown> {
    const response = await send('Runtime.callFunctionOn', { objectId, functionDeclaration, arguments: args, returnByValue: true })
      .catch(() => null) as { result?: { value?: unknown }; exceptionDetails?: unknown } | null
    return response && !response.exceptionDetails ? response.result?.value : undefined
  }

  /** Confirm this original native move by its trusted event target, independently of page CSS. */
  async function witnessedPointerMove(send: BrowserCdpSender, objectId: string, move: () => Promise<unknown>): Promise<boolean> {
    const prepared = await send('Runtime.callFunctionOn', { objectId, functionDeclaration: PREPARE_POINTER_WITNESS_DECLARATION,
      returnByValue: false }) as { result?: { objectId?: string }; exceptionDetails?: unknown }
    const witness = prepared.result?.objectId
    if (!witness || prepared.exceptionDetails) throw notDispatched('The original pointer target could not be observed. No press was sent; inspect the page before acting again.')
    try {
      await move()
      return await inWorld(send, witness, 'function () { return this.read() }') === true
    } finally {
      await inWorld(send, witness, 'function () { this.dispose() }').catch(() => {})
      await send('Runtime.releaseObject', { objectId: witness }).catch(() => {})
    }
  }

  /**
   * A trusted native left click at the target's box: mouseMoved, mousePressed, mouseReleased with
   * clickCount 1, sent on the top-level page. No trajectory, no delays.
   *
   * Order is the same as every other action: guard, scroll, guard, target feedback, guard. Then the
   * geometry is proven, Main's own-dispatch bracket opens, the move is sent, and the press is sent
   * only when the pointer is confirmed on the target. The page answers clicks itself, so there is no
   * exceptionDetails to read; the receipt is the acknowledged release.
   */
  async function nativeClick(scope: BrowserPageActionScope | undefined, ref: string, press = true,
    click: { button: 'left' | 'middle' | 'right'; count: 1 | 2 } = { button: 'left', count: 1 }): Promise<undefined> {
    const { objectId, send, node, guard, actionFeedback } = await actionTarget(scope, ref)
    const prepared = await send('Runtime.callFunctionOn', { objectId, functionDeclaration: SCROLL_INTO_VIEW,
      awaitPromise: true, returnByValue: true }) as { exceptionDetails?: { text?: string } }
    if (prepared.exceptionDetails) throw new Error(`The page threw while preparing ${ref}: ${pageAuthoredText(prepared.exceptionDetails.text)}`)
    guard()
    if (actionFeedback) {
      await actionFeedback(node, send)
      // Display work can yield to real takeover, navigation or stop. Recheck before the original action.
      guard()
    }
    if (!node.frameId) throw notDispatched(`The document holding ${ref} has no frame identity, so its click point cannot be checked. Nothing was pressed; take a new snapshot().`)
    const world = await send('Page.createIsolatedWorld', { frameId: node.frameId, worldName: BROWSER_NATIVE_INPUT_WORLD })
      .catch(() => null) as { executionContextId?: number } | null
    if (!Number.isInteger(world?.executionContextId)) throw notDispatched(`The document holding ${ref} could not be inspected for its click point. Nothing was pressed; retry after a new snapshot().`)
    const isolated = await send('DOM.resolveNode', { backendNodeId: node.backendNodeId, executionContextId: world!.executionContextId })
      .catch(() => null) as { object?: { objectId?: string } } | null
    const target = isolated?.object?.objectId
    if (!target) throw notDispatched(`${ref} could not be inspected for its click point. Nothing was pressed; take a new snapshot().`)
    try {
      const point = await nativePoint(ref, send, target, node, world!.executionContextId!)
      const scale = context.inputScale?.() ?? 1
      const x = point.x * scale, y = point.y * scale
      guard()
      const native = await context.beginNativeInput?.() ?? { input: <T>(command: () => Promise<T>) => command(), end: () => {} }
      const mouse = (params: Record<string, unknown>) => native.input(() => session.sendCommand('Input.dispatchMouseEvent', params))
      try {
        // Beginning can yield (it first retires a person's pending element picker).
        guard()
        if (!await witnessedPointerMove(send, target, () => mouse({ type: 'mouseMoved', x, y, button: 'none', buttons: 0 }))) {
          if (!press) throw new BrowserLocalRecoveryFailure(`The pointer move was acknowledged but its original target could not be confirmed for ${ref}. Inspect the page before relying on it.`, 'locator-changed', 'unknown')
          throw notDispatched(`The pointer did not land on ${ref}, so it was not pressed. Inspect the page or take a new snapshot().`)
        }
        // Hover is the confirmed move itself; it leaves the pointer there, as a person's hover does.
        if (!press) return undefined
        // A double click is two presses at the same point with rising clickCount, as Chromium counts a
        // person's; the second carries 2, which is what fires dblclick.
        const buttons = click.button === 'left' ? 1 : click.button === 'right' ? 2 : 4
        for (let count = 1; count <= click.count; count++) {
          guard()
          await mouse({ type: 'mousePressed', x, y, button: click.button, buttons, clickCount: count })
          try {
            await mouse({ type: 'mouseReleased', x, y, button: click.button, buttons: 0, clickCount: count })
          } catch (error) {
            throw new Error(`${ref} was pressed but its release was not confirmed (${error instanceof Error ? error.message : String(error)}). ` +
              'The click may or may not have happened; inspect the page before acting again.')
          }
        }
      } finally { native.end() }
    } finally { await send('Runtime.releaseObject', { objectId: target }).catch(() => {}) }
    // This is an observation of the original acknowledged dispatch, including a
    // download trigger. Its animation cannot delay or replace the action result.
    if (press) try { void Promise.resolve(scope?.dispatched?.()).catch(() => {}) } catch { /* Decoration only. */ }
    return undefined
  }

  // One page program may issue concurrent calls. The intercepted native payload belongs to
  // exactly one drag; a second drag must not consume it or disable its interception.
  let dragging = false

  /** Native contacts, not device emulation. Every contact starts on a currently proved ref. */
  async function nativeTouch(scope: BrowserPageActionScope | undefined, kind: 'tap' | 'longPress' | 'swipe' | 'pinch', args: unknown[]): Promise<undefined> {
    const ref = requireString(args[0], 'ref')
    const destinationRef = kind === 'swipe' ? requireString(args[1], 'destinationRef') : undefined
    const raw = kind === 'pinch' || kind === 'longPress' ? args[1] : undefined
    if (args.length > (kind === 'tap' ? 1 : 2) || raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) throw new TypeError(`${kind} takes current refs and its declared gesture options.`)
    const options = (raw ?? {}) as Record<string, unknown>
    const field = kind === 'pinch' ? 'scale' : 'durationMs'
    if (Object.keys(options).some(key => key !== field)) throw new TypeError(`${kind} options only accept ${field}.`)
    const amount = options[field] ?? (kind === 'pinch' ? 2 : 600)
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) throw new TypeError(`${field} must be a positive finite number.`)
    const duration = kind === 'longPress' ? amount : 0
    if (duration && context.remainingMillis && duration >= context.remainingMillis()) throw notDispatched('The requested hold exceeds this program’s remaining execution time. Start a program with enough time; no contact was sent.')
    if (dragging) throw notDispatched('A native gesture is already in progress in this page program. Await it before starting another gesture.')
    dragging = true
    let navigationId: string | undefined
    let witnessHandle: { send: BrowserCdpSender; objectId: string } | undefined
    const handles: { send: BrowserCdpSender; objectId: string }[] = []
    let native: BrowserNativeInput | undefined, sent = false, phase = 'contact preparation'
    let guard = () => { context.signal?.throwIfAborted() }
    try {
      navigationId = context.pageInfo().navigationId
      const source = await actionTarget(scope, ref)
      const destination = destinationRef ? await actionTarget(scope, destinationRef, 'destination') : undefined
      guard = () => { context.signal?.throwIfAborted(); source.guard(); destination?.guard() }
      for (const target of [source, ...(destination ? [destination] : [])]) {
        await target.send('Runtime.callFunctionOn', { objectId: target.objectId, functionDeclaration: SCROLL_INTO_VIEW, awaitPromise: true, returnByValue: true })
        guard(); await target.actionFeedback?.(target.node, target.send); guard()
      }
      async function prepare(target: typeof source) {
        if (!target.node.frameId) throw notDispatched('The original touch document has no frame identity. Take a new snapshot().')
        const world = await target.send('Page.createIsolatedWorld', { frameId: target.node.frameId, worldName: BROWSER_NATIVE_INPUT_WORLD }) as { executionContextId: number }
        const resolved = await target.send('DOM.resolveNode', { backendNodeId: target.node.backendNodeId, executionContextId: world.executionContextId }) as { object?: { objectId?: string } }
        if (!resolved.object?.objectId) throw notDispatched('The original touch target is no longer inspectable. Take a new snapshot().')
        const value = { ...target, objectId: resolved.object.objectId, world: world.executionContextId }
        handles.push(value)
        return value
      }
      const from = await prepare(source), to = destination ? await prepare(destination) : undefined
      const point = (target: typeof from, at: string, fraction = 0.5) => nativePoint(at, target.send, target.objectId, target.node, target.world, fraction)
      const scale = context.inputScale?.() ?? 1
      const contact = (id: number, p: { x: number; y: number }) => ({ id, x: p.x * scale, y: p.y * scale, radiusX: 1, radiusY: 1, force: 1 })
      let start: ReturnType<typeof contact>[], finish: ReturnType<typeof contact>[] | undefined, pinchFinal = 0.5
      if (kind === 'pinch') {
        // Both initial and final contact points are inside the target's own content quad,
        // even for a transformed element. Hit-test each; a covered point sends no touch.
        const initial = 0.25 / Math.max(1, amount), final = initial * amount
        pinchFinal = final
        start = [contact(1, await point(from, ref, 0.5 - initial)), contact(2, await point(from, ref, 0.5 + initial))]
        finish = [contact(1, await point(from, ref, 0.5 - final)), contact(2, await point(from, ref, 0.5 + final))]
      } else {
        start = [contact(1, await point(from, ref))]
        if (to) finish = [contact(1, await point(to, destinationRef!))]
      }
      if (start.length === 2 && start[0]!.x === start[1]!.x && start[0]!.y === start[1]!.y) throw notDispatched('The target has no two distinct native contact points. Inspect a larger target.')
      const prepared = await from.send('Runtime.callFunctionOn', { objectId: from.objectId, functionDeclaration: PREPARE_TOUCH_WITNESS_DECLARATION,
        arguments: [{ value: start.length }], returnByValue: false }) as { result?: { objectId?: string }; exceptionDetails?: unknown }
      const witness = prepared.result?.objectId
      if (!witness || prepared.exceptionDetails) throw notDispatched('The original touch target could not be observed. No contact was sent.')
      witnessHandle = { send: from.send, objectId: witness }
      handles.push(witnessHandle)
      native = await context.beginNativeInput?.() ?? { input: <T>(command: () => Promise<T>) => command(), end: () => {} }
      const touch = async (type: string, touchPoints: ReturnType<typeof contact>[]) => {
        guard()
        if ((context.inputScale?.() ?? 1) !== scale) throw new Error('The original native input scale changed during the gesture.')
        phase = `native ${type} acknowledgement`; sent = true
        await native!.input(() => session.sendCommand('Input.dispatchTouchEvent', { type, touchPoints }))
        // A final acknowledged end may itself navigate. There is no further input to fence.
        if (type !== 'touchEnd') guard()
      }
      await touch('touchStart', start)
      phase = 'original contact target observation'
      if (await inWorld(from.send, witness, 'function () { return this.read() }') !== true) throw new Error('The trusted touch did not reach its original target.')
      phase = 'original contact hold'
      if (duration) await new Promise<void>((resolve, reject) => {
        // Node treats an overflowing timeout as 1ms. Split the wait, never the requested hold.
        const MAX_NODE_TIMER_MS = 2 ** 31 - 1, deadline = performance.now() + duration
        let timer: ReturnType<typeof setTimeout> | undefined
        const cleanup = () => { context.signal?.removeEventListener('abort', abort) }
        const abort = () => { clearTimeout(timer); cleanup(); reject(context.signal?.reason ?? new Error('The original touch hold was cancelled.')) }
        const next = () => {
          const left = deadline - performance.now()
          if (left <= 0) { cleanup(); resolve(); return }
          timer = setTimeout(next, Math.min(left, MAX_NODE_TIMER_MS))
        }
        context.signal?.addEventListener('abort', abort, { once: true })
        if (context.signal?.aborted) abort()
        else next()
      })
      if (finish) {
        phase = 'original destination validation'
        const actual = to ? [contact(1, await point(to, destinationRef!))]
          : [contact(1, await point(from, ref, 0.5 - pinchFinal)), contact(2, await point(from, ref, 0.5 + pinchFinal))]
        guard()
        if (actual.some((p, index) => p.x !== finish![index]!.x || p.y !== finish![index]!.y)) throw new Error('The original gesture destination moved after its contact started.')
        await touch('touchMove', finish)
      }
      await touch('touchEnd', [])
      try { void Promise.resolve(scope?.dispatched?.()).catch(() => {}) } catch { /* Decoration only. */ }
      return undefined

    } catch (cause) {
      if (!sent) throw cause
      // Cleanup is allowed only while the original action still owns this exact document.
      // After navigation, Stop or Take control no late end/cancel is sent to the new owner.
      try {
        guard()
        if (context.pageInfo().navigationId === navigationId) await native?.input(() => session.sendCommand('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }))
      } catch { /* An unknown contact is retained for observation or a new explicit gesture. */ }
      const detail = (cause instanceof Error ? cause.message : String(cause)).replace(/\p{White_Space}+/gu, ' ').trim().slice(0, 300)
      const failure = new BrowserLocalRecoveryFailure(`The native ${kind} may have affected the original page; ${phase} failed (${detail}). Completion is unknown. Inspect the original page. After control is explicitly returned, cdp("Input.dispatchTouchEvent", {type: "touchCancel", touchPoints: []}) can end remaining contacts before a new gesture.` +
        ' No interrupted gesture is automatically replayed.', 'locator-changed', 'unknown')
      failure.cause = cause
      throw failure
    } finally {
      if (witnessHandle) await inWorld(witnessHandle.send, witnessHandle.objectId, 'function () { this.dispose() }').catch(() => {})
      native?.end()
      for (const target of handles) await target.send('Runtime.releaseObject', { objectId: target.objectId }).catch(() => {})
      dragging = false
    }
  }
  async function nativeDrag(scope: BrowserPageActionScope | undefined, sourceRef: string, destinationRef: string): Promise<undefined> {
    if (dragging) throw notDispatched('A native drag is already in progress in this page program. Await it before starting another drag.')
    dragging = true
    let pressed = false, intercepted = false
    let phase = 'press acknowledgement'
    let data: unknown, cancelPoint: { x: number; y: number } | undefined
    let unobserve = () => {}
    const released: { send: BrowserCdpSender; objectId: string }[] = []
    let native: BrowserNativeInput | undefined
    try {
      const source = await actionTarget(scope, sourceRef)
      const destination = await actionTarget(scope, destinationRef, 'destination')
      const guard = () => { source.guard(); destination.guard() }
      // Scroll both before locating either point. If they cannot both be hit at once, do
      // not press; scrolling after a press would silently change the gesture's endpoint.
      for (const target of [source, destination]) {
        await target.send('Runtime.callFunctionOn', { objectId: target.objectId, functionDeclaration: SCROLL_INTO_VIEW, awaitPromise: true, returnByValue: true })
        guard()
        await target.actionFeedback?.(target.node, target.send)
        guard()
      }
      async function prepare(ref: string, target: typeof source) {
        if (!target.node.frameId) throw notDispatched(`The document holding ${ref} has no frame identity. Take a new snapshot().`)
        const world = await target.send('Page.createIsolatedWorld', { frameId: target.node.frameId, worldName: BROWSER_NATIVE_INPUT_WORLD }) as { executionContextId: number }
        const resolved = await target.send('DOM.resolveNode', { backendNodeId: target.node.backendNodeId, executionContextId: world.executionContextId }) as { object?: { objectId?: string } }
        const objectId = resolved.object?.objectId
        if (!objectId) throw notDispatched(`${ref} is no longer inspectable. Take a new snapshot().`)
        released.push({ send: target.send, objectId })
        const point = await nativePoint(ref, target.send, objectId, target.node, world.executionContextId)
        return { ...target, objectId, world: world.executionContextId, point }
      }
      const from = await prepare(sourceRef, source), to = await prepare(destinationRef, destination)
      guard()
      const scale = context.inputScale?.() ?? 1
      const start = { x: from.point.x * scale, y: from.point.y * scale }, end = { x: to.point.x * scale, y: to.point.y * scale }
      const distance = Math.hypot(end.x - start.x, end.y - start.y)
      if (!distance) throw notDispatched('The drag endpoints have the same native point. Inspect the source and destination before dragging.')
      native = await context.beginNativeInput?.() ?? { input: <T>(command: () => Promise<T>) => command(), end: () => {} }
      const input = (method: string, params: Record<string, unknown>) => native!.input(() => session.sendCommand(method, params))
      const mouse = (params: Record<string, unknown>) => input('Input.dispatchMouseEvent', params)
      unobserve = session.observe((method, params, sessionId) => {
        if (method === 'Input.dragIntercepted' && !sessionId) data = (params as { data?: unknown }).data
      })
      intercepted = true
      await session.sendCommand('Input.setInterceptDrags', { enabled: true })
      guard()
      if (!await witnessedPointerMove(from.send, from.objectId, () => mouse({ type: 'mouseMoved', ...start, button: 'none', buttons: 0 }))) throw notDispatched('The pointer did not land on the original drag source. Take a new snapshot().')
      guard()
      // A rejected press can still have reached Chromium. From this boundary onward a
      // failure is unknown, never a safe local retry or a release on a replacement page.
      pressed = true; cancelPoint = start
      await mouse({ type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1 })
      guard()
      phase = 'native drag movement'
      const fraction = Math.min(10 / distance, 0.5)
      await mouse({ type: 'mouseMoved', x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction, button: 'left', buttons: 1 })
      guard()
      cancelPoint = end
      await mouse({ type: 'mouseMoved', ...end, button: 'left', buttons: 1 })
      const checkDestination = async () => {
        phase = 'original drop-target validation'
        guard()
        const currentPoint = await nativePoint(destinationRef, to.send, to.objectId, to.node, to.world)
        if (currentPoint.x !== to.point.x || currentPoint.y !== to.point.y) throw new Error('The original drop target moved during the drag.')
        guard()
      }
      await checkDestination()
      if (data) {
        // The payload is Chromium's original dragIntercepted event, including MIME types
        // and allowed operations. No page DOM event or invented DataTransfer is used.
        for (const type of ['dragEnter', 'dragOver', 'drop']) {
          await checkDestination()
          phase = `native ${type} acknowledgement`
          await input('Input.dispatchDragEvent', { type, ...end, data })
        }
      } else {
        // HTML5 drop already ends Chromium's drag. Only pointer/mouse dragging
        // needs a release; another mouseup after drop could act on a new document.
        await checkDestination()
        phase = 'native pointer release acknowledgement'
        await mouse({ type: 'mouseReleased', ...end, button: 'left', buttons: 0, clickCount: 1 })
      }
      try { void Promise.resolve(scope?.dispatched?.()).catch(() => {}) } catch { /* Decoration only. */ }
      return undefined
    } catch (cause) {
      if (pressed) {
        // Cancel Chromium's original HTML drag, if any. Do not send a mouse release to a
        // changed document/target or after human takeover just to make cleanup look good.
        await native?.input(() => session.sendCommand('Input.dispatchDragEvent', { type: 'dragCancel', ...cancelPoint,
          data: data ?? { items: [], dragOperationsMask: 0 } })).catch(() => {
          context.note('Native drag cancellation could not be confirmed. The original Browser remains available; inspect its pointer state before acting again.')
        })
        const failure = new BrowserLocalRecoveryFailure(`The native drag may have affected the original page. Its ${phase} failed; completion is unknown. Inspect the original page before acting again.`, 'locator-changed', 'unknown')
        failure.cause = cause
        throw failure
      }
      throw cause
    } finally {
      unobserve()
      if (intercepted) {
        try { await session.sendCommand('Input.setInterceptDrags', { enabled: false }) }
        catch { context.note('The drag ended, but native drag interception cleanup could not be confirmed. The original Browser remains available. Inspect its input; cdp("Input.setInterceptDrags", {enabled: false}) in this Browser retries only that cleanup.') }
      }
      native?.end()
      for (const target of released) await target.send('Runtime.releaseObject', { objectId: target.objectId }).catch(() => {})
      dragging = false
    }
  }

  /**
   * One trusted native key press on the target: rawKeyDown, char (only for a key that types text),
   * keyUp, with key, code and windowsVirtualKeyCode, while the target holds page focus. This is the
   * sequence a hardware keyboard produces, so Chromium runs the key's default action (Enter submits a
   * form the way HTML implicit submission allows, Tab moves focus, Space activates a button). Focus
   * goes back to where it was afterwards (T-012), unless the key itself moved it (Tab, Enter on a
   * form), in which case the page's new focus is kept.
   */
  async function nativeKey(scope: BrowserPageActionScope | undefined, ref: string, rawKey: string): Promise<undefined> {
    // Parsed before anything is resolved, so an unknown modifier is refused without touching the page.
    const chord = parseKeyChord(rawKey)
    const modifierBits = chord.modifiers.reduce((bits, modifier) => bits | modifier.bit, 0)
    // Shift with a letter is that letter's capital, as for a person; other shifted characters are
    // layout-dependent, so a program passes the character itself ("!", not "Shift+1").
    const key = nativeKeyFor(modifierBits & 8 && /^[a-z]$/.test(chord.key) ? chord.key.toUpperCase() : chord.key)
    // With Control, Alt or Meta held the key is a shortcut, not text; Shift alone still types its character.
    const types = modifierBits === 0 || modifierBits === 8
    const editingCommand = editingCommandFor(modifierBits, key.code)
    const { objectId, send, node, guard, actionFeedback } = await actionTarget(scope, ref)
    guard()
    if (actionFeedback) {
      await actionFeedback(node, send)
      guard()
    }
    if (!node.frameId) throw notDispatched(`The document holding ${ref} has no frame identity, so it cannot take a key safely. Nothing was pressed; take a new snapshot().`)
    const world = await send('Page.createIsolatedWorld', { frameId: node.frameId, worldName: BROWSER_NATIVE_INPUT_WORLD })
      .catch(() => null) as { executionContextId?: number } | null
    if (!Number.isInteger(world?.executionContextId)) throw notDispatched(`The document holding ${ref} could not be inspected for a key press. Nothing was pressed; retry after a new snapshot().`)
    const isolated = await send('DOM.resolveNode', { backendNodeId: node.backendNodeId, executionContextId: world!.executionContextId })
      .catch(() => null) as { object?: { objectId?: string } } | null
    const target = isolated?.object?.objectId ?? objectId
    let focused = false
    try {
      const ready = await inWorld(send, target, FOCUS_FOR_KEY_DECLARATION) as { ok?: boolean; reason?: string } | undefined
      if (ready?.ok !== true) throw notDispatched(`${ref} ${ready?.reason ?? 'could not take focus'}. Nothing was pressed; choose the element that should receive the key.`)
      focused = true
      guard()
      const native = await context.beginNativeInput?.() ?? { input: <T>(command: () => Promise<T>) => command(), end: () => {} }
      const keyEvent = (params: Record<string, unknown>) => native.input(() => send('Input.dispatchKeyEvent', {
        key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode, modifiers: modifierBits, ...params }))
      const modifierEvent = (modifier: (typeof chord.modifiers)[number], type: 'rawKeyDown' | 'keyUp', bits: number) => native.input(() => send('Input.dispatchKeyEvent', {
        type, key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.keyCode, nativeVirtualKeyCode: modifier.keyCode, modifiers: bits }))
      const pressed: typeof chord.modifiers = []
      try {
        guard()
        // Modifiers go down in order, each carrying the bits held so far, as a person's would.
        for (const modifier of chord.modifiers) {
          pressed.push(modifier)
          await modifierEvent(modifier, 'rawKeyDown', pressed.reduce((bits, held) => bits | held.bit, 0))
        }
        await keyEvent({ type: 'rawKeyDown', ...(editingCommand ? { commands: [editingCommand] } : {}) })
        try {
          if (key.text !== undefined && types) await keyEvent({ type: 'char', text: key.text, unmodifiedText: key.text })
          await keyEvent({ type: 'keyUp' })
        } catch (error) {
          throw new Error(`${ref} received ${rawKey === ' ' ? 'Space' : rawKey} down but its release was not confirmed (${error instanceof Error ? error.message : String(error)}). ` +
            'The key may or may not have acted; inspect the page before pressing again.')
        }
      } finally {
        // Every modifier that went down comes back up, even after a failure, so none stays held for a person.
        for (let index = pressed.length - 1; index >= 0; index--) {
          const remaining = pressed.slice(0, index).reduce((bits, held) => bits | held.bit, 0)
          await modifierEvent(pressed[index]!, 'keyUp', remaining).catch(() => {})
        }
        native.end()
      }
    } finally {
      if (focused) await inWorld(send, target, RESTORE_TEXT_FOCUS_DECLARATION)
      if (target !== objectId) await send('Runtime.releaseObject', { objectId: target }).catch(() => {})
    }
    return undefined
  }

  /**
   * Fill a file chooser the page opened, by its handle from pageInfo().fileChooser. The chooser names
   * the file input by backend node id on the session it opened in; that id is resolved there, never on
   * another session, and the existing upload owner stages, assigns and verifies the files.
   */
  async function uploadToChooser(handle: string, paths: unknown): Promise<unknown> {
    const chooser = context.interrupts?.chooser(handle)
    if (!chooser) {
      throw new BrowserLocalRecoveryFailure(`${handle} is not an open file chooser: it was filled, replaced by a newer one, or its page navigated. ` +
        'Nothing was sent; read pageInfo().fileChooser for the current one.', 'locator-changed', 'not-dispatched')
    }
    const send = chooser.sessionId ? session.frames.get(chooser.sessionId) : session.sendCommand
    if (!send) throw new BrowserLocalRecoveryFailure(`The frame that opened ${handle} went away. Nothing was sent.`, 'locator-changed', 'not-dispatched')
    const resolved = await send('DOM.resolveNode', { backendNodeId: chooser.backendNodeId }).catch(() => null) as { object?: { objectId?: string } } | null
    const objectId = resolved?.object?.objectId
    if (!objectId) throw new BrowserLocalRecoveryFailure(`The file input behind ${handle} is gone. Nothing was sent.`, 'locator-changed', 'not-dispatched')
    try {
      const receipt = await context.uploads!.upload({ objectId, sendCommand: send }, paths)
      context.interrupts?.consumeChooser(handle)
      return receipt
    } catch (error) {
      if (error instanceof BrowserUploadUnconfirmedError) { context.interrupts?.consumeChooser(handle); context.note(error.message) }
      throw error
    }
  }

  /** Set a picker's value. typeText on a picker has nothing to append to, so it is refused before anything changes. */
  async function pickerValue(ref: string, send: typeof session.sendCommand, target: string, value: string, replace: boolean, guard: () => void): Promise<undefined> {
    if (!replace) throw notDispatched(`${ref} is a picker (date, time, color, range or select), so text cannot be appended. Nothing changed; use fillInput with the whole value.`)
    guard()
    const set = await inWorld(send, target, SET_PICKER_VALUE_DECLARATION, [{ value }]) as
      { ok?: boolean; reason?: string; taken?: string; after?: string; wanted?: string } | undefined
    // No answer may come after the setter ran, so whether the field changed is unknown.
    if (set === undefined) {
      throw new BrowserLocalRecoveryFailure(`${ref} did not answer after its value was sent, so whether it changed is unknown. Read the field before setting it again.`,
        'locator-changed', 'unknown')
    }
    // Every refusal is decided before the setter runs, so the field keeps its value.
    if (set.ok !== true) throw notDispatched(`${ref} ${set.reason ?? 'could not take a value'}. Nothing changed.`)
    if (set.taken !== set.wanted) {
      context.note(`${ref} holds ${JSON.stringify(set.taken)} rather than ${JSON.stringify(value)}; the field normalized it. Read it before relying on it.`)
    } else if (set.after !== set.taken) {
      context.note(`${ref} now holds ${JSON.stringify(set.after)}; the page changed the value after it was set. Read it before relying on it.`)
    }
    return undefined
  }

  /**
   * Trusted native text input into the target: `Input.insertText` after placing the caret, then the
   * value is read back.
   *
   * Same order as click: guard, scroll, guard, target feedback, guard. The field is focused and its
   * caret placed in an isolated world; then Main's own-dispatch receipt opens and the text is inserted.
   * Page handlers may reformat what was typed (masks, upper-casing), so a read-back that differs is not
   * a failure by itself: it is reported with the value the page now holds. A read-back that still
   * equals the text from before is unknown: the insert was acknowledged, and an editor with its own
   * text model may have taken it. A picker (date, select and the like) takes a value instead.
   */
  async function nativeText(scope: BrowserPageActionScope | undefined, ref: string, text: string, replace: boolean): Promise<undefined> {
    const { objectId, send, node, guard, actionFeedback } = await actionTarget(scope, ref)
    const prepared = await send('Runtime.callFunctionOn', { objectId, functionDeclaration: SCROLL_INTO_VIEW,
      awaitPromise: true, returnByValue: true }) as { exceptionDetails?: { text?: string } }
    if (prepared.exceptionDetails) throw new Error(`The page threw while preparing ${ref}: ${pageAuthoredText(prepared.exceptionDetails.text)}`)
    guard()
    if (actionFeedback) {
      await actionFeedback(node, send)
      guard()
    }
    if (!node.frameId) throw notDispatched(`The document holding ${ref} has no frame identity, so it cannot take text safely. Nothing was typed; take a new snapshot().`)
    const world = await send('Page.createIsolatedWorld', { frameId: node.frameId, worldName: BROWSER_NATIVE_INPUT_WORLD })
      .catch(() => null) as { executionContextId?: number } | null
    if (!Number.isInteger(world?.executionContextId)) throw notDispatched(`The document holding ${ref} could not be inspected for text input. Nothing was typed; retry after a new snapshot().`)
    const isolated = await send('DOM.resolveNode', { backendNodeId: node.backendNodeId, executionContextId: world!.executionContextId })
      .catch(() => null) as { object?: { objectId?: string } } | null
    const target = isolated?.object?.objectId
    if (!target) throw notDispatched(`${ref} could not be inspected for text input. Nothing was typed; take a new snapshot().`)
    let focused = false
    try {
      const ready = await inWorld(send, target, PREPARE_TEXT_DECLARATION, [{ value: replace }]) as
        { ok?: boolean; reason?: string; before?: unknown; caret?: string } | undefined
      if ((ready as { picker?: boolean } | undefined)?.picker) return await pickerValue(ref, send, target, text, replace, guard)
      if (ready?.ok !== true || typeof ready.before !== 'string') {
        throw notDispatched(`${ref} ${ready?.reason ?? 'could not be prepared for text input'}. Nothing was typed; choose the actual text field or take a new snapshot().`)
      }
      focused = true
      guard()
      const native = await context.beginNativeInput?.() ?? { input: <T>(command: () => Promise<T>) => command(), end: () => {} }
      try {
        guard()
        if (!replace && ready.caret === 'end-key') {
          // Email and number inputs expose no selection range; a native End key moves their caret.
          for (const type of ['rawKeyDown', 'keyUp']) {
            await native.input(() => session.sendCommand('Input.dispatchKeyEvent', { type, key: 'End', code: 'End', windowsVirtualKeyCode: 35,
              ...(type === 'rawKeyDown' ? { commands: ['moveToEndOfDocument'] } : {}) }))
          }
        }
        // An empty fill clears the selected text; an empty append changes nothing and sends nothing.
        if (text !== '') await native.input(() => send('Input.insertText', { text }))
        else if (replace && ready.before !== '') {
          for (const type of ['rawKeyDown', 'keyUp']) {
            await native.input(() => session.sendCommand('Input.dispatchKeyEvent', { type, key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46,
              ...(type === 'rawKeyDown' ? { commands: ['deleteForward'] } : {}) }))
          }
        }
      } finally { native.end() }
      const after = await inWorld(send, target, READ_TEXT_DECLARATION)
      const expected = replace ? text : ready.before + text
      if (typeof after !== 'string') {
        throw new Error(`Text was sent to ${ref}, but its value could not be read back. Inspect the field before typing again.`)
      }
      if (after !== expected) {
        if (after === ready.before && expected !== ready.before) {
          // The trusted insert was acknowledged, so the page received it; an editor that keeps its own
          // text model may have taken it without showing it here. Typing again could enter it twice.
          throw new BrowserLocalRecoveryFailure(`${ref} still shows its earlier value after the text was sent. The page may have taken the text anyway; read the field before typing again.`,
            'locator-changed', 'unknown')
        }
        context.note(`${ref} now holds a different value than was typed; the page changed it (for example a mask or a formatter). ` +
          `Read the field before relying on it.`)
      }
    } finally {
      if (focused) await inWorld(send, target, RESTORE_TEXT_FOCUS_DECLARATION)
      await send('Runtime.releaseObject', { objectId: target }).catch(() => {})
    }
    return undefined
  }

  /** 在一个句柄上跑一小段函数。click 和文字输入以外的动作暂时还走这条路。 */
  async function callOn(scope: BrowserPageActionScope | undefined, ref: string, declaration: string, extra: unknown[] = [], feedback?: { scroll: string; action: string } | 'observe'): Promise<unknown> {
    const { objectId, send, node, guard, actionFeedback } = await actionTarget(scope, ref)
    if (actionFeedback && feedback !== 'observe') {
      if (feedback) {
        const prepared = await send('Runtime.callFunctionOn', { objectId, functionDeclaration: feedback.scroll,
          awaitPromise: true, returnByValue: true }) as { exceptionDetails?: { text?: string } }
        if (prepared.exceptionDetails) throw new Error(`The page threw while preparing ${ref}: ${pageAuthoredText(prepared.exceptionDetails.text)}`)
        guard()
        declaration = feedback.action
      }
      await actionFeedback(node, send)
      // Display work can yield to real takeover, navigation or stop. Recheck before the original action.
      guard()
    }
    const response = (await send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: declaration,
      arguments: extra.map((value) => ({ value })),
      awaitPromise: true,
      returnByValue: true
    })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } }
    // CDP 在"函数抛了"这件事上**不 reject**，它把异常放进 exceptionDetails 照常返回。
    // 不看这个字段，页面里抛的错会被读成成功，而 Agent 拿到的是 undefined。
    if (response.exceptionDetails) {
      throw new Error(`The page threw while acting on ${ref}: ${pageAuthoredText(response.exceptionDetails.text)}`)
    }
    // This is an observation of the original acknowledged dispatch, including a
    // download trigger. Its animation cannot delay or replace the action result.
    try { void Promise.resolve(scope?.dispatched?.()).catch(() => {}) } catch { /* Decoration only. */ }
    return response.result?.value
  }

  async function extractStructured(input: unknown): Promise<unknown> {
    const request = parseBrowserStructuredOutputRequest(input)
    if (!context.structuredOutput) throw new Error('Structured observation ownership is unavailable for this Browser.')
    const owner = context.structuredOutput.source()
    const info = context.pageInfo()
    let send = session.sendCommand
    let sessionId: string | undefined
    let backendNodeId: number | undefined
    if (request.withinRef) {
      if (!issued?.has(request.withinRef) || !current || expired.has(request.withinRef)) {
        throw new Error('Structured withinRef requires an issued ref from this run’s latest snapshot(). Take a current snapshot before extraction.')
      }
      const target = await handleIn(current, request.withinRef)
      send = target.send
      sessionId = target.node.sessionId
      backendNodeId = target.node.backendNodeId
      await send('Runtime.releaseObject', { objectId: target.objectId }).catch(() => {})
    }
    const target = await resolveBrowserStructuredTarget(send, {
      ...(request.within ? { within: request.within } : {}), ...(backendNodeId !== undefined ? { backendNodeId } : {})
    })
    try {
      const receipt = await extractBrowserStructuredOutput(request, {
        source: { ...owner, url: info.url, document: target.document,
          scope: { kind: request.within || request.withinRef ? 'subtree' : 'page',
            ...(request.within ? { within: request.within } : {}), ...(request.withinRef ? { withinRef: request.withinRef } : {}) } },
        isCurrent: async () => {
          if (!context.structuredOutput!.isCurrent(owner.navigationId) ||
              context.pageInfo().navigationId !== owner.navigationId || session.endedReason !== null ||
              (sessionId ? session.frames.get(sessionId) !== send : send !== session.sendCommand)) return false
          return await target.isCurrent() && context.structuredOutput!.isCurrent(owner.navigationId)
        },
        read: async (functionDeclaration, value) => {
          const response = await send('Runtime.callFunctionOn', { objectId: target.objectId, functionDeclaration,
            arguments: [{ value }], awaitPromise: true, returnByValue: true }) as {
            result?: { value?: unknown }; exceptionDetails?: { text?: string }
          }
          if (response.exceptionDetails) throw new Error(`Structured observation could not read its rooted document: ${pageAuthoredText(response.exceptionDetails.text)}`)
          return response.result?.value
        },
        register: async (value, source) => {
          if (!context.resultArtifacts) throw new Error('Durable structured results are unavailable for this Browser.')
          return await context.resultArtifacts.store.registerJSON({ workspaceId: source.workspaceId,
            browserId: source.browserId, operationId: source.operationId, navigationId: source.navigationId }, value)
        }
      })
      if (receipt.warning) context.note(receipt.warning)
      return receipt
    } finally {
      await target.release()
    }
  }

  /** 等一个条件成立，超时就说清等的是什么、等了多久——"timeout" 三个字帮不了任何人。 */
  async function until(what: string, timeoutMs: number, probe: () => Promise<boolean>): Promise<void> {
    // Keep a margin so the reason below reaches the program before the program's own budget ends.
    const left = context.remainingMillis ? context.remainingMillis() - WAIT_RETURN_MARGIN_MS : Infinity
    const budget = Math.max(0, Math.min(timeoutMs, left))
    const capped = budget < timeoutMs
    const deadline = Date.now() + budget
    for (;;) {
      if (await probe()) return
      if (Date.now() >= deadline) {
        throw new Error(capped
          ? `Stopped waiting for ${what} after ${budget}ms because this program's time is almost up. Earlier steps stand; take a snapshot to see the page, then continue in a new program.`
          : `Timed out after ${timeoutMs}ms waiting for ${what}.`)
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
    }
  }

  return async (name, args, scope) => {
    switch (name) {
      case 'routeRequests':
      case 'unrouteRequests':
      case 'setNetworkConditions':
      case 'clearNetworkConditions': {
        const takesInput = name === 'routeRequests' || name === 'setNetworkConditions'
        if (args.length !== (takesInput ? 1 : 0)) throw new TypeError('Unexpected network-rule arguments.')
        const owner = networkRouting()
        if (name === 'routeRequests') return await owner.route(args[0])
        if (name === 'unrouteRequests') return await owner.unroute()
        if (name === 'setNetworkConditions') return await owner.setConditions(args[0])
        return await owner.clearConditions()
      }
      case 'watchRequests':
      case 'readRequests':
      case 'waitForResponse':
      case 'stopWatchingRequests': {
        const maximum = name === 'watchRequests' ? 1 : name === 'stopWatchingRequests' ? 1 : name === 'readRequests' ? 2 : 3
        if (args.length > maximum) throw new TypeError('Unexpected network observation arguments.')
        const observation = networkObservations()
        if (name === 'watchRequests') return await observation.watch(args[0])
        if (name === 'readRequests') return observation.read(args[0], args[1])
        if (name === 'waitForResponse') return await observation.waitForResponse(args[0], args[1], args[2])
        return observation.stop(args[0])
      }
      case 'readResult': {
        if (!context.resultArtifacts) throw new Error('Durable result reading is unavailable for this Browser.')
        const options = args[1]
        if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) {
          throw new TypeError('readResult options must contain offset and maxBytes.')
        }
        return await readBrowserResultArtifact(context.resultArtifacts.store,
          args[0] as BrowserResultArtifactReference, context.resultArtifacts.owner,
          options as BrowserResultReadOptions | undefined)
      }
      case 'download': {
        if (!context.downloads) throw new Error('Downloads are unavailable for this Browser. Existing Browser work remains.')
        const options = args[1]
        if (!options || typeof options !== 'object' || Array.isArray(options) ||
            Object.keys(options).some(key => !['path', 'timeoutMs', 'maxBytes'].includes(key))) {
          throw new TypeError('download requires {path, timeoutMs?, maxBytes?}.')
        }
        const input = options as Record<string, unknown>
        if ((input.timeoutMs !== undefined && typeof input.timeoutMs !== 'number') ||
            (input.maxBytes !== undefined && typeof input.maxBytes !== 'number')) throw new TypeError('Download budgets must be numbers.')
        const ref = requireString(args[0], 'ref')
        const receipt = await context.downloads.download(async () => await nativeClick(scope, ref),
          { path: requireString(input.path, 'path'),
            ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}),
            ...(typeof input.maxBytes === 'number' ? { maxBytes: input.maxBytes } : {}) })
        const warning = receipt.warning ?? (receipt.status !== 'completed'
          ? `Chromium download ${receipt.status}; no completed Workspace file is available. Inspect the page before triggering it again.` : undefined)
        if (warning) context.note(warning)
        return receipt
      }
      case 'uploadFiles': {
        if (!context.uploads) throw new Error('Uploads are unavailable for this Browser. Existing Browser work remains.')
        const ref = requireString(args[0], 'ref')
        // A chooser the page opened: resolve its file input on the session it opened in, then the same upload owner.
        if (ref.startsWith('chooser-')) return await uploadToChooser(ref, args[1])
        if (!current || !issued?.has(ref) || expired.has(ref)) {
          throw new Error('Upload requires a ref issued by the latest snapshot in this run. Take a fresh snapshot and choose the actual file input.')
        }
        const snapshot = current
        const target = await handleIn(snapshot, ref)
        if (current !== snapshot || !issued?.has(ref) || expired.has(ref) || context.pageInfo().navigationId !== snapshot.navigationId) {
          throw new Error('The upload snapshot changed. Take a fresh snapshot and choose the actual file input again.')
        }
        const same = snapshot.nodes.filter(node => node.role === target.node.role && node.name === target.node.name)
        const recordTarget = scope?.recordTarget ?? context.recordTarget
      recordTarget?.({ role: target.node.role, name: target.node.name,
          ordinal: same.findIndex(node => node.ref === ref) + 1, count: same.length })
        try {
          return await context.uploads.upload({ objectId: target.objectId, sendCommand: target.send }, args[1])
        } catch (error) {
          if (error instanceof BrowserUploadUnconfirmedError) context.note(error.message)
          throw error
        }
      }
      case 'readDownload': {
        if (!context.downloads) throw new Error('Download reading is unavailable for this Browser.')
        const options = args[1]
        if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options) ||
            Object.keys(options).some(key => !['offset', 'maxBytes'].includes(key)))) {
          throw new TypeError('readDownload accepts only {offset?, maxBytes?}.')
        }
        return await context.downloads.read(args[0] as BrowserDownloadReference, options as BrowserDownloadReadOptions | undefined)
      }
      // ── 观察 ──────────────────────────────────────────────────────────
      case 'snapshot':
        return await publishSnapshot(parseBrowserSnapshotQuery(args[0]))
      case 'snapshotText': {
        const snapshot = await publishSnapshot(parseBrowserSnapshotQuery(args[0]))
        return renderBrowserSnapshotText(snapshot, snapshot.observation)
      }
      case 'pageInfo': {
        // A chooser the page opened is part of what the page is showing; a program fills it with uploadFiles(handle, paths).
        const fileChooser = context.interrupts?.pendingChooser()
        return fileChooser ? { ...context.pageInfo(), fileChooser } : context.pageInfo()
      }
      case 'extractStructured':
        return await extractStructured(args[0])
      case 'captureScreenshot':
        return await context.captureScreenshot()
      case 'elementContext': {
        // Agent 读一个元素的完整上下文。**不经指针事件**——目标由 `callOn` 解出来的 CDP 句柄指定，
        // 页面脚本没有机会自己挑目标。人工选择那条路上的 `event.isTrusted` 门禁原样不动：
        // 那是防网页脚本伪造"人选的"的真实边界，这条新入口不碰它（设计 SSOT 的约束）。
        //
        // 归 `observe`：只读，连 scrollIntoView 都不做（那会挪走人此刻正在看的位置）。所以人工
        // 接管之后照常放行。
        const ref = requireString(args[0], 'ref')
        const raw = await callOn(scope, ref, buildBrowserElementContextDeclaration(), [], 'observe')
        // `this` 不是 Element 时页面侧返回 null。这一条要单独成话：它和"ref 解不开"是完全不同的
        // 下一步——前者是 ref 指向了一个文本节点之类，后者是那个 ref 根本不在页面上（`handleFor`
        // 已经各自成话了）。含混成一句会让 Agent 不知道该换 ref 还是该重新 snapshot。
        if (raw === null) {
          throw new Error(`${ref} does not point at an element, so it has no element context. Take a fresh snapshot() and use a ref from it.`)
        }
        // 与人工选择走同一道脱敏（同一组固定键 assertExactKeys）。脱敏抛出来的是"提取结果形状不对"
        // ——那是我们自己的 bug 或者页面返回了意外的东西，不该被当成"元素不存在"。
        return sanitizeBrowserElementSelection(raw)
      }

      // ── 动作（全部按 ref） ─────────────────────────────────────────────
      case 'click': {
        // A trusted native press at the element's box, not `this.click()`: pages that ignore
        // synthetic events (isTrusted=false) then behave as they do for a person. Options are read
        // first, so a bad one is refused before the target is touched.
        const options = clickOptions(args[1])
        return await nativeClick(scope, requireString(args[0], 'ref'), true, options)
      }
      case 'fillInput':
        // Native Input.insertText over the whole selection: React/Vue controlled inputs see a real,
        // trusted beforeinput/input pair, and change fires when focus returns, as it does for a person.
        return await nativeText(scope, requireString(args[0], 'ref'), requireString(args[1], 'text'), true)
      case 'typeText':
        // Append at the end of what the field holds. One insert, not per-character key simulation.
        return await nativeText(scope, requireString(args[0], 'ref'), requireString(args[1], 'text'), false)
      case 'pressKey':
        // The key goes to the element's page focus, not the window: the window focus a person is using
        // is never taken (T-012). Page focus returns afterwards unless the key moved it.
        return await nativeKey(scope, requireString(args[0], 'ref'), requireString(args[1], 'key'))
      case 'tap':
      case 'longPress':
      case 'swipe':
      case 'pinch':
        return await nativeTouch(scope, name, args)
      case 'drag':
        if (args.length !== 2 || args.some(ref => typeof ref !== 'string' || !ref.startsWith('@'))) throw new Error('drag requires sourceRef and destinationRef from snapshot().')
        return await nativeDrag(scope, args[0] as string, args[1] as string)
      case 'hover':
        // A native pointer move to the proven box, confirmed by Chromium's own :hover; no press.
        return await nativeClick(scope, requireString(args[0], 'ref'), false)
      case 'scroll':
        return await callOn(
          scope,
          requireString(args[0], 'ref'),
          'function () { this.scrollIntoView({block: "center", behavior: "instant"}) }', [],
          { scroll: 'function () { this.scrollIntoView({block: "center", behavior: "instant"}) }', action: 'function () {}' }
        )

      // ── 等待 ──────────────────────────────────────────────────────────
      case 'waitForElement': {
        // 按**名字**等，不按 ref：ref 是快照发出来的，还没出现的元素当然没有 ref。
        const wanted = requireString(args[0], 'name')
        // waitForElement(name, timeoutMs) or waitForElement(name, {timeoutMs, exact, role}).
        const options = args[1] !== null && typeof args[1] === 'object' && !Array.isArray(args[1]) ? args[1] as { timeoutMs?: unknown; exact?: unknown; role?: unknown } : {}
        const timeoutMs = typeof args[1] === 'number' ? args[1] : typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_WAIT_MS
        const exact = options.exact === true
        const role = typeof options.role === 'string' ? options.role : undefined
        // A substring match takes "Save" for "Save draft"; exact and role say which one is meant.
        const matches = (node: BrowserPageNode) => node.ref !== '' && (exact ? node.name === wanted : node.name.includes(wanted)) && (role === undefined || node.role === role)
        await until(`${role ? `a ${role}` : 'an element'} named ${exact ? 'exactly ' : ''}${JSON.stringify(wanted)}`, timeoutMs, async () => {
          const snapshot = await takeSnapshot()
          return snapshot.nodes.some(matches)
        })
        // 等到了才认领这批 ref：轮询途中那些快照的编号从没离开过这里，认领它们等于把还没
        // 交给 Agent 的 ref 当成已交付的。
        return await publishSnapshot(parseBrowserSnapshotQuery(undefined))
      }
      case 'waitForLoad': {
        const timeoutMs = typeof args[0] === 'number' ? args[0] : DEFAULT_WAIT_MS
        // "Loaded" belongs to one document. A readyState read is only kept when the page Main reports
        // is the same before and after it, so a navigation during the read cannot pass for the new page.
        let loaded: { url: string; navigationId: string } | null = null
        await until('the page to finish loading', timeoutMs, async () => {
          const before = context.pageInfo()
          const state = (await session.sendCommand('Runtime.evaluate', {
            expression: 'document.readyState',
            returnByValue: true
          })) as { result?: { value?: unknown } }
          const after = context.pageInfo()
          if (state.result?.value !== 'complete' || after.navigationId !== before.navigationId) return false
          loaded = { url: after.url, navigationId: after.navigationId }
          return true
        })
        // The page that finished, so a program can tell which document it now acts on.
        return loaded
      }
      case 'waitForUrl': {
        // The page Main reports, not the page's own location: a pushState that Main has not seen is
        // not a navigation it can act on. A string matches the whole URL; {contains} matches part of it.
        const wanted = args[0]
        const timeoutMs = typeof args[1] === 'number' ? args[1] : DEFAULT_WAIT_MS
        const test = urlCondition(wanted)
        let reached: { url: string; navigationId: string } | null = null
        await until(`the page to reach ${JSON.stringify(wanted)}`, timeoutMs, async () => {
          const page = context.pageInfo()
          if (!test(page.url)) return false
          reached = { url: page.url, navigationId: page.navigationId }
          return true
        })
        // A new document voids every ref; the program takes a fresh snapshot of the page it reached.
        return reached
      }
      case 'waitForNetworkIdle': {
        const timeoutMs = typeof args[0] === 'number' ? args[0] : DEFAULT_WAIT_MS
        // 数在途请求，**不是**睡一个固定时长。固定时长在慢网络上撒谎，而撒的谎是"加载完了"。
        let inFlight = 0
        let lastChange = Date.now()
        await session.sendCommand('Network.enable')
        const stop = session.observe((method) => {
          if (method === 'Network.requestWillBeSent') {
            inFlight += 1
            lastChange = Date.now()
          } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
            inFlight = Math.max(0, inFlight - 1)
            lastChange = Date.now()
          }
        })
        try {
          await until('the network to go quiet', timeoutMs, async () =>
            inFlight === 0 && Date.now() - lastChange >= NETWORK_IDLE_QUIET_MS
          )
        } finally {
          stop()
        }
        return null
      }
      case 'wait': {
        const ms = typeof args[0] === 'number' ? args[0] : 0
        await new Promise((resolve) => setTimeout(resolve, ms))
        return null
      }

      // ── 导航 ──────────────────────────────────────────────────────────
      case 'gotoUrl': {
        await context.gotoUrl(requireString(args[0], 'url'))
        // 导航之后旧快照的每个 ref 都作废。不丢掉它，下一次 click 会拿旧地图去解——
        // backendNodeId 可能还解得开，只是解到了新页面上一个毫不相干的节点。
        // `issued` 也要一起丢：留着它，旧编号会在新页面的快照里"认识"，而那是撞号不是认领。
        current = null
        issued = null
        return null
      }

      // ── 逃生口 ────────────────────────────────────────────────────────
      case 'js': {
        const expression = requireString(args[0], 'expression')
        // Bounded by the program's remaining time. Chromium's own timeout stops a synchronous loop but
        // not a promise that never settles, so the await is also raced; on expiry the page's script is
        // terminated, which leaves the page itself usable.
        const left = context.remainingMillis ? context.remainingMillis() - WAIT_RETURN_MARGIN_MS : Infinity
        const bounded = Number.isFinite(left)
        const budget = Math.max(1, Math.floor(left))
        let timer: ReturnType<typeof setTimeout> | undefined
        const expired = new Promise<'expired'>(resolve => { if (bounded) timer = setTimeout(() => resolve('expired'), budget) })
        const evaluated = await Promise.race([session.sendCommand('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
          ...(bounded ? { timeout: budget } : {})
        }), expired]).finally(() => clearTimeout(timer)) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } } | 'expired'
        if (evaluated === 'expired' || evaluated.exceptionDetails?.text === 'Execution was terminated') {
          await session.sendCommand('Runtime.terminateExecution').catch(() => {})
          throw new Error(`js() was stopped after ${budget}ms because this program's time is almost up. Its effect on the page is unknown; take a snapshot before continuing.`)
        }
        if (evaluated.exceptionDetails) {
          throw new Error(`The page threw: ${pageAuthoredText(evaluated.exceptionDetails.text)}`)
        }
        return evaluated.result?.value
      }
      case 'acceptDialog':
      case 'dismissDialog': {
        if (!context.interrupts) throw new BrowserLocalRecoveryFailure('This Browser does not answer page dialogs from a program. Nothing was sent.', 'page-dialog', 'not-dispatched')
        const promptText = name === 'acceptDialog' && args[0] !== undefined ? requireString(args[0], 'promptText') : undefined
        return await context.interrupts.answer(name === 'acceptDialog', promptText)
      }

      case 'cdp': {
        const method = requireString(args[0], 'method')
        const params = (args[1] ?? {}) as Record<string, unknown>
        if (method === 'Page.handleJavaScriptDialog') {
          if (typeof params.accept !== 'boolean' || params.promptText !== undefined && typeof params.promptText !== 'string') throw new TypeError('Page.handleJavaScriptDialog requires {accept:boolean,promptText?:string}.')
          if (context.interrupts) return await context.interrupts.answerRaw(params.accept, params.promptText as string | undefined)
          if (!params.accept) return await session.sendCommand(method, params)
          throw new BrowserLocalRecoveryFailure('The current dialog kind is unknown, so approval was not sent. Other Browser calls remain available; cancel this original dialog with {accept:false} or use a host that observes it.', 'page-dialog', 'not-dispatched')
        }
        // The escape hatch reaches only this page. Commands whose effect goes past it are refused
        // before anything is sent, with the ability to use instead (browser-cdp-scope.ts).
        const refusal = browserCdpScopeRefusal(method)
        if (refusal) {
          throw new BrowserLocalRecoveryFailure(`cdp('${method}') ${refusal.reason}, so a page program cannot send it. Nothing was sent. ${refusal.instead}`,
            'cdp-scope', 'not-dispatched')
        }
        if (!isBrowserCdpNativeInput(method)) return await session.sendCommand(method, params)
        // Raw native input is the Agent's own input too: send it under Main's receipt so it never
        // reads as a person taking over, exactly like click() and typeText().
        const native = await context.beginNativeInput?.() ?? { input: <T>(command: () => Promise<T>) => command(), end: () => {} }
        try { return await native.input(() => session.sendCommand(method, params)) } finally { native.end() }
      }

      default:
        // 注入了却没派发的名字会让 Agent 收到一句无从下手的话。这里点名它是谁、以及现在能用什么。
        throw new Error(
          `Page function "${name}" is injected but this Browser cannot serve it. ` +
            'An AgentMux Browser is a single page, so it has no tabs of its own — ' +
            'use gotoUrl() here, and `amux browser open` to get another page.'
        )
    }
  }
}
