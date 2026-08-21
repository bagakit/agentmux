import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  NATIVE_PASTE_CHORD,
  terminalMenuChords,
  type TerminalMenuAction
} from '../src/renderer/src/lib/terminal-menu-chords.js'
import { buildCheatSheet } from '../src/renderer/src/lib/shortcut-cheat-sheet.js'
import { bindingById } from '../src/renderer/src/lib/shortcut-registry.js'

/**
 * 守的缺陷（#367）：终端右键菜单曾自己算 `const modifier = isMac ? '⌘' : 'Ctrl+Shift+'`，再拼成
 * `{modifier}C / V / F / K`。两层，第二层是**今天就错的键**：
 *
 *   1. 手抄。注册表是键位 SSOT，cheat-sheet 已经从它投影显示串；菜单再算一份，改键落地那天菜单静默
 *      显示旧键——而菜单正是用鼠标找键位的地方。
 *   2. 那个前缀被套在了两类加速键上。copy/search/clear 是 `letterChords`，非 mac 确实带 Shift；但
 *      **paste 不在注册表里**，它走原生 Edit→Paste role（`main/application-menu.ts` 说这是承重能力），
 *      而原生 paste 的加速键**没有 Shift**。于是非 mac 上菜单宣传 `Ctrl+Shift+V`——一个按了没反应的键。
 *
 * 所以判据分两层，各自能单独变红：
 *   - **取值层**（`菜单的键位来自它声明的来源`）：三行与 cheat-sheet 对同一个 binding id 的说法逐字相同，
 *     paste 与原生 role 的和弦相同。
 *   - **接线层**（`组件把这些值渲染出去`）：组件里每一个 `<kbd>` 的内容都必须是 `terminalMenuChords()`
 *     结果上的取值，用 AST 判——而不是「某个禁止的拼法不在场」。后者换个写法就绕过，还会误伤本文件
 *     合法的同形代码（记忆 forbidden-shape-guard-misfires）。
 */

const COMPONENT = fileURLToPath(
  new URL('../src/renderer/src/components/TerminalContextMenu.tsx', import.meta.url)
)

/**
 * 菜单三行各自声明的 binding id。**在测试里手写**，不从 lib 导出取。
 *
 * 这是刻意的：被守的就是「菜单说的键位和注册表/原生 role 说的是不是同一个」，取值口如果来自被测模块
 * 自己，把 copy 那行改指 `terminal.clear` 也照旧全绿（记忆
 * expected-value-must-not-derive-from-mutation-target）。
 */
const REGISTRY_ROWS: Record<'copy' | 'search' | 'clear', string> = {
  copy: 'terminal.copy',
  search: 'terminal.search',
  clear: 'terminal.clear'
}

/**
 * paste 的键位锚点，写死字面量。
 *
 * 它的 SSOT 在 Electron 的 `role: 'editMenu'` 里，本仓没有可派生的取值口，所以这里钉的是那个 role 的
 * 约定：mac ⌘V，其他平台 Ctrl+V，**两边都没有 Shift**。这一对字面量就是 #367 的回归靶子——修复前非 mac
 * 显示的是 `Ctrl+Shift+V`。
 */
const NATIVE_PASTE_DISPLAY = { mac: '⌘V', other: 'Ctrl+V' }

/** cheat-sheet 面板对某个 binding 的说法，连成菜单那种单串形式（mac 紧挨、其他平台用 + 分隔）。 */
function cheatSheetSays(id: string, isMac: boolean): string {
  const row = buildCheatSheet(isMac)
    .flatMap((group) => group.rows)
    .find((candidate) => candidate.id === id)
  expect(row, `cheat-sheet 里没有 ${id} 这一行——两个面之一已经不认识这个 binding 了`).toBeDefined()
  return isMac ? row!.keys.join('') : row!.keys.join('+')
}

