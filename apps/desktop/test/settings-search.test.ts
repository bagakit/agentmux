import { readFileSync } from 'node:fs'
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
    expect(source.match(/SECTIONS\.filter/gu)?.length, '出现了第二份过滤逻辑，两份必然漂移').toBe(1)
  })
})
