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
 * 壳能提供的那几样**原样**的东西：electron 与 node 自己的 API，加上配置路径。
 *
 * 为什么要有这一层：把 `StartupFailureExitIo` 直接在 `index.ts` 里拼出来时，壳里出现了三个箭头
 * 函数，而**实参**在那里可以静默写错，接线层的文本守卫看不见——`toMatch(/app\.exit\(/)` 对
 * `app.exit(code)` 与 `app.exit(0)` 一视同仁。实测把壳里的 `exit` 换成 `() => app.exit(0)`，
 * 33 条全绿且 tsc 干净（`noUnusedParameters` 没开，未用的 `code` 参数不报）：启动失败退 0，
 * shell、launchd、打包冒烟脚本全都把这次崩溃读成成功——而「退出码是 1」那条测试正是为了防这个。
 * 同形的还有 `showErrorBox(body, title)` 参数对调、`disposeOwners` 换成一个 no-op。
 *
 * 于是把适配挪到这里：壳只传**宿主对象本身**（`app`、`dialog`、`process.stderr`），没有实参位置
 * 可写错，而这个函数的组装由 `startup-failure-exit.test.ts` 真跑一遍钉住。
 * 这是「抽进 lib 只解决一半」的第二半（记忆 extracting-to-lib-only-fixes-half）：那条记忆说的是
 * 内容变可测之后「壳有没有被执行到」仍无人守，而这里治的是壳里**还剩下的那点逻辑**。
 *
 * 传的是**对象**而不是从对象上摘下来的方法（`app` 而非 `app.exit`）：electron 的 `app` 是 gin
 * 原生绑定，方法摘下来之后 receiver 就没了，调用时拿不到 holder 会抛 Illegal invocation——那正是
 * 这条路径最怕的结局：启动失败既不弹框也不退出，留下一个挂着的进程。而 tsc 与本文件的测试都看不见
 * 这件事（测试注入的是普通对象，摘下来照样能调）。同一个 `index.ts` 里 `registerCrashCapture`
 * 也是把 `app` 整个传进去的。下面那条「通过宿主对象调用」的断言就是钉这个的。
 */
export interface StartupFailureHostApis {
  /** 主配置文件路径，取自 ConfigStore 自己。 */
  configPath: string
  /** `electron` 的 `dialog`，整个传进来（不摘 `showErrorBox`，见上）。 */
  dialog: { showErrorBox(title: string, body: string): void }
  /** 运行时 owner 的清理。闭包里的函数声明，没有 receiver 可丢。 */
  disposeOwners(): Promise<void>
  /** `process.stderr`，只用它的 `write`（换行在这里补，壳里不补）。 */
  stderr: { write(chunk: string): unknown }
  /** `electron` 的 `app`，整个传进来（不摘 `exit`，见上）。 */
  app: { exit(code: number): void }
}

/**
 * 把宿主的裸 API 组装成这条路径要的 io。
 *
 * 每一项都只是转发，但**转发的正确性在这里可测**：参数顺序、退出码来自入参而非常量、诊断行末尾
 * 补换行——三件事在壳里都是无人守的实参，在这里各有一条断言。
 */
export function startupFailureExitIo(host: StartupFailureHostApis): StartupFailureExitIo {
  return {
    configPath: host.configPath,
    showErrorBox: (title, body) => host.dialog.showErrorBox(title, body),
    disposeOwners: () => host.disposeOwners(),
    writeDiagnostic: (line) => {
      host.stderr.write(`${line}\n`)
    },
    exit: (code) => host.app.exit(code)
  }
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
