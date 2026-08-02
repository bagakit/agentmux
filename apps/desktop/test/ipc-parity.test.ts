import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

/**
 * main 的 IPC 注册面与 preload 的 invoke 面必须逐条对齐。
 *
 * 这一族在本仓复发过多次（#206 是最近一次）：preload 暴露了方法、main 也实现了，但没有人调；
 * 或者两侧都在，参数却错了一位。共同点是**没有任何东西会红**——tsc 看不见跨进程的这条缝，
 * 因为 `ipcRenderer.invoke` 的签名是 `(channel: string, ...args: any[])`。
 *
 * 这里守三件事：
 *   1. 频道集合两侧相等（注册了没人调 → 死代码；调了没注册 → 运行时 "No handler registered"）。
 *   2. 每个 handler 的形参个数不超过它那条注册路径实际会传进来的个数。
 *   3. 两条注册路径本身仍然只有两条，且 `handle` 包装确实剥掉了 event。
 *
 * 第 2 条抓到过一个真缺陷：`ui:chooseFiles` 写成 `handle('ui:chooseFiles', (_event, input) => …)`，
 * 而 `handle` 已经剥掉 event 了。于是 `_event` 收到的是 input，`input` 恒为 undefined，
 * `defaultPath` 永远送不到——文件选择器每次都开在系统默认位置而不是这个 workspace。tsc 全程沉默：
 * `handle` 的 `TArgs` 是**从 listener 反推**的，多写一个形参只会让它推出「这条频道传两个值」。
 */

const IPC_TS = new URL('../src/main/ipc.ts', import.meta.url)
const PRELOAD_TS = new URL('../src/preload/index.ts', import.meta.url)
const IPC_SOURCE = readFileSync(IPC_TS, 'utf8')
const PRELOAD_SOURCE = readFileSync(PRELOAD_TS, 'utf8')

function parse(source: string, name: string): ts.SourceFile {
  return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/** 一条注册：频道名、listener 的形参个数、走的是哪条注册路径。 */
type Registration = { channel: string; params: number; via: 'helper' | 'raw' }

/**
 * 从 main 侧取出每一条注册。
 *
 * 判据落在 AST 上而不是正则：`handle('x', ...)` 与 `ipcMain.handle('x', ...)` 在文本上互为子串，
 * 用正则区分两者要靠前缀空白之类的偶然特征，而那正是「换个写法就绕过」的形状。
 */
function registrations(source = IPC_SOURCE, fileName = 'ipc.ts'): Registration[] {
  const ast = parse(source, fileName)
  const out: Registration[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length >= 2) {
      const [first, second] = node.arguments
      const via: Registration['via'] | null =
        ts.isIdentifier(node.expression) && node.expression.text === 'handle'
          ? 'helper'
          : ts.isPropertyAccessExpression(node.expression) &&
              node.expression.name.text === 'handle' &&
              node.expression.expression.getText(ast) === 'ipcMain'
            ? 'raw'
            : null
      if (via && first && second && ts.isStringLiteralLike(first)) {
        // listener 可能是箭头函数或 function 表达式；两者都有 parameters。
        const params = ts.isArrowFunction(second) || ts.isFunctionExpression(second)
          ? second.parameters.length
          : -1
        out.push({ channel: first.text, params, via })
      }
    }
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(ast, walk)
  return out
}

/** 从 preload 侧取出每一条 invoke：频道名 + 频道之后实际传了几个值。 */
function invocations(source = PRELOAD_SOURCE, fileName = 'preload.ts'): Array<{ channel: string; args: number }> {
  const ast = parse(source, fileName)
  const out: Array<{ channel: string; args: number }> = []
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'invoke' &&
      node.arguments.length >= 1
    ) {
      const first = node.arguments[0]
      if (first && ts.isStringLiteralLike(first)) {
        out.push({ channel: first.text, args: node.arguments.length - 1 })
      }
    }
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(ast, walk)
  return out
}

/** 越界的注册：listener 形参多于它那条路径实际会传的个数。 */
function overruns(ipcSource: string): Array<{ channel: string; detail: string }> {
  // `handle` 包装剥掉 event 再转发（ipc.ts 里那个 helper），所以走它的 listener 拿到的就是
  // preload 传的那几个值；裸 `ipcMain.handle` 不剥，第一个形参是 event，故多一位。
  const budget = { helper: 0, raw: 1 } as const
  const sent = new Map(invocations().map((i) => [i.channel, i.args]))
  return registrations(ipcSource)
    .map((r) => ({ ...r, allowed: (sent.get(r.channel) ?? 0) + budget[r.via] }))
    .filter((r) => r.params > r.allowed)
    .map((r) => ({
      channel: r.channel,
      detail: `${r.channel}: listener 收 ${r.params} 个形参，${r.via} 路径只会传 ${r.allowed} 个`
    }))
}

