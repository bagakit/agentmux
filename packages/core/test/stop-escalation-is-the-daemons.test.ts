import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * 「优雅 → 强制」那条阶梯是 **daemon 的**，不是我们的。本文件守这一条。
 *
 * 它守的是一个**差点被写下的**缺陷。2026-09-26 的关闭复盘里白纸黑字记着「没有强制路径」，
 * 并据此排了一条 P1：照几个参考项目的样子，在 Core 里搭一条
 * `TERM → 等 N 秒 → SIGKILL` 的阶梯。那条结论是读代码读出来的——只看了 `interrupt`
 * （回合级 Ctrl-C）和 `remove`（明确拒绝运行中的 run），漏掉了 `stop` 本身。
 *
 * 而 `stop` 的回执上就写着答案：`StopDisposition = "graceful" | "forced"`。daemon 自己走完两段，
 * 回执告诉你它最后落在哪一段。真照那条 P1 做下去，产出的会是**第二份实现**，而且是更差的那份：
 * daemon 数得清一个 native session 的后代进程（它的失败文案原话是「remained live after graceful
 * and forced Stop phases」），我们在 SDK 这一侧只有一个 RunId，数不清。参考项目里那套阶梯是给
 * 「自己 fork/exec、自己持有 pid」的宿主写的；我们把进程托管给了 daemon，不是那种宿主。
 *
 * 所以判据钉的是**能力的归属**，不是某一行代码：
 *
 * 1. SDK 确实以 `forced` 作为 `stop` 的一种结局——推翻「没有强制路径」的那件事实本身。
 *    直接读 SDK 的类型声明，不手抄一份枚举：手抄的那份会和上游一起漂，而漂的时候它不会响
 *    （记忆 constant-copies-outside-the-build-graph）。
 * 2. Core 自己不发信号阶梯。`signalTerminal` 只放行 SIGINT，且整个 `packages/core/src`
 *    里不出现 SIGKILL/SIGTERM 这类名字——出现了就说明有人开始自建第二条路。
 *
 * **本文件红的时候不一定是缺陷。** 如果上游哪天真的把强制从 `stop` 里拿走了，第 1 条会红，
 * 那时该做的是重新回答「谁来负责杀不掉的进程」，而不是把这条判据删掉了事。如果第 2 条红了，
 * 先回答「daemon 的两段为什么不够」——答不上来就是在重造轮子。
 */

const here = dirname(fileURLToPath(import.meta.url))
const coreSrc = join(here, '..', 'src')

describe('停止的强制阶梯归 daemon 所有', () => {
  it('SDK 把 forced 列为 stop 的一种结局——「没有强制路径」不成立', () => {
    // 读上游的类型声明本身。这一条一旦够不着文件就该红，而不是悄悄跳过：
    // 读不到就等于没验，那正是「扫到空内容」那一族假绿。
    const declaration = readFileSync(
      join(here, '..', 'node_modules', '@ctxmux', 'sdk', 'dist', 'generated', 'StopDisposition.d.ts'),
      'utf8'
    )
    const union = declaration.match(/export type StopDisposition\s*=\s*([^;]+);/)?.[1]
    expect(union, 'SDK 里找不到 StopDisposition——上游改了形状，这条推理要重做').not.toBeUndefined()
    const members = [...union!.matchAll(/"([^"]+)"/g)].map((match) => match[1])
    // 钉死整个集合，不写 `.includes('forced')`：多出一档（比如上游加了 "abandoned"）意味着
    // 结局多了一种，而那种新结局大概率正是我们该讲给用户听的那一种。
    expect(members).toEqual(['graceful', 'forced'])
  })

  it('Run 停止路径上不自建信号阶梯——第二份实现会比 daemon 那份知道得更少', () => {
    // 范围是**拿 RunId 说话的那几个函数**，不是整个 `packages/core/src`。
    //
    // 第一版把整棵树一起扫了，于是抓到两处完全正当的用法：`process-runner.ts` 杀一个自己
    // fork 出来的辅助命令，`ctxmux-run-adapter.ts` 的 `terminateSpawnedDaemon` 收拾一个自己
    // 拉起来的 daemon（它本身就是一条 TERM→KILL 阶梯，而且是对的——那个 child 确实归我们）。
    // 那两处与本文件要守的东西无关：区别不在「有没有发信号」，在**对谁发**。对自己 spawn 的
    // ChildProcess 发信号是持有者的本分；对一个只有 RunId 的 Run 发信号才是在重造 daemon 的阶梯。
    //
    // 一条因为误伤而长红的判据和没有判据一样瞎（记忆 conservative-guard-hides-the-defect-behind-it），
    // 所以这里按函数点名，不按文件点名。
    const surfaces: Array<{ file: string; functions: string[] }> = [
      { file: 'client.ts', functions: ['signalTerminal', 'stopTerminal', 'stopAgent'] },
      { file: 'ctxmux-run-adapter.ts', functions: ['stop', 'interrupt', 'prepareStop'] }
    ]
    const offenders: string[] = []
    let checked = 0
    for (const surface of surfaces) {
      const path = join(coreSrc, surface.file)
      const source = ts.createSourceFile(
        surface.file,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      )
      const found = new Set<string>()
      const walk = (node: ts.Node): void => {
        if (
          (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
          node.name !== undefined &&
          surface.functions.includes(node.name.getText(source))
        ) {
          const name = node.name.getText(source)
          found.add(name)
          for (const match of node.getText(source).matchAll(/SIG(KILL|TERM|QUIT|HUP)\b/g)) {
            offenders.push(`${surface.file}#${name}: ${match[0]}`)
          }
        }
        ts.forEachChild(node, walk)
      }
      walk(source)
      // 锚点必须真的找到。找不到就是「扫到空内容」——函数改了名或搬了家，而上面那条
      // `toEqual([])` 会照常绿（记忆 indexof-anchor-gone-slices-to-empty-string）。
      expect(
        [...found].sort(),
        `${surface.file} 里这几个停止路径函数没找全——改名或搬家了，这条判据正在问空气`
      ).toEqual([...surface.functions].sort())
      checked += found.size
    }
    expect(checked, '一个停止路径函数都没扫到').toBeGreaterThan(0)
    expect(offenders, 'Run 停止路径上出现了终止信号——先回答「daemon 的 graceful+forced 为什么不够」').toEqual([])
  })

  it('signalTerminal 只放行 SIGINT——它是这条路上唯一的信号，且语义是回合级 Ctrl-C', () => {
    const text = readFileSync(join(coreSrc, 'client.ts'), 'utf8')
    const body = text.match(/async signalTerminal\([^)]*\)[^{]*\{([\s\S]*?)\n  \}/)?.[1]
    expect(body, 'client.ts 里找不到 signalTerminal——这条判据在问空气').not.toBeUndefined()
    // `SIG[A-Z]+` 会顺手吃掉错误码 `SIGNAL_UNSUPPORTED`——那不是一个信号名。这里点名真实存在的
    // 信号，而不是「SIG 开头的任意大写串」。
    const signals = [...body!.matchAll(/\bSIG(?:INT|KILL|TERM|QUIT|HUP|USR[12]|STOP|CONT)\b/g)]
      .map((match) => match[0])
    // 钉死集合而不是 `.includes('SIGINT')`：放宽到第二个信号正是这条判据要拦的那件事。
    expect([...new Set(signals)]).toEqual(['SIGINT'])
  })
})
