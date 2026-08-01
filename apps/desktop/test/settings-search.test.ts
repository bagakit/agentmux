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
    //
    // 判据是壳里那一句**恰好只有转发**：`visibleSettingsSections` 被调用，且组件里不再出现
    // 第二处 `SECTIONS.filter`。前者失守会让搜索走别的逻辑，后者失守会让两份逻辑并存后漂移。
    const source = readFileSync(
      fileURLToPath(new URL('../src/renderer/src/components/SettingsPanel.tsx', import.meta.url)),
      'utf8'
    )
    const forwarding = source.match(/useMemo\(\(\) => visibleSettingsSections\(query\), \[query\]\)/gu)
    expect(forwarding?.length, '组件不再把搜索过滤转发给 visibleSettingsSections').toBe(1)
    // 定义体里那一处 `SECTIONS.filter` 是唯一合法的一处。
    //
    // `\b` 是这条断言的承重部分，不是装饰：没有它，`visibleSections.filter`（`:122` 那句按 group
    // 分组，完全无害）会被算作第二处，于是这条断言从写下的那一刻就是红的——而我当时把那次红
    // 归因成同事的在途变异，靠「恰好 1 条红」这个前提盖了过去。数字面量不加词法边界会**多算**，
    // 与「数一个符号名守不住别的拼法」是同一族的两面。
    expect(source.match(/\bSECTIONS\.filter/gu)?.length, '出现了第二份过滤逻辑，两份必然漂移').toBe(1)
  })

  it('组件里没有第二处按搜索词过滤 section 的地方', () => {
    // 上一条用 `\bSECTIONS\.filter` 计数，加了 `\b` 之后它只认得出「照抄同一个标识符」这一种
    // 写法：把第二份过滤写成 `visibleSections.filter((s) => …includes(query))` 就绕过去了，而那
    // 正是它要防的东西（记忆 counting-a-symbol-misses-other-spellings：数符号名守不住别的拼法）。
    //
    // 所以判据换成「壳里谁在读 `query`」——这是搜索过滤绕不开的输入。
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
      '合法的 5 处是：那一句 `visibleSettingsSections(query)` 转发占 2（实参 + 依赖数组），',
      '搜索框的 `value={query}` 与清空按钮的条件各 1，空结果提示里回显那一句 1。',
      '多出来的读取点通常意味着壳里又判了一次「哪些 section 匹配搜索词」——那就是第二份过滤逻辑。',
      '如果这次新增是别的正当用途，把这个数字连同理由一起更新。'
    ].join('\n')).toBe(5)
  })
})
