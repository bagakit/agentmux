import { crashRecordFrom, isFatalToMainProcess, type CrashRecord } from './crash-capture.js'

/**
 * 崩溃捕获的接线层：把 Electron `app` 和 Node `process` 上四类事后信号，统一喂给归一函数、再交给
 * sink 落盘。index.ts 只调用这里，不自己写分支——归一逻辑在 crash-capture.ts 里已被直接测过，
 * 这层要证明的是「接线接对了」：每类事件都挂上了、都走了归一、都进了 sink。
 *
 * 为什么不在 index.ts 里直接 `app.on(...)`：那样测试就够不着了（electron 在测试环境起不来）。
 * 这里用最小接口而不是真 electron 类型，测试能喂真的 Node EventEmitter，断言 sink 收到的记录。
 *
 * 关键策略：**致命崩溃留证后必须 fail-fast**。一旦挂上 `process.on('uncaughtException'/'unhandledRejection')`，
 * Node 的默认兜底（uncaughtException 打印后 exit(1)、unhandledRejection 抛出终止）就被抑制了。若我们只
 * 记录不退出，主进程会带着半损坏的运行时继续活着——窗口还在、后端操作却静默失败，用户毫无信号，硬崩溃
 * 反而变成更难察觉的静默崩溃。所以致命崩溃走同步落盘（exit 前必须落地）再手动补回 exit(1)。渲染进程/子
 * 进程消失不致命：Electron 主进程按设计能在它们死后存活，异步留证即可。
 *
 * sink 的失败被吞掉：崩溃处理器自己再抛，只会火上浇油——留证是尽力而为，不能反过来放大故障。
 */

type CrashSink = (record: CrashRecord) => void | Promise<void>

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type ProcessLike = {
  on(event: 'uncaughtException', listener: (error: Error) => void): unknown
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown
  off?(event: string, listener: (...args: never[]) => void): unknown
}

type RenderProcessGoneDetails = { reason?: string; exitCode?: number }
type ChildProcessGoneDetails = {
  type?: string
  reason?: string
  exitCode?: number
  serviceName?: string
  name?: string
}

type AppLike = {
  on(
    event: 'render-process-gone',
    listener: (event: unknown, webContents: { getURL?(): string } | undefined, details: RenderProcessGoneDetails) => void
  ): unknown
  on(event: 'child-process-gone', listener: (event: unknown, details: ChildProcessGoneDetails) => void): unknown
  off?(event: string, listener: (...args: never[]) => void): unknown
}

export type CrashCaptureDeps = {
  app: AppLike
  process: ProcessLike
  /** 非致命崩溃（渲染/子进程消失）的异步留证：进程照常活着，落盘慢一点无所谓。 */
  sink: CrashSink
  /**
   * 致命崩溃（未捕获异常/拒绝）的同步留证：必须在 exit 之前把这一行落到磁盘，异步写来不及。
   * 与 sink 分开是因为二者的时序契约不同——一个「尽快」，一个「exit 前必须落地」。
   */
  persistSync: (record: CrashRecord) => void
  /** 致命崩溃留证后调用它 fail-fast，补回被 process 处理器抑制掉的 Node 默认退出。默认 app.exit(1)。 */
  exit: (code: number) => void
  /** 注入时钟，让归一后的时间戳可断言。默认走真实墙钟。 */
  now?: () => number
  /** 收到崩溃时写一行到 stderr，沿用现有失败路径的可见方式。默认写真 stderr。 */
  logStderr?: (line: string) => void
}

/**
 * 挂上四类崩溃处理器，返回一个摘除全部监听的 disposer。
 *
 * 隐私底线在这里也成立：这层只调用注入的 sink，自身没有任何网络出口。
 */
export function registerCrashCapture(deps: CrashCaptureDeps): () => void {
  const now = deps.now ?? Date.now
  const logStderr = deps.logStderr ?? ((line: string) => process.stderr.write(`${line}\n`))

  const emit = (record: CrashRecord): void => {
    logStderr(`crash captured: ${record.kind}: ${record.summary}`)
    if (isFatalToMainProcess(record.kind)) {
      // 致命：先同步落盘（exit 前必须落地，异步写来不及），失败也只落 stderr 绝不阻断退出，再补回
      // 被处理器抑制掉的 fail-fast。带着半损坏的运行时续命比硬崩溃更难察觉，宁可退出让用户重启。
      try {
        deps.persistSync(record)
      } catch (error) {
        logStderr(`crash sink failed: ${describe(error)}`)
      }
      deps.exit(1)
      return
    }
    let result: void | Promise<void>
    // sink 同步抛出（例如构造写入参数时就炸了）绝不能冒泡回崩溃处理器——留证失败不许放大故障。
    // 但也不能悄悄吞掉：落到 stderr，沿用现有失败可见的方式。
    try {
      result = deps.sink(record)
    } catch (error) {
      logStderr(`crash sink failed: ${describe(error)}`)
      return
    }
    // sink 多半是异步落盘；它的 rejection 同样要落到 stderr，否则会变成又一个没人接的 rejection。
    void Promise.resolve(result).catch((error: unknown) => {
      logStderr(`crash sink failed: ${describe(error)}`)
    })
  }

  const onUncaughtException = (error: Error): void => {
    emit(crashRecordFrom({ kind: 'uncaught-exception', error }, now()))
  }
  const onUnhandledRejection = (reason: unknown): void => {
    emit(crashRecordFrom({ kind: 'unhandled-rejection', reason }, now()))
  }
  const onRenderProcessGone = (
    _event: unknown,
    webContents: { getURL?(): string } | undefined,
    details: RenderProcessGoneDetails
  ): void => {
    const url = webContents?.getURL?.()
    emit(crashRecordFrom({ kind: 'render-process-gone', details, ...(url ? { url } : {}) }, now()))
  }
  const onChildProcessGone = (_event: unknown, details: ChildProcessGoneDetails): void => {
    emit(crashRecordFrom({ kind: 'child-process-gone', details }, now()))
  }

  deps.process.on('uncaughtException', onUncaughtException)
  deps.process.on('unhandledRejection', onUnhandledRejection)
  deps.app.on('render-process-gone', onRenderProcessGone)
  deps.app.on('child-process-gone', onChildProcessGone)

  return () => {
    deps.process.off?.('uncaughtException', onUncaughtException as (...args: never[]) => void)
    deps.process.off?.('unhandledRejection', onUnhandledRejection as (...args: never[]) => void)
    deps.app.off?.('render-process-gone', onRenderProcessGone as (...args: never[]) => void)
    deps.app.off?.('child-process-gone', onChildProcessGone as (...args: never[]) => void)
  }
}

/**
 * crashReporter 的启动选项。单独抽出来是为了让「不上传」成为一条可断言的事实，而不是散在 index.ts
 * 里一句难以验证的调用：`uploadToServer` 恒为 false，且不提供任何 `submitURL`——原生崩溃只落到
 * 本地崩溃目录，不发往任何服务器。
 */
export function crashReporterOptions(): { uploadToServer: false } {
  return { uploadToServer: false }
}
