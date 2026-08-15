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

/**
 * 拉起进程的调用名。`execFileAsync` 是 `promisify(execFile)`，同样是拉进程。
 *
 * 判的是**被调用表达式的最后一节**，不是整串：`spawn(x)`、`childProcess.spawn(x)`、
 * `node:child_process` 具名导入后再 `cp.execFile(x)` 都要算。早先只认裸标识符
 * （`ts.isIdentifier(node.expression)`），于是 `childProcess.spawn(...)` 整类不可见。
 */
const LAUNCHERS = new Set(['spawn', 'execFile', 'execFileSync', 'execFileAsync', 'exec', 'execSync', 'fork'])

/** 调用表达式的「函数名」——属性访问取最后一节，其余取源文本。 */
function calleeName(node: ts.CallExpression, sourceFile: ts.SourceFile): string {
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text
  if (ts.isIdentifier(node.expression)) return node.expression.text
  return node.expression.getText(sourceFile)
}

/**
 * 函数名 → 它的别名集合。`const launch = spawn` 之后 `launch(x)` 也是拉进程。
 *
 * 只跟一层，且只跟 `const`：再深就要真正的数据流分析，而那超出 createSourceFile 的能力。
 * 记在文件头的盲点里，不假装守住了。
 */
function launcherAliases(sourceFile: ts.SourceFile): Set<string> {
  const aliases = new Set(LAUNCHERS)
  const walk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer
      const name = ts.isPropertyAccessExpression(init)
        ? init.name.text
        : ts.isIdentifier(init)
          ? init.text
          : null
      if (name !== null && aliases.has(name)) aliases.add(node.name.text)
    }
    node.forEachChild(walk)
  }
  sourceFile.forEachChild(walk)
  return aliases
}

/** 每个拉起进程的调用点，它的第 0 个实参源文本（即「拉的是哪个可执行文件」）。 */
function launchTargets(sourceFile: ts.SourceFile): string[] {
  const launchers = launcherAliases(sourceFile)
  const targets: string[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && launchers.has(calleeName(node, sourceFile)) && node.arguments.length > 0) {
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
 * `cli` 这个绑定（以及任何由它算出来的局部常量）被当作实参传给了谁。返回 `函数名(参数位置)`。
 *
 * 为什么看流向而不是看某一种拼法：破坏这个性质的写法不止一种——`join(root, cli.path)`、
 * `spawn(cli.path)`、`verifyArtifact(root, cli, …)` 再把返回值拿去用，都以「cli 流向某个调用」开头。
 *
 * **传染要跟着走**，这是本轮补的：早先只认「实参里直接出现 `cli`」，于是
 * `const p = ${'`'}${'$'}{root}/${'$'}{cli.path}${'`'}` 把 cli 洗进一个新名字之后，`spawn(p)` 就完全看不见了
 * （实测这条 bypass 在旧判据下全绿）。现在 `cli` 污染的每个 `const` 名字都进集合，跟它们一起看流向。
 * 这也顺带覆盖了拼路径：不管用 `join`、模板串还是 `+` 拼，只要拼进去的是 cli，新名字就带污点。
 */
function cliFlowsInto(sourceFile: ts.SourceFile): string[] {
  const tainted = new Set(['cli'])
  const mentionsTainted = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) return tainted.has(node.text)
    let hit = false
    node.forEachChild((child) => {
      if (!hit && mentionsTainted(child)) hit = true
    })
    return hit
  }
  // 先扩散污点：源码顺序走一遍即可——`const` 必须先声明后使用，所以一趟就能把链式转手都收进来。
  const spread = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      mentionsTainted(node.initializer)
    ) {
      tainted.add(node.name.text)
    }
    node.forEachChild(spread)
  }
  sourceFile.forEachChild(spread)

  const flows: string[] = []
  /**
   * 实参里**直接**提到污点吗——遇到嵌套调用就停。
   *
   * 为什么不一路钻到底：`Promise.all([verifyArtifact(root, cli, …)])` 里，流进 `all` 的是
   * `verifyArtifact` 的**返回值**，不是 cli 本身；一路钻会把它记成 `all(0)`，于是白名单里得多养一个
   * 与「cli 去了哪」无关的名字。嵌套调用在它自己那一层已经被记过一次（`verifyArtifact(1)`），
   * 而下面的断言是**集合相等**：任何新去处都会让它红，所以停在调用边界不会漏掉一整类——
   * `spawn(join(root, cli.path))` 仍然会以 `join(1)` 的身份打红。
   */
  const flowsDirectlyInto = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) return tainted.has(node.text)
    let hit = false
    node.forEachChild((child) => {
      if (!hit && !ts.isCallExpression(child) && flowsDirectlyInto(child)) hit = true
    })
    return hit
  }
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      node.arguments.forEach((argument, index) => {
        if (!ts.isCallExpression(argument) && flowsDirectlyInto(argument)) {
          flows.push(`${calleeName(node, sourceFile)}(${index})`)
        }
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
    expect(cliFlowsInto(broken), '污点传到 cliPath 之后再 spawn 也必须被看见').toContain('spawn(0)')
    expect(launchTargets(broken), '拉起 CLI 必须被看见').toContain('cliPath')
  })

  it('自证：换个拼法 + 换个调用形式，仍然被看见（这条 bypass 实测存活过）', () => {
    // 这段源码在旧判据下**全绿**，是本轮修复的直接由来。它同时绕过两处：
    //   - 路径不用 `join(root, …)` 拼，用模板串——旧的 `joinedFromRoot` 只匹配前者，整类失明；
    //   - 启动器不是裸名字，先 `const launch = spawn` 再 `launch(...)`，而旧 `launchTargets`
    //     要求 `ts.isIdentifier(node.expression)`，别名与 `childProcess.spawn(...)` 一并看不见。
    // 一条守卫如果只认一种拼法，它守的就是那种拼法而不是那个性质
    // （[[counting-a-symbol-misses-other-spellings]]）。
    const disguised = parse(
      [
        'const cliBinaryPath = `${root}/${cli.path}`',
        'const launch = spawn',
        "void launch(cliBinaryPath, ['attach', '--run', 'stuck'])"
      ].join('\n')
    )
    expect(cliFlowsInto(disguised), '模板串拼出来的 CLI 路径流向 launch，必须被看见').toContain('launch(0)')
    expect(launchTargets(disguised), '经别名拉起的进程必须被看见').toContain('cliBinaryPath')

    // 属性访问形式的启动器（`childProcess.spawn(...)`）同样要看得见——旧判据对它整类失明。
    const viaNamespace = parse("import * as childProcess from 'node:child_process'\nchildProcess.spawn(cli.path)")
    expect(launchTargets(viaNamespace), '带命名空间的 spawn 必须被看见').toContain('cli.path')
    expect(cliFlowsInto(viaNamespace), '流向也要记在 spawn 名下，而不是整串表达式').toContain('spawn(0)')
  })

  it('自证：判据不误伤——没碰 cli 的局部常量与普通调用照旧放行', () => {
    // 反向自检。污点传染最容易出的错是传得太宽（比如把所有 const 都算上），那样判据会恒红，
    // 而最省事的修法就是把它整段删掉。这条钉住：与 cli 无关的东西不进集合。
    const clean = parse(
      ["const daemonPath = join(root, daemon.path)", "void spawn(daemonPath, ['--version'])"].join('\n')
    )
    expect(cliFlowsInto(clean), '与 cli 无关的路径不该被算成 cli 的流向').toEqual([])
    expect(launchTargets(clean), '拉 daemon 是允许的，判据要如实报出拉的是谁').toEqual(['daemonPath'])
  })
})
