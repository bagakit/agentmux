import type { BrowserPageSnapshot } from '../shared/contracts.js'
import type { BrowserCdpSession } from './browser-cdp-session.js'
import { captureBrowserPageSnapshot } from './browser-page-snapshot.js'
import { resolveBrowserRef } from './browser-ref-resolve.js'

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
 * 解开它就必须还记得那张快照。缓存活在一次驱动之内——跨轮次、跨重启的持久化是 T-011 的事，
 * 这里不提前造它。
 */

/** 一次驱动期间，这一层需要从 Browser 那里知道的东西。传闭包而不是传整个 manager：依赖收到最小。 */
export type BrowserPageContext = {
  session: BrowserCdpSession
  /** 当前页面身份。每次调用现取——导航可能发生在两次页面函数之间。 */
  pageInfo(): { url: string; title: string; navigationId: string }
  /** 导航到一个地址，等它停下来。 */
  gotoUrl(url: string): Promise<void>
  /** 截图走 Electron 的 capturePage，与 Agent 无关的那条既有路径。 */
  captureScreenshot(): Promise<unknown>
}

/** 默认的等待上限。脚本整体还有自己的超时兜底，这里只防"一个 wait 把整轮吃光"。 */
const DEFAULT_WAIT_MS = 10_000
/** 网络安静判定：这么久没有新请求就算静了。取自 CDP 惯例，不是可调项——调它只会让判据变模糊。 */
const NETWORK_IDLE_QUIET_MS = 500

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string, got ${typeof value}`)
  return value
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
    return new Error(
      `The page navigated since that snapshot was taken (${reason.snapshotNavigationId} → ` +
        `${reason.currentNavigationId}), so every ref in it is void, ${reason.ref} included. Take a new snapshot().`
    )
  }
  return new Error(`Element ${reason.ref} is gone from the page (${reason.reason}). Take a new snapshot().`)
}

/**
 * 把一棵快照渲染成给 Agent 读的文本。
 *
 * 缩进表示结构，`@eN` 是可操作的把手。**缺失的 frame 附在末尾**——一张有洞的地图必须自己说明哪里
 * 有洞，否则 Agent 会把"没列出来"读成"页面上没有"。
 */
export function renderBrowserSnapshotText(snapshot: BrowserPageSnapshot): string {
  const lines = [`${snapshot.title} — ${snapshot.url}`]
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
export function createBrowserPageDispatch(
  context: BrowserPageContext
): (name: string, args: unknown[]) => Promise<unknown> {
  const { session } = context
  // 最近一张快照。ref 只在发出它的那张快照里有意义，所以这里只留一张——留多张等于允许
  // Agent 拿两轮之前的 ref 说话，而那些 ref 指向的元素早就不在了。
  let current: BrowserPageSnapshot | null = null

  async function takeSnapshot(): Promise<BrowserPageSnapshot> {
    const info = context.pageInfo()
    const snapshot = await captureBrowserPageSnapshot({
      send: session.send,
      url: info.url,
      title: info.title,
      navigationId: info.navigationId,
      frames: session.frames
    })
    // 子 frame 的自动 attach 没建立起来时，跨域 iframe 一个都不会被枚举——于是 `missingFrames`
    // 是空的，因为它只在**尝试过**某个 frame 时才写入。空的 missingFrames 在 Agent 眼里就是
    // "这页没有 iframe"。这里把那个洞补上：够不着也要说出来，不阻断（原则 11 的第 2 类）。
    const discovery = session.frameDiscoveryFailure
    if (discovery !== null) {
      snapshot.missingFrames.push({
        frameId: '(all cross-origin frames)',
        reason:
          `Frame discovery could not be set up (${discovery}), so no cross-origin iframe on this page ` +
          'was read. If this page embeds one, its contents are missing from this snapshot.'
      })
    }
    current = snapshot
    return snapshot
  }

  /** 把 ref 解成可派发的句柄。没有快照就先取一张——Agent 不该为了拿把手先写一行仪式代码。 */
  async function handleFor(ref: string): Promise<{ objectId: string; send: typeof session.send }> {
    const snapshot = current ?? (await takeSnapshot())
    const resolution = await resolveBrowserRef({
      snapshot,
      ref,
      send: session.send,
      frames: session.frames,
      currentNavigationId: context.pageInfo().navigationId
    })
    if (!resolution.resolved) throw refFailureError(resolution)
    const send = resolution.sessionId ? session.frames.get(resolution.sessionId) : session.send
    // 解开的那一刻 frame 还在，取 sender 时没了。这条极少发生，但不判就会变成一句
    // "cannot read property of undefined"——那看起来像我们的 bug，而不是页面变了。
    if (!send) throw new Error(`The frame holding ${ref} went away. Take a new snapshot().`)
    return { objectId: resolution.objectId, send }
  }

  /** 在一个句柄上跑一小段函数。动作全部走这条路——不是坐标，不是键鼠合成。 */
  async function callOn(ref: string, declaration: string, ...extra: unknown[]): Promise<unknown> {
    const { objectId, send } = await handleFor(ref)
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
      throw new Error(`The page threw while acting on ${ref}: ${response.exceptionDetails.text ?? 'unknown error'}`)
    }
    return response.result?.value
  }

  /** 等一个条件成立，超时就说清等的是什么、等了多久——"timeout" 三个字帮不了任何人。 */
  async function until(what: string, timeoutMs: number, probe: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await probe()) return
      if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}.`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  return async (name, args) => {
    switch (name) {
      // ── 观察 ──────────────────────────────────────────────────────────
      case 'snapshot':
        return await takeSnapshot()
      case 'snapshotText':
        return renderBrowserSnapshotText(await takeSnapshot())
      case 'pageInfo':
        return context.pageInfo()
      case 'captureScreenshot':
        return await context.captureScreenshot()

      // ── 动作（全部按 ref） ─────────────────────────────────────────────
      case 'click':
        // scrollIntoView 在前：视口外的元素 click() 仍然生效，但后续快照与截图会对不上 Agent
        // 看到的东西。滚进来让"程序做的"和"人能看见的"是同一件事。
        return await callOn(
          requireString(args[0], 'ref'),
          'function () { this.scrollIntoView({block: "center"}); this.click() }'
        )
      case 'fillInput':
        // 派 input + change 两个事件：只设 value 的话，React/Vue 的受控输入完全看不见这次修改，
        // 表现为"填了但提交的是空的"（MEMORY「受控输入可静默变只读」是同一族的坑）。
        return await callOn(
          requireString(args[0], 'ref'),
          `function (value) {
            this.focus()
            const setter = Object.getOwnPropertyDescriptor(this.constructor.prototype, 'value')?.set
            if (setter) setter.call(this, value)
            else this.value = value
            this.dispatchEvent(new Event('input', {bubbles: true}))
            this.dispatchEvent(new Event('change', {bubbles: true}))
          }`,
          requireString(args[1], 'text')
        )
      case 'typeText': {
        // 与 fillInput 的区别是**追加而不是替换**，不是"逐字符模拟打字"。真去合成按键就回到了
        // 键鼠模拟那条路上（失败不可判），而这里要的是可判定的结果。
        const ref = requireString(args[0], 'ref')
        const text = requireString(args[1], 'text')
        return await callOn(
          ref,
          `function (value) {
            this.focus()
            const setter = Object.getOwnPropertyDescriptor(this.constructor.prototype, 'value')?.set
            const next = (this.value ?? '') + value
            if (setter) setter.call(this, next)
            else this.value = next
            this.dispatchEvent(new Event('input', {bubbles: true}))
            this.dispatchEvent(new Event('change', {bubbles: true}))
          }`,
          text
        )
      }
      case 'pressKey':
        // 键事件派到元素上，不是派到窗口上。派到窗口会打断用户当下的输入焦点——T-012 的那条线，
        // 这里先不越过去。
        return await callOn(
          requireString(args[0], 'ref'),
          `function (key) {
            this.focus()
            for (const type of ['keydown', 'keyup']) {
              this.dispatchEvent(new KeyboardEvent(type, {key, bubbles: true, cancelable: true}))
            }
          }`,
          requireString(args[1], 'key')
        )
      case 'hover':
        return await callOn(
          requireString(args[0], 'ref'),
          `function () {
            this.scrollIntoView({block: "center"})
            for (const type of ['pointerover', 'mouseover', 'mousemove']) {
              this.dispatchEvent(new MouseEvent(type, {bubbles: true}))
            }
          }`
        )
      case 'scroll':
        return await callOn(
          requireString(args[0], 'ref'),
          'function () { this.scrollIntoView({block: "center", behavior: "instant"}) }'
        )

      // ── 等待 ──────────────────────────────────────────────────────────
      case 'waitForElement': {
        // 按**名字**等，不按 ref：ref 是快照发出来的，还没出现的元素当然没有 ref。
        const wanted = requireString(args[0], 'name')
        const timeoutMs = typeof args[1] === 'number' ? args[1] : DEFAULT_WAIT_MS
        await until(`an element named ${JSON.stringify(wanted)}`, timeoutMs, async () => {
          const snapshot = await takeSnapshot()
          return snapshot.nodes.some((node) => node.ref !== '' && node.name.includes(wanted))
        })
        return current
      }
      case 'waitForLoad': {
        const timeoutMs = typeof args[0] === 'number' ? args[0] : DEFAULT_WAIT_MS
        await until('the page to finish loading', timeoutMs, async () => {
          const state = (await session.send('Runtime.evaluate', {
            expression: 'document.readyState',
            returnByValue: true
          })) as { result?: { value?: unknown } }
          return state.result?.value === 'complete'
        })
        return null
      }
      case 'waitForNetworkIdle': {
        const timeoutMs = typeof args[0] === 'number' ? args[0] : DEFAULT_WAIT_MS
        // 数在途请求，**不是**睡一个固定时长。固定时长在慢网络上撒谎，而撒的谎是"加载完了"。
        let inFlight = 0
        let lastChange = Date.now()
        await session.send('Network.enable')
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
        current = null
        return null
      }

      // ── 逃生口 ────────────────────────────────────────────────────────
      case 'js': {
        const expression = requireString(args[0], 'expression')
        const evaluated = (await session.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true
        })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } }
        if (evaluated.exceptionDetails) {
          throw new Error(`The page threw: ${evaluated.exceptionDetails.text ?? 'unknown error'}`)
        }
        return evaluated.result?.value
      }
      case 'cdp':
        return await session.send(
          requireString(args[0], 'method'),
          (args[1] ?? {}) as Record<string, unknown>
        )

      default:
        // 注入了却没派发的名字会让 Agent 收到一句无从下手的话。这里点名它是谁、以及现在能用什么。
        throw new Error(
          `Page function "${name}" is injected but this Browser cannot serve it. ` +
            'An AgentMux Browser is a single page, so it has no tabs of its own — ' +
            'use gotoUrl() here, and `agentmux open browser` to get another page.'
        )
    }
  }
}
