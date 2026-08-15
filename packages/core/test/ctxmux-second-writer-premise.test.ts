import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * `confirmedSizes` 从不清除条目。这**只有在「这个 Run 的几何没有第二个写者」成立时才是对的**——
 * 否则别人改了尺寸，我们照旧投影缓存里的旧值，且永远收不到通知。
 *
 * 支撑它的三条前提**全是 AgentMux 的部署事实，不是 ctxmux 的保证**：ctxmux 的接口是那个 socket，
 * 它自带的 CLI 和我们一样只是个客户端。三条各有各的守处：
 *
 *   1. 只有一个 app 实例 —— `apps/desktop/test/main-window-setup.test.ts` 已钉住（单实例锁在构造任何
 *      运行时 owner 之前执行）。不在本文件重复。
 *   2. 我们从不启动 vendored 的 CLI —— **本文件守这一条**。
 *   3. protocol 14 没有任何入站几何通道 —— `ctxmux-run-current-size.test.ts` 的
 *      `expect(PROTOCOL_VERSION).toBe(14)` 已钉住（换代即红）。不在本文件重复。
 *
 * 为什么第 2 条值得单独一条判据：它不是「今天恰好没人调」，而是**结构上够不着**。注意准确的说法不是
 * 「CLI 的路径从未被拼出来」——`verifyArtifact` 为了 stat+sha 会把传给它的任何描述符都拼成路径，CLI
 * 也不例外。准确的说法是：**那条路径从不逃出校验函数**。`verifyArtifacts` 只返回
 * `{ daemonPath, daemonSha256 }`，`cli` 这个绑定除了「在不在」和「校验它」之外没有第三种用法。
 *
 * 所以判据钉两件事：**`cli` 不流向任何拼路径/拉进程的调用**，和**每一次拉起进程拉的都是 daemon**。
 * 这个性质会被一行 `const cliPath = join(root, cli.path)` 悄悄破坏，而那一行读起来完全无害。
 *
 * 本文件红的时候不一定是缺陷：可能是有人**故意**要跑 CLI。那时该做的是先回答「第二个写者出现后，
 * confirmedSizes 的陈旧投影怎么办」，再改这条判据——而不是反过来。
 */

const here = dirname(fileURLToPath(import.meta.url))
const adapterPath = join(here, '..', 'src', 'ctxmux-run-adapter.ts')
const adapterSource = readFileSync(adapterPath, 'utf8')

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/** 拉起进程的调用名。`execFileAsync` 是 `promisify(execFile)`，同样是拉进程。 */
const LAUNCHERS = new Set(['spawn', 'execFile', 'execFileAsync'])

/** 每个拉起进程的调用点，它的第 0 个实参源文本（即「拉的是哪个可执行文件」）。 */
function launchTargets(sourceFile: ts.SourceFile): string[] {
  const targets: string[] = []
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      LAUNCHERS.has(node.expression.text) &&
      node.arguments.length > 0
    ) {
      targets.push(node.arguments[0]!.getText(sourceFile))
    }
    node.forEachChild(walk)
  }
  sourceFile.forEachChild(walk)
  return targets
}

/** 每个 `join(root, X)` 的第 1 个实参源文本（即「从哪个描述符拼出了一条真实路径」）。 */
function joinedFromRoot(sourceFile: ts.SourceFile): string[] {
  const joined: string[] = []
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'join' &&
      node.arguments.length === 2 &&
      node.arguments[0]!.getText(sourceFile) === 'root'
    ) {
      joined.push(node.arguments[1]!.getText(sourceFile))
    }
    node.forEachChild(walk)
  }
  sourceFile.forEachChild(walk)
  return joined
}

/**
 * `cli` 这个绑定被当作实参传给了谁。返回 `函数名(参数位置)` 的形状。
 *
 * 为什么看实参而不是看 `cli.path` 出现在哪：破坏这个性质的写法不止一种拼法——
 * `join(root, cli.path)`、`spawn(cli.path)`、`verifyArtifact(root, cli, …)` 再把返回值拿去用，
 * 都以「cli 流向某个调用」开头。盯住流向，比盯住某一种拼法少漏一整类。
 */
function cliFlowsInto(sourceFile: ts.SourceFile): string[] {
  const flows: string[] = []
  const mentionsCli = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && node.text === 'cli') ||
    (ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'cli')
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      node.arguments.forEach((argument, index) => {
        if (mentionsCli(argument)) flows.push(`${node.expression.getText(sourceFile)}(${index})`)
      })
    }
    node.forEachChild(walk)
  }
  sourceFile.forEachChild(walk)
  return flows
}

describe('confirmedSizes 不清除的前提：这个 Run 的几何没有第二个写者', () => {
  const sourceFile = parse(adapterSource)

  it('vendored 的 CLI 只流向完整性校验，不流向任何别的地方', () => {
    const flows = cliFlowsInto(sourceFile)
    // 自证：扫描根写错或选择器失效会返回空集，空集下面那条断言恒真。
    expect(flows.length, '没扫到任何用到 cli 的调用，判据是空的').toBeGreaterThan(0)
    expect(
      new Set(flows),
      'cli 除了被校验之外还流向了别处；多一个去处＝第二个写者从此只差一次 spawn'
    ).toEqual(new Set(['verifyArtifact(1)']))
  })

  it('artifact 目录下唯一被留下来的路径是 daemon 的', () => {
    // 上一条管「cli 流向谁」，这一条管「谁最终变成了一条能拿去跑的路径」。两条都要：
    // 校验函数为了 stat+sha 也会拼 `join(root, descriptor.path)`，那条路径不逃出函数，
    // 而 `join(root, daemon.path)` 逃出来成了 daemonPath。
    const joined = joinedFromRoot(sourceFile)
    expect(joined.length, '没扫到任何 join(root, …)，判据是空的').toBeGreaterThan(0)
    expect(
      new Set(joined),
      "多了一条从 artifact 目录拼出的路径；它逃得出所在函数吗？"
    ).toEqual(new Set(['daemon.path', 'descriptor.path', "'manifest.json'"]))
  })

  it('但 CLI 仍然被完整性校验——「够不着」不等于「不检查」', () => {
    // 两件事要分清：我们不跑它（上一条），和 artifact 被换掉要报错（这一条）。少了后者，
    // 上一条会被误读成「CLI 无关紧要」。
    expect(adapterSource).toContain("verifyArtifact(root, cli, 0o755, '0755')")
  })

  it('每一次拉起进程，拉的都是 daemon', () => {
    const targets = launchTargets(sourceFile)
    // 自证：本仓实测恰有两处（`--version` 合同校验、daemon 常驻）。数目变了要来读一眼新的那处，
    // 而不是让判据在集合相等里静默放行。
    expect(targets, '拉起进程的调用点数目变了；新增的那处拉的是什么？').toHaveLength(2)
    expect(new Set(targets)).toEqual(new Set(['daemonPath', 'artifacts.daemonPath']))
  })

  it('自证：判据认得出被破坏的样子（否则上面三条都可能是恒真的）', () => {
    const broken = parse(
      "const cliPath = join(root, cli.path)\nasync function debug() { await spawn(cliPath, ['attach']) }\n"
    )
    expect(cliFlowsInto(broken), 'cli 流向 join 必须被看见').toContain('join(1)')
    expect(joinedFromRoot(broken), '拼 CLI 路径必须被看见').toContain('cli.path')
    expect(launchTargets(broken), '拉起 CLI 必须被看见').toContain('cliPath')
  })
})
