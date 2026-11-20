import type { AgentMuxBrowserDialogType } from '@agentmux/core'
import type { WebContents } from 'electron'
import type { BrowserCdpSender } from '@agentmux/browser/browser-page-snapshot'
import type { BrowserPageTransport, BrowserNetworkSession } from '@agentmux/browser/browser-page-transport'

/** Electron's native page-dialog adapter. Prompt declarations remain portable data. */
export const DESKTOP_BROWSER_DIALOG_TYPES = ['alert', 'confirm', 'beforeunload'] as const satisfies readonly AgentMuxBrowserDialogType[]

/**
 * 原生 CDP 连接：一个 WebContents 一个连接；调用者持有独立租约。
 *
 * 普通页面程序按次持有，已配置的 Profile 环境可持有背景租约。DevTools 可与健康连接共存；
 * 只有真实 detach 事件使原租约失效，原原因留给调用者。原环境 owner 在 DevTools 关闭后重应用配置。
 * 最后一个消费者释放时才结束原连接，单个消费者退出不打断其它消费者。
 * 已结束的原连接不得将迟到命令发到新 incarnation；当前页和已保存的操作回执仍保留。
 */

/** 跨域 iframe 各自是独立 target，要各自 attach 才够得着。一层不够——iframe 里还能再套 iframe。 */
const AUTO_ATTACH_PARAMS = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }

class BrowserCdpConnection implements BrowserPageTransport {
  /** sessionId → OOPIF target sender；同进程多个文档共用 sender。主 frame 不在这里（它就是 {@link sendCommand}）。 */
  private readonly frameSenders = new Map<string, BrowserCdpSender>()
  /** 非 null 表示会话已经没了，值是原因。之后每一次 send 都要拿它说话，而不是发出去等一句泛化错误。 */
  private gone: string | null = null
  /**
   * 非 null 表示子 frame 的自动 attach 没建立起来。跨域 iframe 因此**一个都不会被枚举**，
   * 而"没枚举到"与"页面上没有"在快照里长得一模一样——所以这件事必须能被上层读到。
   */
  private frameAttachFailure: string | null = null
  /** 订阅 CDP 事件的人。等一个事件（如 networkIdle）比轮询一个近似量诚实。 */
  private readonly listeners = new Set<(method: string, params: unknown, sessionId?: string) => void>()
  private readonly onDetach: (_event: unknown, reason: string) => void
  private readonly onMessage: (_event: unknown, method: string, params: unknown, sessionId?: string) => void

