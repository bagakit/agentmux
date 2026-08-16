import type { BrowserPageSnapshot } from '../shared/contracts.js'
import type { BrowserReplayTarget } from '../shared/browser-operation.js'
import type { BrowserCdpSession } from './browser-cdp-session.js'
import { captureBrowserPageSnapshot } from './browser-page-snapshot.js'
import { healRef, ledgerFromSnapshot, type BrowserRefLedger } from './browser-ref-ledger.js'
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
 * 解开它就必须还记得那张快照。缓存只活在一次驱动之内；跨轮次、跨重启那一半由 ref 账本
 * （`browser-ref-ledger.ts`）承担——它记的是内容身份而不是 backendNodeId，因为后者随 CDP 会话消亡。
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
  recordTarget?(target: BrowserReplayTarget): void
}

/** 默认的等待上限。脚本整体还有自己的超时兜底，这里只防"一个 wait 把整轮吃光"。 */
const DEFAULT_WAIT_MS = 10_000
/** 网络安静判定：这么久没有新请求就算静了。取自 CDP 惯例，不是可调项——调它只会让判据变模糊。 */
const NETWORK_IDLE_QUIET_MS = 500

/**
 * 动作做完把页面内的光标还给人（T-012 「不抢焦点」）。
 *
 * `fillInput` / `typeText` / `pressKey` 都得先 `focus()` 才能让页面按真实输入那样反应，而那一下
 * 抢的是**页面里的光标**：人正在一个输入框里打字，Agent 去填另一个框，人的字就打到别处去了。
 * 三处都要还——只还一处等于另外两处照抢（MEMORY「守卫按出口数不按条件数」）。
 *
 * 写成一段共享的源码片段插进三个 declaration，而不是三份手抄：手抄的三份会各自漂移，而漂移的
 * 那一份不会报错，只是悄悄不还了。
 *
 * 只在**焦点确实还在我们动过的那个元素上**时才还回去：动作可能让页面自己把焦点挪走
 * （提交表单、弹出对话框），那时硬抢回来就是我们在跟页面打架。
 *
 * 注意这里还不了窗口级的焦点——驱动路从不调 `webContents.focus()` / `setVisible`，所以窗口级
 * 抢焦点根本不存在。参考项目那套 `inert` + `opacity-0` 是给渲染进程里的 `<webview>` 宿主元素
 * 写的，AgentMux 用的是窗口级 `WebContentsView`，**不能照搬**（不是漏抄）。
 */
