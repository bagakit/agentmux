import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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
// 判据是「源码里这个复制路径引用了出口」。它挡不住「call 之后被 if(false) 包起来」这种造作形状——
// 那一层由上面的 no-bypass 扫描兜底：壳一旦退回直接写剪贴板就红。两条合起来：壳既不能绕过出口，
// 也不能把转发调用整个删掉。
// ---------------------------------------------------------------------------
describe('五个复制入口 + 两个菜单注入点都转发给出口', () => {
  const FORWARDERS: readonly [file: string, needle: string][] = [
    ['components/FileExplorer.tsx', 'copyTextToClipboard('],
    ['components/BranchesPanel.tsx', 'copyTextToClipboard('],
    ['components/SurfaceToolDock.tsx', 'copyTextToClipboard('],
    ['components/TerminalView.tsx', 'copyTextToClipboard('],
    ['components/BrowserPane.tsx', 'copyTextToClipboard('],
    // 两个菜单注入点：地址菜单的复制经这里注入的 writeClipboardText 落到出口。
    ['components/WorkspaceWorkbench.tsx', 'copyTextToClipboard(text, reportError)']
  ]

  it('每个壳的源码里都出现了对出口的调用', () => {
    for (const [file, needle] of FORWARDERS) {
      const source = readFileSync(`${RENDERER_SRC}/${file}`, 'utf8')
      expect(source, `${file} 没有转发给 copyTextToClipboard`).toContain(needle)
    }
  })

  it('自检：needle 不是空串，且文件都读得到', () => {
    // 防这条自己假绿：needle 若被写空，`toContain('')` 恒真。
    for (const [file, needle] of FORWARDERS) {
      expect(needle.length).toBeGreaterThan(0)
      expect(() => readFileSync(`${RENDERER_SRC}/${file}`, 'utf8')).not.toThrow()
    }
  })
})