describe('IPC 两侧的对齐（跨进程那条缝没有类型检查）', () => {
  it('两个提取器都真的取到了东西——判据不能落空', () => {
    // 提取器返回空数组会让下面每一条断言变成恒真。这一条把「提取器还认得这两个文件的写法」
    // 做成显式前提：注册面重构成第三种写法时，是这一条先红，而不是别的断言静默变成空转。
    const regs = registrations()
    const invokes = invocations()
    expect(regs.length, 'main 侧一条注册都没取到——提取器与 ipc.ts 的写法脱节了').toBeGreaterThan(50)
    expect(invokes.length, 'preload 侧一条 invoke 都没取到').toBeGreaterThan(50)
    // 两条注册路径都必须还在场：只剩一条时下面那条「按路径判形参」的规则会退化成只守一半。
    expect(new Set(regs.map((r) => r.via))).toEqual(new Set(['helper', 'raw']))
    // 每条注册的 listener 都必须是函数字面量，否则 params 是 -1，形参判据对它失明。
    expect(regs.filter((r) => r.params < 0).map((r) => r.channel)).toEqual([])
  })

  it('频道集合两侧相等：注册了没人调是死代码，调了没注册是运行期报错', () => {
    const registered = new Set(registrations().map((r) => r.channel))
    const invoked = new Set(invocations().map((i) => i.channel))
    // 报出两个方向，因为两种缺席的症状完全不同：多出来的注册悄无声息（这就是 #206 那一族），
    // 少掉的注册在用户点下去的那一刻抛 "No handler registered for 'x'"。
    expect([...registered].filter((c) => !invoked.has(c)), 'main 注册了但 preload 从不 invoke').toEqual([])
    expect([...invoked].filter((c) => !registered.has(c)), 'preload 会 invoke 但 main 没注册').toEqual([])
  })

  it('handler 形参不超过它那条注册路径会传进来的个数', () => {
    // 多出来的形参恒为 undefined，且它把后面每一位都挤掉一格——症状是「这个参数好像没生效」，
    // 而不是任何一处报错。
    expect(overruns(IPC_SOURCE).map((r) => r.detail)).toEqual([])
  })

  it('自检：把 event 形参加回 helper 路径的 handler，上面那条会红', () => {
    // 这条守的是守卫自己。判据是相对的（listener 形参 vs 那条路径的预算），所以必须证明它对
    // 「多一位」真的敏感——否则一条恒不越界的规则和没有规则一样。
    //
    // 断言落在**差集**上而不是越界的全集：后者会把这条自检的成败绑在 ipc.ts 当下恰好干净上，
    // 于是真出现一个越界时两条一起红，而这一条红得毫无信息（它想说的只是「我认得出多一位」）。
    const mutated = IPC_SOURCE.replace(
      "handle('config:get', () => config)",
      "handle('config:get', (_event) => config)"
    )
    expect(mutated, '锚点没匹配上，自检没有真的构造出越界形状').not.toBe(IPC_SOURCE)
    const before = new Set(overruns(IPC_SOURCE).map((r) => r.channel))
    const introduced = overruns(mutated)
      .map((r) => r.channel)
      .filter((channel) => !before.has(channel))
    expect(introduced).toEqual(['config:get'])
  })

  it('自检：删掉一条注册，频道集合那条会从「注册缺席」方向报', () => {
    const mutated = IPC_SOURCE.replace("handle('config:get', () => config)", '')
    expect(mutated).not.toBe(IPC_SOURCE)
    const registered = new Set(registrations(mutated).map((r) => r.channel))
    const invoked = new Set(invocations().map((i) => i.channel))
    expect([...invoked].filter((c) => !registered.has(c))).toEqual(['config:get'])
  })

  it('`handle` 包装确实剥掉了 event——形参预算的前提', () => {
    // 上面那条形参规则整套建立在「helper 剥、raw 不剥」上。这个前提写在 helper 的实现里，
    // 而它和规则分居两个文件，正是会漂移的形状：包装哪天改成把 event 一起转发，规则会在
    // 全绿的情况下开始放过真正的越界。所以这里把前提本身钉住。
    const ast = parse(IPC_SOURCE, 'ipc.ts')
    // 收进数组而不是写 `let body: string | null`：赋值发生在回调里，TS 的控制流分析看不见它，
    // 于是使用点上 body 仍被收窄成 null。数组没有这个问题，顺带把「只有一个 handle 声明」也钉住。
    const bodies: string[] = []
    const walk = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'handle' &&
        node.initializer
      ) {
        bodies.push(node.initializer.getText(ast))
      }
      ts.forEachChild(node, walk)
    }
    ts.forEachChild(ast, walk)
    expect(bodies, 'ipc.ts 里那个 `handle` 包装应当恰好有一个声明').toHaveLength(1)
    const body = bodies[0]!
    // 它注册给 electron 的那个回调必须**丢掉**第一个形参（下划线开头即约定的「不用」），
    // 并把余下的 rest 原样转发给 listener。
    expect(body).toMatch(/ipcMain\.handle\(\s*channel\s*,\s*\(\s*_\w+\s*,\s*\.\.\.\w+/)
    expect(body).toMatch(/listener\(\s*\.\.\.\w+\s*\)/)
    // 且它要把频道记进拆卸清单：注册了不撤销会让第二个窗口注册时抛。
    expect(body).toContain('channels.push(channel)')
  })
})
