import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

/**
 * `--install` 必须交付一个**跑着新包的进程**，不是只换掉磁盘上的目录。
 *
 * 来由（实测 2026-09-01）：安装用 `rename` 原子换目录，旧的整份被 `mv` 进 `~/.Trash`。已运行的进程
 * 按 **inode** 持有它打开的文件，目录改名不影响那些 inode——旧实例从垃圾桶里**静默继续跑**，零报错
 * 零提示。当时主进程 18:35 启动、安装 21:54，用户按新包的预期去点链接，看到的是三小时前那份的行为；
 * 而磁盘侧三层身份校验（package-identity、bundle 内容、chunk 唯一性）**一条都没能发现**。
 *
 * 判据为什么不能是文本 `toContain`：这个仓库已有先例——`readFileSync` + `toContain` 不执行代码，
 * 在方法第一行插一个早退就能让整个实现变 no-op 而守卫全绿。这里要守的恰恰是**执行顺序**：
 *  - 退出旧实例必须在换目录**之前**（换完再退，用户的布局已经被新目录接管，且中间那段窗口里旧进程
 *    仍在写状态）；
 *  - 重新拉起必须在换目录**之后**；
 *  - 幸存者检查必须以"这次拉起的 pid"为白名单，否则它会把新进程自己算成幸存者而恒假，或者干脆
 *    谁都不算而恒真。
 * 所以这里解析 AST，按语句在 `installApplication` 函数体里的**位置**来判。
 */

const SOURCE_PATH = new URL('../scripts/package-macos.mjs', import.meta.url).pathname
const SOURCE = await readFile(SOURCE_PATH, 'utf8')

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('package-macos.mjs', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
}

/** 找到某个顶层函数声明的函数体。*/
function functionBody(source: string, name: string): ts.Block {
  const sourceFile = parse(source)
  let body: ts.Block | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) body = node.body
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (!body) throw new Error(`package-macos.mjs 里必须有 ${name} 这个函数`)
  return body
}

/**
 * 在一个函数体里，某个被调用函数名**第一次**出现的位置（字符偏移）。
 *
 * 按调用表达式而不是裸文本判：注释里写了名字、或者把名字放进字符串，都不算"调用它"。
 */
function firstCallOffset(body: ts.Block, callee: string): number {
  let offset = Number.POSITIVE_INFINITY
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === callee
    ) {
      offset = Math.min(offset, node.getStart())
    }
    ts.forEachChild(node, visit)
  }
  visit(body)
  return offset
}

/** `rename(next, destination)` —— 真正的切换那一步在函数体里的位置。*/
function cutoverOffset(body: ts.Block): number {
  let offset = Number.POSITIVE_INFINITY
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'rename' &&
      node.arguments.length === 2 &&
      ts.isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === 'next'
    ) {
      offset = Math.min(offset, node.getStart())
    }
    ts.forEachChild(node, visit)
  }
  visit(body)
  return offset
}

