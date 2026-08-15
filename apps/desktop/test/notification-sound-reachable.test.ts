import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { visibleSettingsSections } from '../src/renderer/src/components/SettingsPanel.js'
import { DEFAULT_NOTIFICATION_SOUND } from '../src/shared/notification-presentation.js'

/**
 * 守的缺陷，是一个**已经发生过**的：`silent?: boolean` 曾经就在 main 的 `NotificationRequest` 上，
 * 投递侧认真读它（`silent: request.silent ?? true`），类型完全正确，而整个应用**没有任何一处传过
 * 它**——声明了、被兑现了、谁也够不着。它就那样活着，因为没有一条判据问过「这根线接上没有」。
 *
 * 现在它接上了，从设置面一路到 Electron 的构造参数。这个文件的职责是让它**保持**接着。判据分四层，
 * 对应这条链上四种各自足以让开关静默失效、而 tsc 与行为测试全绿的改动：
 *
 *   1. 设置里真有这个开关，且**搜得出来**——用户找它的实际路径是搜索框。
 *   2. 那个开关是**可写**的（有 onChange、有 onSave），而不是一个只显示当前值的只读面
 *      （记忆 controlled-input-can-go-silently-readonly：删掉 onChange 渲染毫无变化，永久只读）。
 *   3. 中间每一跳都**带着这个字段**。这是最容易断的一层：renderer → preload → main 的载荷形状，
 *      任何一跳漏掉 `sound`，多出来的属性在 TS 里永远合法，字段被静默丢掉，开关变装饰品。
 *   4. 默认值是「不出声」。这不是风格问题：这个字段落地前所有安装都是静音的，默认打开等于替用户
 *      改掉一个他们做过的选择。
 *
 * 第三层为什么不能靠 tsc：判据取的是**共享类型被真的用上**。四个手抄的同形字面量互相之间 tsc
 * 是满意的，它只会在你少传一个**必填**字段时才红——而少传的那一跳如果自己也重新声明了一遍形状
 * （原先正是四处各声明一遍），就没有任何一侧会红。
 */

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