  private constructor(private readonly contents: WebContents) {
    this.onDetach = (_event, reason) => {
      this.gone = reason
    }
    // flatten 模式下，子 target 的 attach/detach 是主会话上的普通事件。
    this.onMessage = (_event, method, params, sessionId) => {
      // Electron passes the child session an event came from; an empty string means the page itself.
      for (const listener of this.listeners) listener(method, params, sessionId || undefined)
      if (method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo } = params as { sessionId?: string; targetInfo?: { type?: string } }
        if (!sessionId || targetInfo?.type !== 'iframe') return
        this.frameSenders.set(sessionId, (m, p) => this.sendTo(sessionId, m, p))
        // 这个 frame 里还能再嵌 frame。不往下递归的话，嵌套的那层会**静默缺席**——
        // 快照里少了一块，而 missingFrames 也不会提它，因为我们根本不知道它存在。
        void this.contents.debugger
          .sendCommand('Target.setAutoAttach', AUTO_ATTACH_PARAMS, sessionId)
          .catch((error: unknown) => {
            if (this.frameSenders.has(sessionId) && this.gone === null) this.frameAttachFailure = `Nested frame discovery failed for CDP session ${sessionId} (${error instanceof Error ? error.message : String(error)}). Retry snapshot() to observe embedded documents.`
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
  static attach(contents: WebContents): BrowserCdpConnection {
    const session = new BrowserCdpConnection(contents)
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

  /**
   * 主 frame 的 sender。
   *
   * 叫 `sendCommand` 而不是 `send`，与 Electron 的 `debugger.sendCommand` 同名：这不是风格。
   * `src/main` 里的 `.send(<标识符或字面量>)` 被 ipc-event-channel-parity 当成一处 IPC 推送来数
   * （它按实参形状判，不按接收者名字），于是 `session.send('Runtime.evaluate')` 会以一个 CDP 方法名
   * 的身份混进 IPC 频道清单里。名字选对，那条判据就不需要为我们开例外。
   */
  readonly sendCommand: BrowserCdpSender = (method, params) => this.sendTo(undefined, method, params)

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
  observe(listener: (method: string, params: unknown, sessionId?: string) => void): () => void {
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
        `The debugging session for this Browser ended (${this.gone}). No later command was sent. ` +
          'Inspect the original operation. If DevTools is open, close it before starting another program.'
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
   * 释放原连接的事件与协议资源；只有最后一个消费者调用这里。
   * 清理失败返回准确原因，不能盖掉已取得的操作结果。
   */
  detach(): string | null {
    this.frameSenders.clear()
    this.listeners.clear()
    // A destroyed WebContents also destroys its debugger wrapper: even reading `.off` can throw.
    if (this.contents.isDestroyed()) return null
    const failures: string[] = []
    for (const remove of [
      () => this.contents.debugger.off('detach', this.onDetach),
      () => this.contents.debugger.off('message', this.onMessage)
    ]) {
      try {
        remove()
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
      }
    }
    try {
      if (this.gone === null && this.contents.debugger.isAttached()) {
        this.contents.debugger.detach()
      }
    } catch (error) {
      if (!this.contents.isDestroyed()) failures.push(error instanceof Error ? error.message : String(error))
    }
    return failures.length > 0
      ? `Browser debugger cleanup could not finish (${failures.join('; ')}). The program result is retained. Close DevTools or reopen this Browser before driving it again.`
      : null
  }
}


type SharedBrowserCdpConnection = { native: BrowserCdpConnection; leases: number; background: number; deferredDetach: Promise<string | null> | null }

/** A lease on this WebContents' original debugger. Profile environment and a page
 * program share one native connection; releasing one consumer cannot detach the other. */
export class BrowserCdpSession implements BrowserPageTransport {
  private static readonly connections = new WeakMap<WebContents, SharedBrowserCdpConnection>()
  private readonly observers = new Set<() => void>()
  private readonly frameWrappers = new Map<string, { native: BrowserCdpSender; send: BrowserCdpSender }>()
  private released = false
  private constructor(private readonly contents: WebContents, private readonly owner: SharedBrowserCdpConnection,
    private readonly background: boolean) {}

  static attach(contents: WebContents, { background = false }: { background?: boolean } = {}): BrowserCdpSession {
    let owner = this.connections.get(contents)
    if (!owner || owner.native.endedReason !== null) {
      owner = { native: BrowserCdpConnection.attach(contents), leases: 0, background: 0, deferredDetach: null }
      this.connections.set(contents, owner)
    }
    owner.leases++
    if (background) owner.background++
    return new BrowserCdpSession(contents, owner, background)
  }

  static hasOnlyBackgroundLeases(contents: WebContents): boolean {
    const owner = this.connections.get(contents)
    return !!owner && owner.leases > 0 && owner.leases === owner.background && owner.native.endedReason === null
  }

  private assertActive(): void {
    if (this.released) throw new Error('This Browser debugger lease was released. No command was sent; use the current original page owner.')
  }
  readonly sendCommand: BrowserCdpSender = (method, params) => {
    this.assertActive()
    return this.owner.native.sendCommand(method, params)
  }
  get frames(): Map<string, BrowserCdpSender> {
    if (this.released) return new Map()
    const frames = this.owner.native.frames
    for (const id of this.frameWrappers.keys()) if (!frames.has(id)) this.frameWrappers.delete(id)
    for (const [id, native] of frames) {
      if (this.frameWrappers.get(id)?.native === native) continue
      const send: BrowserCdpSender = (method, params) => {
        this.assertActive()
        if (this.owner.native.frames.get(id) !== native) throw new Error('This original child document sender changed. Nothing was sent to its replacement; take a new snapshot().')
        return native(method, params)
      }
      this.frameWrappers.set(id, { native, send })
    }
    return new Map([...this.frameWrappers].map(([id, value]) => [id, value.send]))
  }
  get endedReason(): string | null { return this.released ? 'This consumer released its debugger lease.' : this.owner.native.endedReason }
  /** Exact native connection fact; another lease or an unknown attachment is never background-only. */
  get isSoleConsumer(): boolean {
    return !this.released && !this.contents.isDestroyed() && this.owner.leases === 1 && this.owner.native.endedReason === null &&
      BrowserCdpSession.connections.get(this.contents) === this.owner && this.contents.debugger.isAttached()
  }
  get frameDiscoveryFailure(): string | null { return this.owner.native.frameDiscoveryFailure }
  observe(listener: (method: string, params: unknown, sessionId?: string) => void): () => void {
    this.assertActive()
    const remove = this.owner.native.observe(listener)
    const release = () => { remove(); this.observers.delete(release) }
    this.observers.add(release)
    return release
  }
  async openNetworkSession(): Promise<BrowserNetworkSession> {
    this.assertActive()
    if (this.endedReason || BrowserCdpSession.connections.get(this.contents) !== this.owner) throw new Error('The original native connection changed. No replacement target is selected.')
    const retained = BrowserCdpSession.attach(this.contents)
    let held = true
    const releaseHold = (fromNetworkClose = false) => {
      if (!held) return
      held = false
      if (fromNetworkClose) retained.deferConnectionDetach()
      retained.detach()
    }
    let targetInfo: { targetId: string }
    try { ({ targetInfo } = await retained.sendCommand('Target.getTargetInfo') as { targetInfo: { targetId: string } }) }
    catch (error) { releaseHold(); throw error }
    if (this.endedReason) { releaseHold(); throw new Error(this.endedReason) }
    let sessionId: string
    try {
      ({ sessionId } = await retained.sendCommand('Target.attachToTarget', { targetId: targetInfo.targetId, flatten: true }) as { sessionId: string })
      if (!sessionId) throw new Error('The original native network session acknowledgement is unavailable.')
    } catch (error) {
      releaseHold()
      throw error
    }
    const contents = this.contents, listeners = new Set<(method: string, params: unknown) => void>()
    let ended: string | null = null
    const release = () => {
      if (!contents.isDestroyed()) { contents.debugger.off('message', message); contents.debugger.off('detach', detached) }
      listeners.clear()
      releaseHold(true)
    }
    const detached = (_event: unknown, reason: string) => { ended = reason; release() }
    const message = (_event: unknown, method: string, params: unknown, sourceId?: string) => {
      if (sourceId === sessionId) for (const listener of listeners) listener(method, params)
      if (method === 'Target.detachedFromTarget' && (params as { sessionId?: string }).sessionId === sessionId) { ended = 'The original network session detached.'; release() }
    }
    contents.debugger.on('message', message); contents.debugger.on('detach', detached)
    const close = async () => {
      if (ended || contents.isDestroyed()) {
        ended ??= 'The original network target ended.'
      } else {
        await retained.sendCommand('Target.detachFromTarget', { sessionId })
        ended = 'The original network session detached.'
      }
      release()
      const issue = await this.owner.deferredDetach
      if (issue) throw new Error(issue)
    }
    if (this.endedReason) { await close(); throw new Error(this.endedReason) }
    const sendCommand: BrowserCdpSender = async (method, params) => {
      if (ended || contents.isDestroyed() || retained.endedReason) throw new Error(ended ?? retained.endedReason ?? 'The original network target ended.')
      return await contents.debugger.sendCommand(method, params, sessionId)
    }
    try { await sendCommand('Page.enable') } catch (error) { await close(); throw error }
    return { sendCommand, get endedReason() { return ended }, observe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } }, close }
  }

  private deferConnectionDetach(): void {
    const owner = this.owner
    // Native detach events can arrive inside Chromium's response dispatch. Release the
    // lease now, but let the callback unwind before any consumer destroys this debugger.
    owner.deferredDetach ??= new Promise(resolve => {
      setImmediate(() => {
        owner.deferredDetach = null
        resolve(owner.leases === 0 ? this.detachConnection() : null)
      })
    })
  }

  detach(): string | null {
    if (this.released) return null
    this.released = true
    for (const remove of this.observers) remove()
    this.observers.clear()
    this.frameWrappers.clear()
    if (this.background) this.owner.background--
    if (--this.owner.leases !== 0 || this.owner.deferredDetach) return null
    return this.detachConnection()
  }

  private detachConnection(): string | null {
    if (BrowserCdpSession.connections.get(this.contents) === this.owner) BrowserCdpSession.connections.delete(this.contents)
    return this.owner.native.detach()
  }
}