describe('installing must hand over a process running the new bundle', () => {
  it('quits the previous instance before the directory cutover', () => {
    const body = functionBody(SOURCE, 'installApplication')
    const quit = firstCallOffset(body, 'quitInstalledApplication')
    const cutover = cutoverOffset(body)
    expect(Number.isFinite(quit), 'installApplication 必须调用 quitInstalledApplication').toBe(true)
    expect(Number.isFinite(cutover), 'installApplication 必须有 rename(next, destination) 这次切换').toBe(true)
    // 顺序是判据本身：换完目录再退旧实例，中间那段窗口里旧进程仍在按旧代码写状态。
    expect(quit, '退出旧实例必须发生在换目录之前').toBeLessThan(cutover)
  })

  it('relaunches after the cutover so something is serving the new bundle', () => {
    const body = functionBody(SOURCE, 'installApplication')
    const relaunch = firstCallOffset(body, 'relaunchInstalledApplication')
    const cutover = cutoverOffset(body)
    expect(Number.isFinite(relaunch), 'installApplication 必须调用 relaunchInstalledApplication').toBe(true)
    expect(relaunch, '重新拉起必须发生在换目录之后').toBeGreaterThan(cutover)
  })

  it('fails loudly when a process from a previous installation survives', () => {
    const body = functionBody(SOURCE, 'installApplication')
    const text = body.getText()
    // 幸存者判据必须以"这次拉起的 pid"为白名单。少了这一侧，检查要么把新进程算成幸存者而恒假，
    // 要么谁都不算而恒真——两种都让这条门失去意义。
    expect(text).toMatch(/processIdsForApplication\(destination\)/)
    expect(text).toMatch(/filter\(\(pid\)\s*=>\s*!relaunched\.includes\(pid\)\)/)
    expect(text).toMatch(/assert\(\s*\n?\s*survivors\.length === 0/)
  })

  it('waits for the previous instance to actually disappear instead of trusting the quit request', () => {
    const body = functionBody(SOURCE, 'quitInstalledApplication')
    const text = body.getText()
    // A slow graceful quit must never escalate into destroying healthy Runs.
    const quitRequest = firstCallOffset(body, 'run')
    const firstWait = firstCallOffset(body, 'waitForProcessExit')
    const firstSignal = firstCallOffset(body, 'signalProcessIds')
    expect(Number.isFinite(quitRequest), 'quitInstalledApplication 必须先请求优雅退出').toBe(true)
    expect(Number.isFinite(firstWait), 'quitInstalledApplication 必须等进程真的消失').toBe(true)
    expect(firstWait, '等待必须发生在请求退出之后').toBeGreaterThan(quitRequest)
    expect(Number.isFinite(firstSignal)).toBe(false)
    expect(text).not.toMatch(/SIGTERM|SIGKILL/)
    // 没退干净就不许继续：留一个活着的旧实例，等于交付了一个跑旧包的窗口。
    expect(text).toMatch(/assert\(\s*\n?\s*remaining\.length === 0/)
  })

  it('detects the whole restart flow being reduced to a disk swap, so the checks cannot go vacuously green', () => {
    // 自检：把两次调用删掉——这**就是**这次事故的源码形状（只换磁盘，不管进程）。
    const mutated = SOURCE
      .replace(/const quitOutcome = previouslyInstalled[\s\S]*?: \{ wasRunning: false, pids: \[\] \}/, 'const quitOutcome = { wasRunning: false, pids: [] }')
      .replace(/const relaunched = await relaunchInstalledApplication\(destination\)/, 'const relaunched = []')
    expect(mutated, '注入必须真的改动了源码').not.toBe(SOURCE)
    const body = functionBody(mutated, 'installApplication')
    expect(firstCallOffset(body, 'quitInstalledApplication')).toBe(Number.POSITIVE_INFINITY)
    expect(firstCallOffset(body, 'relaunchInstalledApplication')).toBe(Number.POSITIVE_INFINITY)
  })

  it('keeps the case study recording the process side, not only the disk side', async () => {
    // 这条守卫存在的理由：`docs/casestudy/stale-package-feature-disappearance.md` 早就写下了正确的
    // 问题——「我现在看到的这个窗口，source commit/tree 到底是哪一份？」——但它当时给出的改进动作
    // 全部落在**磁盘身份**上（写 identity、收敛安装路径、report:package 比对副本）。第一次的失败
    // 模式是"装了旧包"（磁盘就是旧的），2026-09-01 这次是"装了新包但旧进程还活着"（磁盘是新的），
    // 那些动作一条都不触发。文档给了正确的问题却只给了回答它一半的工具，于是同一族事故复发。
    //
    // 判据要**成对**：进程那一侧的结论词必须和 rename/inode 这个机制出现在同一节里，不能只查
    // "文档里存在 process 这个词"——本仓已有先例，只取左界的 section 判据会被邻节顶上而恒真。
    const caseStudy = await readFile(
      new URL('../../../docs/casestudy/stale-package-feature-disappearance.md', import.meta.url),
      'utf8'
    )
    const heading = '## 复发（2026-09-01）：磁盘是新的，进程是旧的'
    const start = caseStudy.indexOf(heading)
    expect(start, `case study 必须有《${heading}》这一节`).toBeGreaterThanOrEqual(0)
    const rest = caseStudy.slice(start + heading.length)
    const nextTop = rest.search(/\n## /)
    const section = nextTop < 0 ? rest : rest.slice(0, nextTop)
    // 机制必须写明：rename 换目录 + inode 让旧进程活下来。少了机制，读者只会记住"要重启"，
    // 而不知道为什么磁盘校验全过也不作数。
    expect(section).toMatch(/rename/)
    expect(section).toMatch(/inode/)
    // 必须点名这条守卫，让文档和检测器互相可追溯。
    expect(section).toContain('package-install-restart.test.ts')
  })
})
