import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { visibleSettingsSections } from '../src/renderer/src/components/SettingsPanel.js'

/**
 * 守的缺陷：主进程在 `browser:runScript` 的授权闸上拒绝时说的是
 * “Agent browser automation is off. Turn it on in Settings › Browser.”——而 Settings 里**根本没有
 * Browser 这一节**，`agentAutomation` 在整个 renderer 里一次都没出现过。那句拒绝点名了一个到不了
 * 的地方：用户照它去 Settings 翻遍六节也找不到开关，只能去改配置文件，或者放弃。
 *
 * 这比不给指引更糟——它听起来像那个位置已经存在，于是找不到的人会怀疑是自己看漏了
 *（记忆 copy-must-name-an-action-reachable-from-this-state）。AGENTS.md:32-52 要求拒绝必须给出
 * 能走通的下一步，不许是一句无法行动的话。
 *
 * 判据分三层，缺一层就有一整族改动能静默把它变回不可达：
 *   1. 拒绝文案**确实点名**了某个 Settings 小节（不是泛泛一句"去设置里开"）。
 *   2. 那个被点名的名字在 SECTIONS 里真有一节，且**搜得出来**（用户找它的实际路径是搜索框）。
 *   3. 那一节真的渲染出一个写 `agentAutomation` 的控件——有节无控件同样到不了。
 */

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

/** 从主进程那句拒绝里取出它点名的 Settings 小节名。取不到就是文案没点名。 */
function refusalSectionName(): string | null {
  const ipc = read('../src/main/ipc.ts')
  const match = ipc.match(/Agent browser automation is off\.[^'"]*Settings\s*›\s*([A-Za-z ]+?)\./u)
  return match?.[1]?.trim() ?? null
}

describe('Agent 浏览器自动化开关：拒绝点名的位置真的到得了', () => {
  it('拒绝文案点名了一个 Settings 小节', () => {
    const ipc = read('../src/main/ipc.ts')
    // 前提自检：闸门那句话还在。整句被改写/删掉时，下面按它取名字会得到 null，
    // 而 null 在"没点名"与"这条判据坏了"之间不可区分——先把在场判掉。
    expect(ipc, '授权闸上的拒绝文案不见了——这条判据失去靶子').toContain(
      'Agent browser automation is off.'
    )
    expect(refusalSectionName(), '拒绝没有点名具体是 Settings 的哪一节，用户只能自己翻')
      .not.toBeNull()
  })

  it('被点名的那一节在 Settings 里真的存在，而且搜得出来', () => {
    const named = refusalSectionName()
    expect(named, '文案没点名，前一条已解释').not.toBeNull()

    // 用户找这一节的实际路径就是搜索框，所以判据走 visibleSettingsSections——
    // 它就是组件真正调用的那个过滤函数，而不是"SECTIONS 里有没有这个字符串"。
    const matched = visibleSettingsSections(named!).map((section) => section.id)
    expect(matched, `拒绝让用户去 Settings › ${named}，但搜 “${named}” 一节都搜不出来`)
      .not.toHaveLength(0)

    // 而且搜出来的得是浏览器那一节，不是碰巧含这个词的别节。
    expect(matched, `搜 “${named}” 没搜到 browser 这一节`).toContain('browser')

    // 反向挡板：若 visibleSettingsSections 退化成恒返回全部，上面两条会恒真。
    expect(visibleSettingsSections('zzzznotakeyword'), '搜索没在过滤——上面两条恒真').toEqual([])
  })

  it('那一节真的渲染出写 agentAutomation 的控件，而不是一张空壳', () => {
    // 有节无控件同样到不了。判据要落在**写**上：一个只读显示当前值的面，看起来完全一样，
    // 但用户照样开不了（记忆 controlled-input-can-go-silently-readonly：删掉 onChange
    // 会让受控输入永久只读而渲染毫无变化）。
    const pane = read('../src/renderer/src/components/settings/BrowserSettingsPane.tsx')
    expect(pane, '这一节没碰 agentAutomation——开关开的不是闸门读的那个字段').toContain(
      'agentAutomation'
    )
    expect(pane, '没有 checkbox，没法开').toContain('type="checkbox"')
    expect(pane, 'checkbox 没有 onChange——受控输入会永久只读，看得见点不动').toContain('onChange')
    expect(pane, '改了不落盘，关掉设置就没了').toContain('onSave')

    // 闸门读的是 `!== true`，所以面里写回去的必须是布尔本身，不是"有没有这个字段"。
    expect(pane, '写回的不是 checkbox 的当前值').toMatch(/agentAutomation:\s*enabled/u)

    // 这一节必须真的被壳挂上去——文件存在但没人渲染，等于没有。
    const shell = read('../src/renderer/src/components/SettingsPanel.tsx')
    expect(shell, 'BrowserSettingsPane 没被 SettingsPanel 渲染，这一节点不进去').toMatch(
      /active === 'browser' \? <BrowserSettingsPane/u
    )
    // 而且它保存时走的必须是 config.browser 那一支，不是把别的字段写回去。
    expect(shell, '保存没写到 config.browser').toMatch(/api\.config\.save\(\{ \.\.\.current, browser \}\)/u)
  })
})