const RESTORE_FOCUS_SNIPPET = `
  const restoreFocus = (acted, previous) => {
    if (previous === acted) return
    if (document.activeElement !== acted) return
    if (previous instanceof HTMLElement) previous.focus()
    else if (acted instanceof HTMLElement) acted.blur()
  }`

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
  const oneLine = text.replace(/\s+/gu, ' ').trim()
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
  /**
   * **本轮真正交到 Agent 手里的那批 ref**，没交过任何一张快照时为 null。
   *
   * 这是整个跨轮机制的判据，而且它不能退化成「有没有缓存快照」。ref 是按走查顺序现编的
   * （每张快照都从 @e1 重新数），所以上一轮的 `@e3` 在这一轮的新快照里**照样存在、照样解得开**，
   * 只是指着另一个元素。只看缓存在不在，这次误点从头到尾没有一处会报错。
   * 记下"哪些 ref 是我这轮发出去的"，不在其中的一律走账本认领，不许撞进新快照的编号里。
   */
  let issued: Set<string> | null = null
  // 上一轮的账本**在任何快照落盘之前**读出来。晚一步读到的就是本轮自己刚写下的那份，
  // 于是跨轮自愈会静默退化成「永远认不出旧 ref」。
  const prior = context.readLedger()

  async function takeSnapshot(): Promise<BrowserPageSnapshot> {
    const info = context.pageInfo()
    const snapshot = await captureBrowserPageSnapshot({
      send: session.sendCommand,
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

  /**
   * 取一张快照并交给 Agent。
   *
   * 与 {@link takeSnapshot} 的区别只有一件事：**这些 ref 现在归本轮所有**。自愈内部那次取快照
   * 走的是前者——它的编号从没离开过这个进程，认领它等于把旧 ref 洗成新 ref。
   */
  async function publishSnapshot(): Promise<BrowserPageSnapshot> {
    const snapshot = await takeSnapshot()
    issued = new Set(snapshot.nodes.filter((node) => node.ref !== '').map((node) => node.ref))
    await context.writeLedger(ledgerFromSnapshot(snapshot))
    return snapshot
  }

  /** 在一张指定的快照里把 ref 解成句柄。三类失败各自成话。 */
  async function handleIn(
    snapshot: BrowserPageSnapshot,
    ref: string
  ): Promise<{ objectId: string; send: typeof session.sendCommand }> {
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
    if (!send) throw new Error(`The frame holding ${ref} went away. Take a new snapshot().`)
    return { objectId: resolution.objectId, send }
  }

  /** 把 ref 解成可派发的句柄。本轮没发出过的 ref 交给账本认领，绝不撞进新快照的编号。 */
  async function handleFor(ref: string): Promise<{ objectId: string; send: typeof session.sendCommand }> {
    if (issued !== null && current !== null && issued.has(ref)) return await handleIn(current, ref)

    // 到这里说明这个 ref 不是本轮发出的：可能来自上一轮（甚至上次启动），也可能是拼错的。
    const ledger = await prior
    const fresh = current ?? (await takeSnapshot())
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
    if (!heal.healed) throw new Error(heal.reason)
    // 自愈是有损的，所以它必须留下痕迹。不阻断（页面好好的，是我们的快照没了——原则 11 第 2 类），
    // 但也绝不静默：静默自愈让一次"点中了长得一样的邻居"看起来和一次干净的成功完全一致。
    context.note(heal.note)
    return await handleIn(fresh, heal.node.ref)
  }

  /** 在一个句柄上跑一小段函数。动作全部走这条路——不是坐标，不是键鼠合成。 */
  async function callOn(ref: string, declaration: string, ...extra: unknown[]): Promise<unknown> {
    const { objectId, send } = await handleFor(ref)
    const node = current?.nodes.find((candidate) => candidate.ref === ref)
    if (node) {
      const same = current?.nodes.filter((candidate) => candidate.role === node.role && candidate.name === node.name) ?? []
      context.recordTarget?.({ role: node.role, name: node.name, ordinal: same.findIndex((candidate) => candidate.ref === ref) + 1, count: same.length })
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
        return await publishSnapshot()
      case 'snapshotText':
        return renderBrowserSnapshotText(await publishSnapshot())
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
          `function (value) {${RESTORE_FOCUS_SNIPPET}
            const previous = document.activeElement
            this.focus()
            const setter = Object.getOwnPropertyDescriptor(this.constructor.prototype, 'value')?.set
            if (setter) setter.call(this, value)
            else this.value = value
            this.dispatchEvent(new Event('input', {bubbles: true}))
            this.dispatchEvent(new Event('change', {bubbles: true}))
            restoreFocus(this, previous)
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
          `function (value) {${RESTORE_FOCUS_SNIPPET}
            const previous = document.activeElement
            this.focus()
            const setter = Object.getOwnPropertyDescriptor(this.constructor.prototype, 'value')?.set
            const next = (this.value ?? '') + value
            if (setter) setter.call(this, next)
            else this.value = next
            this.dispatchEvent(new Event('input', {bubbles: true}))
            this.dispatchEvent(new Event('change', {bubbles: true}))
            restoreFocus(this, previous)
          }`,
          text
        )
      }
      case 'pressKey':
        // 键事件派到元素上，不是派到窗口上。派到窗口会打断用户当下的输入焦点——这是 T-012 划下的
        // 那条线：Agent 驱动页面时不抢人的操作位。
        return await callOn(
          requireString(args[0], 'ref'),
          `function (key) {${RESTORE_FOCUS_SNIPPET}
            const previous = document.activeElement
            this.focus()
            for (const type of ['keydown', 'keyup']) {
              this.dispatchEvent(new KeyboardEvent(type, {key, bubbles: true, cancelable: true}))
            }
            restoreFocus(this, previous)
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
        // 等到了才认领这批 ref：轮询途中那些快照的编号从没离开过这里，认领它们等于把还没
        // 交给 Agent 的 ref 当成已交付的。
        return await publishSnapshot()
      }
      case 'waitForLoad': {
        const timeoutMs = typeof args[0] === 'number' ? args[0] : DEFAULT_WAIT_MS
        await until('the page to finish loading', timeoutMs, async () => {
          const state = (await session.sendCommand('Runtime.evaluate', {
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
        const evaluated = (await session.sendCommand('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true
        })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } }
        if (evaluated.exceptionDetails) {
          throw new Error(`The page threw: ${pageAuthoredText(evaluated.exceptionDetails.text)}`)
        }
        return evaluated.result?.value
      }
      case 'cdp':
        return await session.sendCommand(
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
