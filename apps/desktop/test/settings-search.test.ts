import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { BUILT_IN_AGENT_PROVIDER_IDS } from '@agentmux/core/provider-id'
import { visibleSettingsSections } from '../src/renderer/src/components/SettingsPanel.js'

/**
 * 守的缺陷（#297）：Agents 这一节的搜索词曾手抄一份 Provider 名单，停在最早的 9 家。内置增到
 * 13 家后，在设置搜索框里打 `kimi` / `droid` / `copilot` / `opencode` 一条都搜不出来——而 Agents
 * 正是管着它们的那一节。修复是让那串关键词从 `BUILT_IN_AGENT_PROVIDER_IDS` 派生。
 *
 * 判据是**逐 id 真跑一次过滤**，不是「关键词串里有没有这个词」：后者对「派生了但没接进
 * SECTIONS」失明（那时串在场而搜索用的是别的串），而这条走的就是组件真正调用的那个函数。
 */
describe('设置搜索', () => {
  it('每个内置 Provider 的 id 都能搜出 Agents 这一节', () => {
    // 挡板：id 全集读成空则下面循环一条不跑、整条静默通过。
    expect(BUILT_IN_AGENT_PROVIDER_IDS.length, '内置 id 全集为空，判据失效').toBeGreaterThanOrEqual(13)

    for (const providerId of BUILT_IN_AGENT_PROVIDER_IDS) {
      const matched = visibleSettingsSections(providerId).map((section) => section.id)
      expect(matched, `搜 ${providerId} 搜不到 Agents 这一节——关键词落后于内置 Provider 清单`)
        .toContain('agents')
    }
  })

  it('搜索确实在过滤，不是把每个查询都当成空查询', () => {
    // 反向挡板：若 `visibleSettingsSections` 退化成恒返回全部 section，上面那条会全绿而搜索
    // 对用户彻底无用。这里要求一个只属于某一节的词只命中那一节。
    const all = visibleSettingsSections('')
    expect(all.length, '空查询应返回全部 section').toBeGreaterThan(1)
    expect(visibleSettingsSections('tmux').map((section) => section.id)).toEqual(['general'])
    expect(visibleSettingsSections('worktree').map((section) => section.id)).toEqual(['workspaces'])
    // 而一个谁都不含的词必须什么都不返回——否则「过滤」只是名义上的。
    expect(visibleSettingsSections('zzzznotakeyword')).toEqual([])
  })

  it('组件里那句取值只是转发，没有第二份过滤逻辑', () => {
    // 上面两条守「函数算得对不对」，这条守「组件有没有真的用它」。抽成函数只解决一半：壳里
    // 完全可以留一份自己的过滤（或者干脆不过滤）而那两条照旧全绿。
    const source = readFileSync(
      fileURLToPath(new URL('../src/renderer/src/components/SettingsPanel.tsx', import.meta.url)),
      'utf8'
    )
    const forwarding = source.match(/useMemo\(\(\) => visibleSettingsSections\(query\), \[query\]\)/gu)
    expect(forwarding?.length, '组件不再把搜索过滤转发给 visibleSettingsSections').toBe(1)
    // 侧栏导航的分组列表也必须来自纯函数。壳里原先留着一句 `visibleSections.filter(…group…)`，
    // 而那一句才是侧栏真正渲染用的列表——它现在归 settingsNavGroups 算。
    const navForwarding = source.match(/useMemo\(\(\) => settingsNavGroups\(query\), \[query\]\)/gu)
    expect(navForwarding?.length, '侧栏分组不再来自 settingsNavGroups——壳里又自己算了一遍').toBe(1)
  })

  it('壳里一句过滤都没有', () => {
    // 这条替换了原先「数 `\bSECTIONS\.filter` 出现几次」的判据。那个判据被实测绕过：把壳里
    // `:122` 那句改成 `[...SECTIONS].filter(…)`（中间隔了个 `]`，正则失配），侧栏从此**永不
    // 随搜索词过滤**——用户打什么词侧栏都是全量——而 4 条测试全绿。记忆
    // counting-a-symbol-misses-other-spellings：数符号名守不住别的拼法；给它补 `\b`
    // 只是把「照抄同一个标识符」这一种拼法认了出来，别的拼法照旧能绕。
    //
    // 所以不再去猜拼法，改成消除分岔本身：分组也搬进 `settingsNavGroups`，于是壳里**一句
    // 过滤都不该剩**。判据是 AST 上「SettingsPanel 函数体里没有任何 `.filter(` 调用」——
    // 与怎么拼无关（`[...X].filter`、`Object.values(X).filter`、`y.filter` 都会被认出）。
    const source = readFileSync(
      fileURLToPath(new URL('../src/renderer/src/components/SettingsPanel.tsx', import.meta.url)),
      'utf8'
    )
    const ast = ts.createSourceFile('SettingsPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    let shell: ts.FunctionDeclaration | undefined
    ast.forEachChild((node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'SettingsPanel') shell = node
    })
    expect(shell, '找不到 SettingsPanel 这个函数声明——判据的范围落空，这条什么都不检查').toBeDefined()

    // 前提自检：判据认得出 `.filter(` 这个形状本身。若这段遍历写错，主断言会在「一处都没找到」
    // 上静默通过——正是它要取代的那种失明。
    const filterCallsIn = (node: ts.Node): number[] => {
      const lines: number[] = []
      const walk = (current: ts.Node): void => {
        if (
          ts.isCallExpression(current) &&
          ts.isPropertyAccessExpression(current.expression) &&
          current.expression.name.text === 'filter'
        ) {
          lines.push(ast.getLineAndCharacterOfPosition(current.getStart(ast)).line + 1)
        }
        ts.forEachChild(current, walk)
      }
      walk(node)
      return lines
    }
    // 自检的靶子取模块顶层：`visibleSettingsSections` 与 `settingsNavGroups` 各有一处合法的
    // `.filter(`，判据必须数得出来。数成 0 就说明遍历坏了。
    expect(filterCallsIn(ast).length, '整份文件一处 `.filter(` 都没找到——判据失效，主断言恒绿')
      .toBeGreaterThanOrEqual(2)

    expect(filterCallsIn(shell!), [
      '`SettingsPanel` 这层壳里出现了 `.filter(` 调用。',
      '按搜索词过滤、按分组切分都归纯函数（visibleSettingsSections / settingsNavGroups）；',
      '壳里留一份自己的过滤，就总有一种拼法能把它换成不读 query 的版本，而上面几条照旧全绿——',
      '`[...SECTIONS].filter(…)` 就是实测绕过原判据的那一种，侧栏从此永不过滤。'
    ].join('\n')).toEqual([])
  })

  it('组件里没有第二处按搜索词过滤 section 的地方', () => {
    // 上一条守「壳里没有 `.filter(`」。但第二份过滤不一定写成 `.filter`——一个 for 循环里
    // `includes(query)` 同样是过滤，且不含 `.filter(`。所以这条从另一侧判：**壳里谁在读 `query`**。
    // 那是搜索过滤绕不开的输入，与用什么语法过滤无关。两条互补，缺一侧就有一族拼法无人守
    //（记忆 counting-a-symbol-misses-other-spellings）。
    //
    // 范围必须用语言自己的作用域规则圈，不能整份文件一起数：`visibleSettingsSections(query)` 的
    // **形参**也叫 `query`，混进来就把「纯函数的入参」和「组件的 state」算成一类（实测整份文件
    // 数出 7 处，其中 2 处是那个形参）。只走 `SettingsPanel` 这个函数体，读到的就只有壳里的 state。
    const source = readFileSync(
      fileURLToPath(new URL('../src/renderer/src/components/SettingsPanel.tsx', import.meta.url)),
      'utf8'
    )
    const ast = ts.createSourceFile('SettingsPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    let shell: ts.FunctionDeclaration | undefined
    ast.forEachChild((node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'SettingsPanel') shell = node
    })
    expect(shell, '找不到 SettingsPanel 这个函数声明——判据的范围落空，这条什么都不检查').toBeDefined()

    const readsOfQuery: number[] = []
    const walk = (node: ts.Node): void => {
      // 只算**读取**：`setQuery(...)` 是写入口，`const [query, setQuery]` 是声明，都不算。
      if (
        ts.isIdentifier(node) &&
        node.text === 'query' &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
        !ts.isVariableDeclaration(node.parent) &&
        !ts.isBindingElement(node.parent)
      ) {
        readsOfQuery.push(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1)
      }
      ts.forEachChild(node, walk)
    }
    walk(shell!)

    // 前提自检：判据读成 0 则这条静默通过。
    expect(readsOfQuery.length, '一个 `query` 读取点都没找到——判据失效，这条什么都不检查')
      .toBeGreaterThan(0)
    expect(readsOfQuery.length, [
      `\`query\` 在壳里的读取点变成了 ${readsOfQuery.length} 处（行号：${readsOfQuery.join(', ')}）。`,
      '合法的 7 处是：`visibleSettingsSections(query)` 与 `settingsNavGroups(query)` 两句转发各占 2',
      '（实参 + 依赖数组），搜索框的 `value={query}` 与清空按钮的条件各 1，空结果提示里回显那一句 1。',
      '多出来的读取点通常意味着壳里又判了一次「哪些 section 匹配搜索词」——那就是第二份过滤逻辑。',
      '如果这次新增是别的正当用途，把这个数字连同理由一起更新。'
    ].join('\n')).toBe(7)
  })
})
