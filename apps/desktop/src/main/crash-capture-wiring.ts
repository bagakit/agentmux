import { crashRecordFrom, type CrashRecord } from './crash-capture.js'

/**
 * 崩溃捕获的接线层：把 Electron `app` 和 Node `process` 上四类事后信号，统一喂给归一函数、再交给
 * sink 落盘。index.ts 只调用这里，不自己写分支——归一逻辑在 crash-capture.ts 里已被直接测过，
 * 这层要证明的是「接线接对了」：每类事件都挂上了、都走了归一、都进了 sink。
 *
 * 为什么不在 index.ts 里直接 `app.on(...)`：那样测试就够不着了（electron 在测试环境起不来）。
 * 这里用最小接口而不是真 electron 类型，测试能喂真的 Node EventEmitter，断言 sink 收到的记录。
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
  sink: CrashSink
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
