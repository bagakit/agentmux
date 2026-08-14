/**
 * `package-process-scope.mjs` 的类型声明。
 *
 * 实现是 `.mjs`：打包脚本由 node 直接跑，不进构建图，所以它不能是 `.ts`。而 `tsconfig.test.json`
 * 没开 `allowJs`，于是 test/ 里 import 它会吃一条 TS7016（找不到声明文件）。
 *
 * 为什么不是开 `allowJs`+`checkJs`：实测那样会把 `scripts/` 下全部 `.mjs` 拉进 test 工程，
 * 错误数从 0 涨到 624——那些脚本从来不是按 strict TS 写的。这份声明只把**被 test 引用的那一个**
 * 导出接进类型系统，作用域正好等于需要的大小。
 *
 * 实现侧的 JSDoc（package-process-scope.mjs:36-42）是同一份契约的散文版；两边若要改，一起改。
 */

/**
 * 把 `ps -axo pid=,command=` 的输出分成「在服务这份包的进程」与「脱钩的 crash-reporter」。
 *
 * @param psStdout `ps -axo pid=,command=` 的原始 stdout
 * @param bundle `executable` = `<app>/Contents/MacOS/<PRODUCT_NAME>`；
 *   `helperRoot` = `<app>/Contents/Frameworks/`（含结尾分隔符）
 */
export function classifyApplicationProcesses(
  psStdout: string,
  bundle: { executable: string; helperRoot: string }
): { serving: number[]; crashReporter: number[] }
