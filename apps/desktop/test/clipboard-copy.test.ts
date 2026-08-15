import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { enclosingBindingPath, findCallsToIdentifier, readAndParse } from './helpers/effect-reachability.js'

// 复制到剪贴板从三处（容错三个档，含一处裸 `void` 静默失败）收敛成一个出口。这组测试守三件事：
//   1. 路径变体格式化不许搞反、拼接格式不许漂——期望值锚成写死的字面量，绝不由被测函数自己算；
//   2. 失败必报、绝不静默，且如实返回成败布尔（BrowserPane 靠它决定成功才收起选区）；
//   3. 整棵 renderer 里只有这一个出口碰 `api.ui.writeClipboardText`——按调用点而非裸标识符判，
//      任何壳绕过出口自己直接写剪贴板都红。

// 出口在模块顶层 import 了 api；给它一个可按用例改行为的桩。
const clipboard = vi.hoisted(() => ({
  writeClipboardText: vi.fn(async (_text: string): Promise<void> => {})
}))
vi.mock('../src/renderer/src/lib/api.js', () => ({ api: { ui: clipboard } }))

import {
  copyTextToClipboard,
  formatPathsForCopy
} from '../src/renderer/src/lib/clipboard-copy.js'

beforeEach(() => {
  clipboard.writeClipboardText.mockReset()
  clipboard.writeClipboardText.mockImplementation(async () => {})
})

describe('路径变体格式化：绝对 / 相对 / 多选换行', () => {
  // 期望值全是写死的字面量。绝不写成 `paths.map(p => join(root, p)).join('\n')`——那会跟着实现
  // 一起漂，格式改错了它也照样绿（本仓实测过的恒真陷阱）。
  it('相对：原样，多选用换行拼接', () => {
    expect(formatPathsForCopy(['src/a.ts', 'b.ts'], 'relative', '/work')).toBe('src/a.ts\nb.ts')
  })

  it('绝对：每一段接到工作区根上，多选用换行拼接', () => {
    expect(formatPathsForCopy(['src/a.ts', 'b.ts'], 'absolute', '/work')).toBe(
      '/work/src/a.ts\n/work/b.ts'
    )
  })

  it('单选也走同一条路：相对原样、绝对带根', () => {
    expect(formatPathsForCopy(['only.ts'], 'relative', '/root')).toBe('only.ts')
    expect(formatPathsForCopy(['only.ts'], 'absolute', '/root')).toBe('/root/only.ts')
  })

  it('绝对与相对绝不互为别名——把两个档搞反必然红', () => {
    // 这条专治「relative/absolute 搞反」：两个档对同一输入必须给出不同文本，且各自等于自己那侧
    // 的字面量。只断言「不相等」不够——搞反后它们照样不相等；所以两侧都钉死。
    const relative = formatPathsForCopy(['x.ts'], 'relative', '/w')
    const absolute = formatPathsForCopy(['x.ts'], 'absolute', '/w')
    expect(relative).toBe('x.ts')
    expect(absolute).toBe('/w/x.ts')
    expect(relative).not.toBe(absolute)
  })
})

describe('单一容错：失败必报、绝不静默，并如实返回成败', () => {
  it('写入成功返回 true，不惊动报错口', async () => {
    const report = vi.fn()
    const ok = await copyTextToClipboard('hello', report)
    expect(ok).toBe(true)
    expect(clipboard.writeClipboardText).toHaveBeenCalledWith('hello')
    expect(report).not.toHaveBeenCalled()
  })

  it('写入失败：把错误交给报错口、返回 false，且出口自己不 reject', async () => {
    // 这条是整组最重要的一条：它守的是「失败不静默」。把出口的 try/catch 删掉、回到裸
    // `void api.ui.writeClipboardText(...)`（SurfaceToolDock 今天之前的形状），写入失败会让
    // 这个 promise reject——`resolves.toBe(false)` 立刻红；而报错口也再没人调，下一条断言也红。
    const boom = new Error('clipboard denied')
    clipboard.writeClipboardText.mockRejectedValueOnce(boom)
    const report = vi.fn()
    await expect(copyTextToClipboard('x', report)).resolves.toBe(false)
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith(boom)
  })
})

