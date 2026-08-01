import { startupFailureNotice } from './startup-failure-notice.js'

/**
 * 启动失败时**做**的那几件事（说什么由 `startup-failure-notice.ts` 负责）。
 *
 * 为什么要单独一层：这段序列原先就写在 `index.ts` 的 `exitAfterFailure` 里，而那个位置对测试是
 * 不可达的——它在 `startPrimaryInstance()` 闭包里，依赖 `dialog` / `app` / `configStore`。于是那一族
 * 断言只能落在**源码文本**上，而文本看不见执行：实测在函数体第一行插一句 `if (configStore) return`，
 * 整个通知路径变成 no-op 而 11 条全绿（记忆 grep-guard-cannot-see-early-return）。
 *
 * 抽出来之后要注意的是「只解决一半」（记忆 extracting-to-lib-only-fixes-half）：内容与顺序现在
 * 可测了，但「那个壳有没有被执行到、有没有把真的 electron API 接进来」照旧没人守。所以壳被压成
 * **一句表达式转发**（没有语句可插），并由 `startup-failure-exit.test.ts` 里的接线层守卫钉住
 * 每个依赖都接在真东西上。两层各自变异只红各自那层。
 *
 * 依赖全部注入，因此这个模块不 import electron：`app.getPath` 在模块加载期就会炸（见
 * `config-store.ts:196` 那次同形事故），而这条路径必须在无头环境里能整段跑起来。
 */
export interface StartupFailureExitIo {
  /** 主配置文件路径，取自 ConfigStore 自己，只用于告诉用户去哪里看。 */
  configPath: string
  /** 原生对话框。无头环境里会抛，那不能吞掉真正的失败退出。 */
  showErrorBox(title: string, body: string): void
  /** 运行时 owner 的清理。可能挂住，也可能抛。 */
  disposeOwners(): Promise<void>
  /** 写一行诊断到 stderr（换行由实现补）。终端里启动的开发者读的是这个。 */
  writeDiagnostic(line: string): void
  /** 结束进程。 */
  exit(code: number): void
}

/**
 * 告知用户 → 清理 → 退出。
 *
 * 顺序是承重的，不是风格：`disposeOwners()` 里任何一个 owner 卡住，「先清理再告知」的版本就
 * **永远不弹那个框**，症状与完全没有它一字不差。所以对话框排在清理之前，且清理与对话框各自的
 * 异常都只写 stderr、不阻断后面的步骤——`exit(1)` 必须在每条路径上都发生，否则失败的启动会留下
 * 一个既没有窗口也不退出的进程。
 *
 * `error` 允许是任何东西，包括 `undefined`（`Promise.reject()` 不带值、`throw undefined` 都会
 * 走到这里）。那种情况下诊断串没什么信息量，但「东西还在盘上、在这个文件里」这两句照样要说——
 * 按 `error` 真假分支是这里最自然的写坏方式。
 */
export async function reportStartupFailureAndExit(
  error: unknown,
  io: StartupFailureExitIo
): Promise<void> {
  const notice = startupFailureNotice(error, { configPath: io.configPath })
  io.writeDiagnostic(error instanceof Error ? error.message : String(error))
  try {
    io.showErrorBox(notice.title, notice.body)
  } catch (dialogError) {
    // 无头/测试环境里弹不出对话框是正常的，不能因此吞掉真正的失败退出。
    io.writeDiagnostic(dialogError instanceof Error ? dialogError.message : String(dialogError))
  }
  try {
    await io.disposeOwners()
  } catch (cleanupError) {
    io.writeDiagnostic(cleanupError instanceof Error ? cleanupError.message : String(cleanupError))
  }
  io.exit(1)
}