describe('菜单的键位来自它声明的来源', () => {
  it('三行与 cheat-sheet 对同一个 binding 的说法逐字相同', () => {
    // 同一个手势在两个可发现面上必须是同一句话。这一条同时挡住三种坏法：改指别的 binding、
    // 平台分支取反（mac 形状漏到非 mac）、以及自己另写一套 token 拼法。
    for (const isMac of [true, false]) {
      const chords = terminalMenuChords(isMac)
      for (const [action, id] of Object.entries(REGISTRY_ROWS)) {
        expect(
          chords[action as TerminalMenuAction],
          `${action}: 右键菜单与快捷键面板对 ${id} 说了两个不同的键（isMac=${isMac}）`
        ).toBe(cheatSheetSays(id, isMac))
      }
    }
  })

  it('三个 id 都还在注册表里，且都是 terminal scope', () => {
    // 前提自检 + 一条真属性。id 被改名时上面那条会因为 cheat-sheet 找不到行而红，这一条把原因说清楚；
    // 而 scope 是独立的一条：菜单若引一个 window scope 的 binding，它宣传的键在终端持焦时压根不走
    // terminal 那条派发路（`matchShortcut(..., { scope: 'terminal' })`），等于又宣传了一个死键。
    for (const [action, id] of Object.entries(REGISTRY_ROWS)) {
      const binding = bindingById(id)
      expect(binding, `${action} 声明的 ${id} 不在注册表里`).not.toBeNull()
      expect(binding!.scope, `${id} 不是 terminal scope，菜单宣传它就是宣传一个终端里不响的键`).toBe('terminal')
    }
  })

  it('paste 用原生 Edit→Paste 的和弦，两个平台都不带 Shift', () => {
    // #367 的回归靶子。修复前这里非 mac 是 'Ctrl+Shift+V'——原生 role 从来没有那个 Shift，那一格是
    // 一个按了没反应的键。锚点是写死的字面量，不从被测模块派生。
    expect(terminalMenuChords(true).paste).toBe(NATIVE_PASTE_DISPLAY.mac)
    expect(terminalMenuChords(false).paste).toBe(NATIVE_PASTE_DISPLAY.other)
    // 和弦本身也钉一次：显示串是它经 formatChord 来的，但「没有 Shift」这条事实属于和弦。
    expect(NATIVE_PASTE_CHORD.shift, '原生 paste 加速键不带 Shift').toBe(false)
    expect(NATIVE_PASTE_CHORD.alt).toBe(false)
    expect(NATIVE_PASTE_CHORD.primary).toBe(true)
  })

  it('paste 与 copy 在非 mac 上不是同一个形状', () => {
    // 判别器在场自检：整个 #367 的第二层只在**非 mac** 上可观测（mac 两类都是裸 ⌘ + 字母，⌘C / ⌘V，
    // 一个共用的 modifier 前缀恰好两边都对）。所以「两类来源分开了」这件事必须在能观测到它的那个平台
    // 上断言，否则上面几条在一个共用前缀的实现下也能全绿（记忆 property-unobservable-in-default-env）。
    const other = terminalMenuChords(false)
    expect(other.copy).toContain('Shift')
    expect(other.paste).not.toContain('Shift')
    // mac 上它们确实同形——把这一点写出来，说明上面那条为什么必须挑非 mac。
    const mac = terminalMenuChords(true)
    expect(mac.copy).toBe('⌘C')
    expect(mac.paste).toBe('⌘V')
  })
})

/**
 * 每一行菜单项的标签 → 它应当宣传的那个 action。**在测试里手写**，与 {@link REGISTRY_ROWS} 同一条理由。
 *
 * 键位为 null 的四行是刻意的：Select all / Scroll to bottom 没有键位；两条缓冲区复制路
 * （Copy visible output / Copy all output，#638 的出路）今天也没有键位——它们是右键菜单专属入口，
 * 注册表里没有对应的和弦。把它们一起列出来是为了让判据**穷举**——每个菜单项都必须在这张表里有一条，
 * 于是「给某一行加了键位而这里没跟上」也会红，而不是被「只看有 kbd 的那几行」悄悄漏过去。
 * 这张表刚刚兑现过这个作用：加那两行复制项时，本文件当场报出 `expected 8 to be 6`。
 */
const MENU_ROWS: Record<string, TerminalMenuAction | null> = {
  Copy: 'copy',
  'Copy visible output': null,
  'Copy all output': null,
  Paste: 'paste',
  'Select all': null,
  Find: 'search',
  'Scroll to bottom': null,
  'Clear terminal': 'clear'
}