// ---------------------------------------------------------------------------
// 整棵 renderer 源码树里，只有这个出口碰 `api.ui.writeClipboardText`。
//
// 判据按**调用点**而非裸标识符：菜单组件合法地有一个名为 `writeClipboardText` 的 prop，按名字禁
// 会误伤它；而绕过出口只有一条路——直接写 `api.ui.writeClipboardText(...)` 这个剪贴板 sink 表达式，
// 它只该出现在出口里。任何壳退回自己直接写剪贴板（本轮修掉的裸 `void` 就是这形状）都会被这里逮到。
// ---------------------------------------------------------------------------
const RENDERER_SRC = fileURLToPath(new URL('../src/renderer/src', import.meta.url))
const SOLE_CLIPBOARD_WRITER = 'lib/clipboard-copy.ts'
// 剪贴板 sink 表达式。注释里描述规则的文字不是规则本身，先去注释（沿用 agent-address.test.ts 的写法）。
const CLIPBOARD_SINK = /api\.ui\.writeClipboardText\b/u

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx?$/u.test(entry.name)) out.push(path)
  }
  return out
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1')
}

describe('剪贴板写入只有一个出口', () => {
  it('整棵 renderer 源码树里只有出口自己调 api.ui.writeClipboardText', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(RENDERER_SRC)) {
      const relative = file.slice(RENDERER_SRC.length + 1)
      if (relative === SOLE_CLIPBOARD_WRITER) continue
      withoutComments(readFileSync(file, 'utf8')).split('\n').forEach((line, index) => {
        if (CLIPBOARD_SINK.test(line)) offenders.push(`${relative}:${index + 1}  ${line.trim()}`)
      })
    }
    // 报出 file:line 而不是只给个数——漂移点要一眼看得到。
    expect(
      offenders,
      `剪贴板写入只能在 ${SOLE_CLIPBOARD_WRITER}，这些文件绕过了出口：\n${offenders.join('\n')}`
    ).toEqual([])
  })

  it('自检：扫描面真的覆盖到了出口本身、且出口确实持有那个 sink', () => {
    // 少了这条，上面那条会以最难发现的方式假绿：路径写错、后缀过滤写错、去注释把整个文件吃空，
    // 任何一种都让 offenders 恒为空数组，而「没扫到」和「扫过了没问题」打印出来一模一样。
    const files = sourceFiles(RENDERER_SRC).map((file) => file.slice(RENDERER_SRC.length + 1))
    expect(files).toContain(SOLE_CLIPBOARD_WRITER)
    expect(CLIPBOARD_SINK.test(withoutComments(readFileSync(`${RENDERER_SRC}/${SOLE_CLIPBOARD_WRITER}`, 'utf8')))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 那几个壳真的在转发。
//
// 「抽进 lib 只解决一半」：出口内部正确，不代表每个调用点都把它接上了。上面那条禁了「绕过出口自己
// 写剪贴板」，这里补另一半——每个壳的复制动作确实转发给了 `copyTextToClipboard`。这些壳是 React
// 组件里的闭包回调，desktop 没有 jsdom / @testing-library，无法挂载后点一下来执行它们；能咬住的最强
// 判据是「源码里这个复制路径引用了出口」。
//
// ─── 判据为什么必须按**位置**而不是按**文件**（#618，Reviewer #1 Finding 1）───
//
// 这组断言此前是 `expect(source).toContain('copyTextToClipboard(')`——按**文件**问「有没有」。
// 那等价于「这个壳转发了」的前提是：该文件里这个形状**只出现一次**。实测前提不成立（下面两个计数
// 是 #618 当时的，TerminalView 后来因 #638 又多了两处，见下方表里的注释）：
//   · TerminalView.tsx        3 处（`writeClipboard` 依赖 ×2、`copySelection` ×1）
//   · WorkspaceWorkbench.tsx  2 处（`SortableWorkbenchTab`、`WorkbenchRegionLeaf`）
// 于是在这两个文件里删掉**任意一处**转发、留下别处，旧判据照旧命中、整套全绿。被掩盖的正是
// 右键 Copy 那条路：`copySelection` 是右键菜单里走选区的复制实现（键盘那条走 terminal-shortcuts 的
// action，与它不共用代码），它整段消失时用户的右键复制彻底失效，而没有任何测试会红——本仓
// 「presence-assertion-blind-when-shape-repeats」那一族，先例 #586。
//
// 改法：解析 AST，取每处调用的**限定绑定路径**，与声明的位置集合逐一比对（`toEqual`，含次数与顺序）。
// 少一处、多一处、搬到别的函数里，三种都红。路径由 `enclosingBindingPath` 取，取值是从当前源码
// 实测出来的，不是照着我的印象写的——而且是与 **HEAD 内容**逐文件比对过的（9 个文件、0 漂移），
// 不是从脏工作树读的（本仓记过「message 行号取自脏工作树」那一族已 9 次，这张表同样会犯）。
//
// ─── 为什么是「路径」而不是「最近那一个名字」（#619）───
//
// 取最近一个名字时，`SurfaceToolDock` 里 `onCopyPath={() => void copyTextToClipboard(...)}` 会被记成
// 外层组件名 `WorkspaceTopicsPanel`——因为那个函数宣称认得 JSX 属性上的内联箭头，而那条分支其实
// 是**死代码**（内联箭头的直接父节点是 `JsxExpression`，不是 `JsxAttribute`；实测 342 个样本、0 命中）。
// 后果：把这次复制搬到紧邻的 `onReveal`（形状一样）照旧全绿，而那是用户点「复制路径」的唯一一条路。
// 详见 helpers/effect-reachability.ts 里 `enclosingBindingPath` 的 docstring。
//
// 这条判据**不**保证：调用之后被 `if (false)` 包起来这类造作形状（由上面的 no-bypass 扫描兜底——壳一旦
// 退回直接写剪贴板就红），也不保证壳会被挂载、事件会被派发（desktop 无 DOM 环境，见
// helpers/effect-reachability.ts 文件头）。它也**不**区分**同名同层**的两个绑定：TerminalView 那两个
// 注入端口都叫 `writeClipboard`、都直接长在组件里，路径逐字相同，把复制在这两者之间对调不会红
// （已知局限，要区分得用 `pickCallByArgument` 按实参判）。它保证的是「这几个具名路径上各有一次对出口的调用」。
// ---------------------------------------------------------------------------
describe('每个复制入口与菜单注入点都转发给出口', () => {
  // 每个壳里**哪些具名路径**该有一次转发。取值实测自当前源码并与 HEAD 内容核对过；改动接线时这张表
  // 要跟着改，且改的时候必须说明那个位置为什么消失/新增——这正是它要拦的东西。
  //
  // 这张表此前只有 6 个文件，标题写「五个复制入口 + 两个菜单注入点」。下面那条全树自检一上来就
  // 报出**另外三个**在转发却没人守的文件（AgentRoster / EditorPane / WorkspaceRowContextMenu），
  // 所以旧标题里那个数在当时就已经不实了。这也是为什么自检要按「全树扫出来的转发者集合」判，
  // 而不是让人手数：手数的清单会静默落后于代码。
  const FORWARD_SITES: readonly [file: string, sites: readonly string[]][] = [
    ['components/FileExplorer.tsx', ['FileExplorer > copyContextPaths']],
    ['components/BranchesPanel.tsx', ['BranchesPanel > copyText']],
    // `jsx:onCopyPath` 这一段是 #619 换成限定路径后才拿到的粒度：它与紧邻的 onRename/onReveal
    // 形状完全一样，只有点名到 handler 才拦得住「复制被搬到另一个菜单项」。
    ['components/SurfaceToolDock.tsx', ['WorkspaceTopicsPanel > jsx:onCopyPath']],
    // 五处各自承重，缺一不可，且不共用代码：
    //   · 前两处是注入给键盘/OSC-52 通路的 `writeClipboard` 端口；
    //   · `copySelection` 是**右键菜单**里走选区的那条复制；
    //   · `copyViewport` / `copyScrollback` 是 #638 的出路——两条**不经过选区**的复制路。
    //     它们从 `terminal.buffer.active` 取文本，不问选区服务死活，所以 TUI 开着鼠标上报、
    //     xterm 自禁选区、`copySelection` 恒空时，这两条是用户仅剩的复制手段。删掉任一条，
    //     那个场景下的复制就彻底没了。
    // 前两条路径逐字相同（同名端口、同一层），故它们之间对调不可观测——见上面「不保证」。
    ['components/TerminalView.tsx', ['TerminalView > writeClipboard', 'TerminalView > writeClipboard', 'TerminalView > copySelection', 'TerminalView > copyViewport', 'TerminalView > copyScrollback']],
    ['components/BrowserPane.tsx', ['BrowserPane > copyElementContext']],
    // 两个菜单注入点：地址菜单的复制经这里注入的 writeClipboardText 落到出口。两处的属性名同为
    // `jsx:writeClipboardText`，靠外层组件名区分——这也是判据取整条路径而非最内层名字的另一半理由。
    ['components/WorkspaceWorkbench.tsx', ['SortableWorkbenchTab > jsx:writeClipboardText', 'WorkbenchRegionLeaf > jsx:writeClipboardText']],
    ['components/AgentRoster.tsx', ['RosterRowView > writeClipboardText']],
    // EditorPane 的复制挂在编辑器命令的 `run` 上（Monaco action 的执行体）。
    ['components/EditorPane.tsx', ['EditorPane > registerCopyActions > run']],
    ['components/WorkspaceRowContextMenu.tsx', ['WorkspaceRowContextMenu > copyText']],
    // 卡在队列里、再也发不出去的那几条 steer 的唯一出路（`f1df9330` 加的，全树自检当场把它报成
    // 「在转发却无人守」）。它比别处更该守住：`QueuedMessages` 里那句文案是**按 onCopy 在不在**
    // 分岔的——接上时说 "so you can copy them"，接不上时改口说 "kept here, not sent"。所以删掉这处
    // 转发不会留下一个点不动的按钮，而是整段静默换成另一句话，人只会以为这些字本来就没救了。
    // 而这些字是人亲手打的、发不出去了，复制是把它们捞回来的唯一手段。
    ['components/AgentSessionComposer.tsx', ['AgentSessionComposer > jsx:onCopyQueued']]
  ]

  it('每个壳的每个具名转发位置上都恰好有一次对出口的调用', () => {
    for (const [file, sites] of FORWARD_SITES) {
      const path = `${RENDERER_SRC}/${file}`
      const { sourceFile } = readAndParse(path)
      const actual = findCallsToIdentifier(sourceFile, 'copyTextToClipboard').map(enclosingBindingPath)
      expect(
        actual,
        `${file} 的转发位置应恰为 [${sites.join(' | ')}]，实测 [${actual.join(' | ')}]。` +
          '少一处＝某条复制路径被删掉了（按文件判「有没有」看不见这个）；' +
          '多一处或换了位置＝接线搬家了，要确认新位置是有意的。'
      ).toEqual([...sites])
    }
  })

  it('自检：位置清单非空、路径真的带上了限定、且这张表真的覆盖了全部转发点', () => {
    // 防这条自己假绿的四种方式：
    //   1. 位置清单被写空 ⇒ `toEqual([])` 在「转发全被删掉」时恒真；
    //   2. 路径取成了 `(top-level)` 兜底值 ⇒ 说明 enclosingBindingPath 没认出这种写法，
    //      判据退化成「顶层有几次调用」，几乎不区分位置；
    //   3. **每条路径都只有一段** ⇒ 那就等于回到了 #619 之前那个「只取最近一个名字」的判据，
    //      而它对 JSX 属性上的内联箭头是失明的。至少要有一条路径带 `>`（限定生效的在场证明），
    //      也至少要有一条带 `jsx:`（那条曾经的死分支现在真的可达）——两者缺任何一个，就说明
    //      这次修复被悄悄退回去了，而上面那条断言只会跟着新取值一起变绿，不会报警。
    //   4. 这张表漏掉了某个**确实在转发**的文件 ⇒ 那个文件整段删掉转发不会红。用全树扫描兜。
    for (const [file, sites] of FORWARD_SITES) {
      expect(sites.length, `${file} 的位置清单为空，判据会恒真`).toBeGreaterThan(0)
      for (const site of sites) expect(site).not.toBe('(top-level)')
    }
    const allSites = FORWARD_SITES.flatMap(([, sites]) => sites)
    expect(
      allSites.filter((site) => site.includes(' > ')).length,
      '没有任何一条路径带限定段，判据退化成「只取最近一个名字」（#619 之前的形状）'
    ).toBeGreaterThan(0)
    expect(
      allSites.filter((site) => site.includes('jsx:')).length,
      'jsx: 段一次都没出现——那条分支又变回死代码了（#619 的靶子）'
    ).toBeGreaterThan(0)

    const declared = new Set(FORWARD_SITES.map(([file]) => file))
    const forwardingFiles: string[] = []
    for (const path of sourceFiles(RENDERER_SRC)) {
      const relative = path.slice(RENDERER_SRC.length + 1)
      if (relative === SOLE_CLIPBOARD_WRITER) continue
      const { sourceFile } = readAndParse(path)
      if (findCallsToIdentifier(sourceFile, 'copyTextToClipboard').length > 0) forwardingFiles.push(relative)
    }
    expect(forwardingFiles.length, '全树一个转发点都没扫到，说明扫描面坏了').toBeGreaterThan(0)
    const unlisted = forwardingFiles.filter((file) => !declared.has(file))
    expect(
      unlisted,
      `这些文件转发给了出口但不在 FORWARD_SITES 里，于是它们的转发无人守：\n${unlisted.join('\n')}`
    ).toEqual([])
  })
})
