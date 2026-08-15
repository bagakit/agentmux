import type { WebContents } from 'electron'
import type { BrowserCdpSender } from './browser-page-snapshot.js'

/**
 * 一次驱动期间的 CDP 会话：attach、拿到每个 frame 的 sender、用完 detach。
 *
 * **为什么是「一次驱动一个会话」而不是常驻 attach**：Electron 的 debugger 与 DevTools 互斥——
 * attach 期间用户打不开这个页面的 DevTools，而用户开 DevTools 会把我们踢掉
 * （electron.d.ts:7480-7488，`detach` 事件自述这两种触发）。常驻就等于永久占着用户的 DevTools。
 * 按次 attach 把这个窗口收到「Agent 正在跑程序」的那几秒内。
 *
 * **被踢掉必须能说出来**。这是本文件存在的主要理由：detach 之后再 sendCommand，CDP 报的是一句
 * 与原因无关的泛化错误，Agent 只会看到"页面没反应"然后重试。而真相是「用户打开了 DevTools」——
 * 那是第 1 类结局（确实做不下去了），要明说、要停。按 AGENTS.md:32-52，分不清的不许当成好的。
 */

/** 跨域 iframe 各自是独立 target，要各自 attach 才够得着。一层不够——iframe 里还能再套 iframe。 */
const AUTO_ATTACH_PARAMS = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }

export class BrowserCdpSession {
  /** sessionId → 该 frame 的 sender。主 frame 不在这里（它就是 {@link send}）。 */
  private readonly frameSenders = new Map<string, BrowserCdpSender>()
  /** 非 null 表示会话已经没了，值是原因。之后每一次 send 都要拿它说话，而不是发出去等一句泛化错误。 */
  private gone: string | null = null
  /**
   * 非 null 表示子 frame 的自动 attach 没建立起来。跨域 iframe 因此**一个都不会被枚举**，
   * 而"没枚举到"与"页面上没有"在快照里长得一模一样——所以这件事必须能被上层读到。
   */
  private frameAttachFailure: string | null = null
  /** 订阅 CDP 事件的人。等一个事件（如 networkIdle）比轮询一个近似量诚实。 */
  private readonly listeners = new Set<(method: string, params: unknown) => void>()
  private readonly onDetach: (_event: unknown, reason: string) => void
  private readonly onMessage: (_event: unknown, method: string, params: unknown) => void

  private constructor(private readonly contents: WebContents) {
    this.onDetach = (_event, reason) => {
      this.gone = reason
    }
    // flatten 模式下，子 target 的 attach/detach 是主会话上的普通事件。
    this.onMessage = (_event, method, params) => {
      for (const listener of this.listeners) listener(method, params)
      if (method === 'Target.attachedToTarget') {
        const sessionId = (params as { sessionId?: string }).sessionId
        if (!sessionId) return
        this.frameSenders.set(sessionId, (m, p) => this.sendTo(sessionId, m, p))
        // 这个 frame 里还能再嵌 frame。不往下递归的话，嵌套的那层会**静默缺席**——
        // 快照里少了一块，而 missingFrames 也不会提它，因为我们根本不知道它存在。
        void this.contents.debugger
          .sendCommand('Target.setAutoAttach', AUTO_ATTACH_PARAMS, sessionId)
          .catch(() => {
            /* 这个 target 不支持嵌套 attach；它自己的节点仍然收得到。 */
          })
        return
      }
      if (method === 'Target.detachedFromTarget') {
        const sessionId = (params as { sessionId?: string }).sessionId
        if (sessionId) this.frameSenders.delete(sessionId)
      }
    }
  }

  /**
   * 接上一个页面。
   *
   * attach 失败最常见的原因就是用户已经开着 DevTools。原样抛一句 CDP 的错误等于让 Agent 去猜，
   * 所以这里把它翻译成一句说得出下一步的话。
   */
  static attach(contents: WebContents): BrowserCdpSession {
    const session = new BrowserCdpSession(contents)
    try {
      contents.debugger.attach()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Cannot drive this Browser: attaching the debugger failed (${reason}). ` +
          'DevTools being open on this page is the usual cause — they cannot both be attached. ' +
          'Close DevTools and run again.'
      )
    }
    contents.debugger.on('detach', session.onDetach)
    contents.debugger.on('message', session.onMessage)
    // 失败不致命但**必须记下来**：没有 auto-attach 就永远不会有 `attachedToTarget`，于是跨域
    // iframe 一个都不会被枚举——而快照的 `missingFrames` 只在**尝试过**某个 frame 时才写入
    // （browser-page-snapshot.ts 的 catch 挂在遍历 frames 上）。两者一叠，Agent 读到的是
    // 「这页没有 iframe」，而真相是「有，我们够不着」。这正是 AGENTS.md:32-52 不许出现的那种
    // 静默：一张有洞的地图，却声称自己是完整的。
    void contents.debugger.sendCommand('Target.setAutoAttach', AUTO_ATTACH_PARAMS).catch((error: unknown) => {
      session.frameAttachFailure = error instanceof Error ? error.message : String(error)
    })
    return session
  }

  /** 主 frame 的 sender。 */
  readonly send: BrowserCdpSender = (method, params) => this.sendTo(undefined, method, params)

  /** 每个子 frame 的 sender，键是 CDP sessionId——快照会把它记进节点，动作靠它发回对的那一头。 */
  get frames(): Map<string, BrowserCdpSender> {
    return this.frameSenders
  }

  /** 会话已经没了时的原因；还活着则为 null。等事件的人要靠它在被踢掉时立刻收手。 */
  get endedReason(): string | null {
    return this.gone
  }

  /**
   * 子 frame 自动 attach 失败的原因；建立起来了则为 null。
   *
   * 快照要用它把「这页没有 iframe」和「有 iframe 但我们够不着」分开——后者是原则 11 的第 2 类
   * （页面好好的，是我们少看了一块），不阻断，但必须说出来。
   */
  get frameDiscoveryFailure(): string | null {
    return this.frameAttachFailure
  }

  /** 订阅 CDP 事件，返回退订函数。 */
  observe(listener: (method: string, params: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async sendTo(
    sessionId: string | undefined,
    method: string,
    params?: Record<string, unknown>
  ): Promise<unknown> {
    // 先看会话还在不在。不看的话，Agent 收到的是一句 "Debugger is not attached"——
    // 那既没说是谁踢的，也没说该怎么办。
    if (this.gone !== null) {
      throw new Error(
        `The debugging session for this Browser ended (${this.gone}) — opening DevTools on the page ` +
          'does that. Nothing after this point ran. Close DevTools and run the program again.'
      )
    }
    if (this.contents.isDestroyed()) {
      throw new Error('The Browser was closed while the program was running.')
    }
    return sessionId === undefined
      ? await this.contents.debugger.sendCommand(method, params)
      : await this.contents.debugger.sendCommand(method, params, sessionId)
  }

  /**
   * 收摊。**不 detach 的后果是静默的**：用户此后再也打不开这个页面的 DevTools，而且没有任何提示。
   * 所以这一步必须在 finally 里，且它自己不许抛——它是收尾，不能把真正的失败盖掉。
   */
  detach(): void {
    this.contents.debugger.off('detach', this.onDetach)
    this.contents.debugger.off('message', this.onMessage)
    this.frameSenders.clear()
    this.listeners.clear()
    if (this.gone !== null) return
    try {
      if (!this.contents.isDestroyed() && this.contents.debugger.isAttached()) {
        this.contents.debugger.detach()
      }
    } catch {
      /* 已经被踢掉或页面没了。两种都无事可做。 */
    }
  }
}