describe('组件把这些值渲染出去', () => {
  const source = readFileSync(COMPONENT, 'utf8')
  const file = ts.createSourceFile(COMPONENT, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

  /** 一行菜单项：它的可见标签，以及它那个 `<kbd>` 的唯一子表达式（没有 kbd 则为 undefined）。 */
  type MenuRow = { label: string | null; labelExpression: string | null; chord: string | null | undefined; source: string | null; handler: string | null }

  /** 一个 JSX 元素的唯一子表达式的源码文本。子节点不止一个、或不是表达式时为 null。 */
  function soleChildExpression(element: ts.JsxElement): string | null {
    const children = element.children.filter(
      (child) => !(ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces)
    )
    const only = children.length === 1 ? children[0] : undefined
    return only !== undefined && ts.isJsxExpression(only) && only.expression !== undefined
      ? only.expression.getText(file)
      : null
  }

  /**
   * 组件里每一个 `ContextMenu.Item`，抽成 (标签, 键位表达式) 这一**对**。
   *
   * 为什么要成对而不是各扫一遍：只把全部 `<kbd>` 抽成一个集合，判据就退化成「读的是 chords 上的某个
   * 属性」，**永远不问哪一行读哪个属性**。实测（review agent 复现，我自己也复现过）：把 Paste 那行改成
   * `{chords.copy}` —— 非 mac 上 Paste 又变回 `Ctrl+Shift+V`，正是 #367 本体 —— 6 条全绿。真实事故形状
   * 就是这个：复制一行菜单项、忘了改属性名。所以判据必须逐元素成对
   * （记忆 name-existence-check-is-blind-to-rule-bodies）。
   */
  function menuRows(): MenuRow[] {
    const rows: MenuRow[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === 'ContextMenu.Item') {
        let label: string | null = null
        let labelExpression: string | null = null
        let source: string | null = null
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (ts.isCallExpression(parent) && parent.expression.getText(file).endsWith('.map')) {
            source = parent.expression.getText(file)
            break
          }
        }
        const select = node.openingElement.attributes.properties.find((prop) =>
          ts.isJsxAttribute(prop) && prop.name.getText(file) === 'onSelect')
        const handler = select && ts.isJsxAttribute(select) && select.initializer && ts.isJsxExpression(select.initializer)
          ? select.initializer.expression?.getText(file) ?? null : null
        let chord: string | null | undefined
        const scan = (child: ts.Node): void => {
          if (ts.isJsxElement(child)) {
            const tag = child.openingElement.tagName.getText(file)
            if (tag === 'span') {
              const text = child.children.find((grand) => ts.isJsxText(grand))
              label = text !== undefined ? text.getText(file).trim() : null
              labelExpression = soleChildExpression(child)
            } else if (tag === 'kbd') {
              chord = soleChildExpression(child)
            }
          }
          ts.forEachChild(child, scan)
        }
        ts.forEachChild(node, scan)
        rows.push({ label, labelExpression, chord, source, handler })
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(file, visit)
    return rows
  }

  it('每一行读的都是它自己那个 action 的键位', () => {
    const discovered = menuRows()
    // Identity actions are a real ninth JSX path, generated from the shared action model. They have
    // no registered shortcuts; check their actual label/handler source rather than ignoring unknown rows.
    const dynamic = discovered.filter((row) => row.labelExpression !== null)
    expect(dynamic).toEqual([{
      label: null, labelExpression: 'action.label', chord: undefined,
      source: 'identityActions.map', handler: '() => void action.onSelect()'
    }])
    const rows = discovered.filter((row) => row.labelExpression === null)
    // 在场自检：遍历坏掉（改 tag 名判据、走错文件）时整条断言会静默恒真
    // （记忆 false-green-gate-patterns「扫描根写错静默变绿」）。
    expect(rows.length, '一个菜单项都没扫到——AST 遍历坏了，下面那些断言已经恒真').toBe(
      Object.keys(MENU_ROWS).length
    )
    // 标签集合必须恰好是那张表——多一行少一行都红，于是新加的行不会绕过下面的逐行判据。
    expect(rows.map((row) => row.label).sort()).toEqual(Object.keys(MENU_ROWS).sort())
    for (const row of rows) {
      const action = MENU_ROWS[row.label ?? '']
      if (action === null) {
        // 没有键位的那两行：给它们加 kbd 时必须回来更新这张表，否则那一格无人守。
        expect(row.chord, `${row.label} 本来没有键位，现在有了——判据表没跟上`).toBeUndefined()
        continue
      }
      // 判据是**这一行**读的是**对应**那个属性。手写字符串、模板拼接、`isMac ? … : …`、以及
      // 「读了 chords 上另一个键」都不满足；它不依赖任何「禁止的拼法」清单，换个写法绕不过去。
      expect(
        row.chord,
        `${row.label} 那行宣传的不是 chords.${action}，而是 ${row.chord ?? '(没有 kbd)'}`
      ).toBe(`chords.${action}`)
    }
  })

  it('那个 chords 确实是 terminalMenuChords() 的返回值', () => {
    // 上一条只钉了「读的是某个叫 chords 的东西」。这一条钉住那个名字的绑定来源，否则把
    // `const chords = { copy: '⌘C', … }` 手写在组件里，上一条照旧全绿
    // （记忆 optional-prop-only-buys-silence：接线层要按 AST 判「值就是那次调用」）。
    let bound: string | null = null
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'chords' &&
        node.initializer !== undefined
      ) {
        bound = node.initializer.getText(file)
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(file, visit)
    expect(bound, '组件里没有名为 chords 的绑定——上一条的前提不在场了').not.toBeNull()
    expect(bound, 'chords 不是 terminalMenuChords() 的返回值').toMatch(/^terminalMenuChords\(/u)
    // 传进去的必须是平台判定，不是写死的一侧：`terminalMenuChords(true)` 会让非 mac 用户看到 mac 键位。
    expect(bound, 'terminalMenuChords 收到的不是平台判定').toContain('isMac')
  })
})