describe('通知声音开关：用户找得到、按得动、按下去真的到得了系统', () => {
  it('设置里有这个开关，并且用用户会打的词搜得出来', () => {
    // 用户不会搜 "dwell"，他们搜 "sound"。判据走组件真正调用的那个过滤函数，而不是看常量表里
    // 有没有这个字符串。
    for (const query of ['sound', 'mute', 'audio']) {
      const matched = visibleSettingsSections(query).map((section) => section.id)
      expect(matched, `搜 “${query}” 找不到通知这一节——开关在那儿但没人找得到`)
        .toContain('notifications')
    }
    // 反向挡板：过滤器要是退化成恒返回全部，上面三条恒真。
    expect(visibleSettingsSections('zzzznotakeyword'), '搜索没在过滤——上面三条恒真').toEqual([])
  })

  it('那一节渲染出一个真能写的开关，而不是一个只读的显示', () => {
    const pane = read('../src/renderer/src/components/settings/NotificationSettingsPane.tsx')
    // 判据落在 **checkbox 自己那个元素**上，不是整份文件：这一面里还有停留滑轨，它也带 onChange，
    // 于是「文件里有 onChange」在把 checkbox 的 onChange 删掉时恒真（实测：删掉声音这一格的
    // onChange，整份文件照旧含 onChange，这条一动不动地绿——而那个开关已经永久点不动了）。
    // 从 `type="checkbox"` **往回**切到最近的 `<input`，再往后切到最近的 `/>`。两次都往里收，
    // 是因为这一面里另有一个滑轨 input，而且文件顶部的注释里还写着 `<input type="range">` 这几个
    // 字——从 `<input` 正着非贪婪找 checkbox，会从那句注释起头，把整份文件一口吞下去，于是后面
    // 每条断言都在整份文件上求值，等于没收窄（实测：那样写时，删掉 checkbox 的 onChange 依然全绿）。
    const anchor = pane.indexOf('type="checkbox"')
    const start = anchor < 0 ? -1 : pane.lastIndexOf('<input', anchor)
    const end = start < 0 ? -1 : pane.indexOf('/>', anchor)
    const checkbox = start >= 0 && end > start ? pane.slice(start, end + 2) : undefined
    // 自证：切出来的必须是**一个元素**而不是半份文件，否则下面三条是在整份文件上恒真。
    expect(checkbox?.length ?? Infinity, '切出来的不是一个 input 元素——判据没有收窄').toBeLessThan(400)
    expect(checkbox, '面里没有 checkbox，没法开').toBeDefined()
    expect(checkbox, 'checkbox 没有 onChange——受控输入会永久只读，看得见点不动')
      .toMatch(/onChange=\{/u)
    expect(checkbox, 'checkbox 不是受控的——没有 checked，它显示的不是已保存的选择')
      .toMatch(/checked=\{sound\}/u)
    // 写回的必须是 checkbox 的当前值本身，不是「有没有这个字段」。
    expect(pane, '保存时没把 sound 写回去——改了也留不下').toMatch(/onSave\(\{\s*mode,\s*sound\s*\}\)/u)
    // 面板壳必须真的挂上这一节并保存到 config.notifications，否则有面无路。
    const shell = read('../src/renderer/src/components/SettingsPanel.tsx')
    expect(shell, 'NotificationSettingsPane 没被 SettingsPanel 渲染，这一节点不进去').toMatch(
      /active === 'notifications' \? <NotificationSettingsPane/u
    )
    expect(shell, '保存没写到 config.notifications').toMatch(
      /api\.config\.save\(\{ \.\.\.current, notifications \}\)/u
    )
  })

  it('renderer → preload → main 三跳都带着 sound，且共用同一个载荷类型', () => {
    // 这一条守的是那个**已经发生过**的缺陷的复发面。四处各手抄一遍字面量时，加字段要改四个地方，
    // 漏掉任何一处都是静默丢字段。收成一个共享类型之后，漏掉一跳就不再可能——判据因此是「这三处
    // 都在引用那个共享类型」，而不是「这三处的字面量都含 sound」（后者会在有人抄回字面量时静默
    // 失守）。
    const contracts = read('../src/shared/contracts.ts')
    expect(contracts, '共享载荷类型不见了——三跳会各自长回自己的形状').toMatch(
      /export type AgentAttentionNotifyInput = \{/u
    )
    expect(contracts, '共享载荷类型里没有 sound——它没上路').toMatch(
      /export type AgentAttentionNotifyInput = \{[^}]*\bsound: boolean\b/su
    )

    // 判据必须落在**使用处**，不能只看文件里出现过这个名字：import 那一行本身就含这个名字，于是
    // 「整个文件 toContain」在把使用处改回手抄字面量、而 import 还留着时是恒真的（实测：只把
    // preload 的形参换回四字段字面量，这条一动不动地绿）。所以每处都钉它真正的使用位置。
    const usages = [
      ['preload 的 invoke 形参', '../src/preload/index.ts',
        /notifyAgentAttention:\s*\(input:\s*AgentAttentionNotifyInput\)/u],
      ['main 的 IPC handler 形参', '../src/main/ipc.ts',
        /handleWithEvent\('ui:notifyAgentAttention',[^)]*input:\s*AgentAttentionNotifyInput/su],
      ['renderer 的 notifier 端口', '../src/renderer/src/lib/attention-notifier.ts',
        /notify\(input:\s*AgentAttentionNotifyInput\)/u]
    ] as const
    for (const [label, relative, shape] of usages) {
      expect(read(relative), `${label} 没用共享载荷类型——它自己声明了一遍形状，加字段时会被漏掉`)
        .toMatch(shape)
    }

    // main 的投递侧：整条链上唯一一次取反就在这里，方向必须是 `!`。
    const notifier = read('../src/main/agent-notifier.ts')
    expect(notifier, 'main 不再把 sound 翻成 silent——要么没传给系统，要么传反了').toMatch(
      /silent:\s*!request\.sound/u
    )
    // 而且不能留着旧的可选 silent 字段：它是这个缺陷的原型，留着就有人会去传它。
    expect(notifier, '`silent?: boolean` 又回来了——那正是没人够得着的那个字段').not.toMatch(
      /\bsilent\?:\s*boolean/u
    )
  })

  it('从没选过的配置是不出声的，而不是替用户开了声音', () => {
    // 这个字段落地之前，所有安装都是静音的（`silent: request.silent ?? true`）。默认打开等于替
    // 用户改掉一个他们做过的选择——所以默认必须是 false，并且这条要在别处的 resolver 测试之外
    // 再钉一次：那边测的是「解析器读得对」，这条测的是「产品默认是哪一个」。
    expect(DEFAULT_NOTIFICATION_SOUND).toBe(false)
  })
})
