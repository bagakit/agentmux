import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { visibleSettingsSections } from '../src/renderer/src/components/SettingsPanel.js'
import { appLinkRefusedMessage } from '../src/main/browser-app-link.js'
// 直接 import 源码常量，**不经 dist**：`@agentmux/core` 解析到 dist，而 dist 相对本 lane 的源改动
// 是陈旧的，重建它是共享可变状态竞态（记忆 shared-dist-is-a-mutable-state-race）。
// 与 control-spatial-guide.test.ts 同一条规矩。
import {
  AGENTMUX_CLI_HELP,
  AGENTMUX_CLI_SKILL,
  agentMuxCommandHelp
} from '../../../packages/core/src/agentmux-cli-help.js'

/**
 * 守两件事，它们是同一条房规的两半。
 *
 * 一、**拒绝点名的动作真的走得通。** `appLinkRefusedMessage` 说「去 Settings › Browser 把那个
 * 选择忘掉」。这一节在 `664c3e43` 之后确实存在，但那时它里面只有自动化总开关——一个记住了
 * `deny` 的用户照这句话走过去，什么也改不了。**有节无控件同样是到不了**，
 * `browser-automation-setting-reachable.test.ts` 的注释里已经写死了这句话；这里是同一个陷阱的
 * 第二次，只不过这次点名的是另一个控件（记忆 copy-must-name-an-action-reachable-from-this-state）。
 *
 * 二、**三处对外说明都跟上了这条能力。** CLI、skill、启动引导各自面对不同的读者，缺一处就有一类
 * 读者不知道这件事存在。每条正向断言都配反向的一半：只判「提到了 app link」的话，一份把
 * 三处都写成同一句空话的实现照样全绿。
 */

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

/** 从拒绝文案里取出它点名的 Settings 小节名。取不到就是没点名。 */
/**
 * 只取 `AppLinkSchemes` 那一段来判，不判整个文件。
 *
 * 这一刀是变异测出来的：整文件判 `<button … onClick>` 时，**把 Forget 按钮整个删掉照样全绿**——
 * 上面自动化那一节的 Save 按钮满足了它。而删掉 Forget 之后剩下的正是一张只读清单，也就是这整个
 * 任务要修的那个「有节无控件」。判据的扫描面比被测对象大一圈，就会被邻居的正确性喂饱。
 */
function appLinkSection(): string {
  const pane = read('../src/renderer/src/components/settings/BrowserSettingsPane.tsx')
  const at = pane.indexOf('function AppLinkSchemes')
  expect(at, 'AppLinkSchemes 这一节不见了——判据失去靶子').toBeGreaterThan(-1)
  return pane.slice(at)
}

/**
 * 把一段硬换行的说明压成一行再判。
 *
 * 这三份文本都是手工折行的模板字符串，短语随时可能骑在换行上（`asking the\nperson once`）。
 * 逐字写进正则的话，判据变成「这句话有没有恰好折在这个位置」——重排一次段落就红，而说明本身
 * 一个字没改。判语义，不判排版。
 */
function flat(text: string): string {
  return text.replace(/\s+/gu, ' ')
}

function refusalSectionName(): string | null {
  const match = appLinkRefusedMessage('alphaapp').match(/Settings\s*›\s*([A-Za-z ]+?)(?:\.|$)/u)
  return match?.[1]?.trim() ?? null
}

describe('应用链接：拒绝点名的位置真的到得了', () => {
  it('拒绝文案点名了一个 Settings 小节，而且说的是「怎么撤回」', () => {
    const message = appLinkRefusedMessage('alphaapp')
    // 前提自检：这条判据的靶子还在。整句被重写时下面取名字会得到 null，而 null 在「没点名」
    // 与「判据坏了」之间不可区分，所以先把在场判掉。
    expect(message, '拒绝文案里连 scheme 都没说，用户不知道是哪一类链接被挡了').toContain('alphaapp')
    expect(refusalSectionName(), '拒绝没点名具体是 Settings 的哪一节，用户只能自己翻').not.toBeNull()

    // 点名位置还不够：得说清在那儿做什么。「去 Settings 看看」是一句无法行动的话。
    expect(message.toLowerCase(), '没说到那儿之后要做什么动作').toMatch(/forget/u)
  })

  it('被点名的那一节在 Settings 里真的存在，而且搜得出来', () => {
    const named = refusalSectionName()
    expect(named, '文案没点名，前一条已解释').not.toBeNull()

    // 用户找这一节的实际路径就是搜索框，所以判据走组件真正调用的那个过滤函数，
    // 不是「SECTIONS 里有没有这个字符串」。
    const matched = visibleSettingsSections(named!).map((section) => section.id)
    expect(matched, `拒绝让用户去 Settings › ${named}，但搜 “${named}” 一节都搜不出来`).not.toHaveLength(0)
    expect(matched, `搜 “${named}” 没搜到 browser 这一节`).toContain('browser')

    // 反向挡板：若过滤退化成恒返回全部，上面两条会恒真。
    expect(visibleSettingsSections('zzzznotakeyword'), '搜索没在过滤——上面两条恒真').toEqual([])
  })

  it('那一节真的渲染出能改 appLinkSchemes 的控件，而不是一张只读的清单', () => {
    const section = appLinkSection()

    // 改的必须是主进程真正读的那个字段。列一张好看的表却写回别处，用户点了 Forget 也没用。
    expect(section, '这一节没碰 appLinkSchemes——列的不是主进程读的那份').toContain('appLinkSchemes')
    expect(section, '改了不落盘，关掉设置就回来了').toContain('onSave')

    // 承重：这一节里必须有一个**自己的**能点的东西。判据只在这一段内，不在整个文件——
    // 整文件判时，上面自动化那一节的 Save 按钮会把「Forget 被整个删掉」喂成绿的（实测存活过）。
    expect(section, '这一节没有能点的按钮，就是一张只读清单——正是本任务要修的那个「有节无控件」')
      .toMatch(/<button[\s\S]{0,240}onClick=\{\(\) => void forget\(/u)

    // 承重：**Forget 必须删掉那个键**，不是写一个别的值。缺席 / 'allow' / 'deny' 是三档，
    // 把「忘掉」实现成 `'deny'` 会把「下次问我」变成「永远别开」——那是另一件事，而且用户再也
    // 撤不回来了。一个写成 deny 的实现在界面上看起来完全一样。
    expect(section, 'Forget 没有删键——「忘掉」被实现成了别的档位').toMatch(/delete\s+next\[scheme\]/u)

    // 反向的一半：删完得真的存回去。只在本地 state 里删掉，界面会刷新，盘上纹丝不动。
    expect(section, '删了键却没把新的那份存回 config').toMatch(/onSave\(\{[^}]*appLinkSchemes:\s*next/u)
  })

  it('一个都没记过时这一节不渲染——不给尚不存在的东西留一张空表', () => {
    expect(appLinkSection(), '没有空态短路，用户第一次进来会看到一张写着「这里会列出你的选择」的空表')
      .toMatch(/remembered\.length === 0.*return null/su)
  })

  it('这一节真的被 Settings 壳挂上去了', () => {
    // 文件存在但没人渲染等于没有。BrowserSettingsPane 是既有的挂载点，这张表在它内部，
    // 所以判据是「壳渲染了这个 pane」+「pane 里有这张表」——后者由上面几条负责。
    const shell = read('../src/renderer/src/components/SettingsPanel.tsx')
    expect(shell, 'BrowserSettingsPane 没被 SettingsPanel 渲染，这一节点不进去')
      .toMatch(/active === 'browser' \? <BrowserSettingsPane/u)
  })
})

describe('三处对外说明都跟上了应用链接这条能力', () => {
  it('CLI help 说得出这条能力，且说准了「按 scheme 记」', () => {
    const raw = agentMuxCommandHelp('open.browser')
    expect(raw, 'open browser 的 help topic 不见了——判据失去靶子').not.toBeNull()
    const help = flat(raw!)

    expect(help, 'CLI 没提应用链接会被交给系统').toMatch(/handed to the system/iu)
    // 不承诺做不到的精确度：记住的是 scheme，不是站点。说成「按站点」会让用户以为
    // 在 A 站同意过、B 站还会再问一次。
    expect(help, 'CLI 没说清是按 scheme 记还是按站点记').toMatch(/per scheme, not per site/iu)
    // 反向的一半：得说清这一步有人参与。一句「会交给系统」听起来像静默移交，
    // 而静默移交正是本 Feature 明确不做的那一种。
    expect(help, 'CLI 把它说成了静默移交——听起来像点一下就自动开别的应用')
      .toMatch(/asking the person once/iu)
  })

  it('skill 告诉 Agent「点了不跳转」不是点击失败', () => {
    // 这一条是 skill 独有的读者需求：Agent 会 click 一个授权按钮然后等导航。等不到时，
    // 它的默认解释是「点击没生效」或「还在加载」，于是重试或者把超时耗光。
    const skill = flat(AGENTMUX_CLI_SKILL)
    expect(skill, 'skill 没提应用链接这回事').toMatch(/custom-app:|desktop app/iu)
    expect(skill, 'skill 没说 url 不会变——Agent 会一直等一个永远不来的导航')
      .toMatch(/pageInfo\(\)\.url[\s\S]{0,120}(stays|did not move)/iu)
    // 承重的反向一半：必须说清这**不是**失败。只说「url 不变」的话，Agent 仍然会判成错误并重试。
    expect(skill, 'skill 没说清这不是一次失败的点击，Agent 会去重试')
      .toMatch(/not a failed click/iu)
    // 而且要挡住那条更糟的路：Agent 替人做决定。它做不到，也不该试。
    expect(skill, 'skill 没说 Agent 不能替人回答那一问')
      .toMatch(/cannot answer that question on their behalf/iu)
  })

  it('启动引导点出这件事，但不抄命令语法', () => {
    const guide = read('../../../packages/core/src/agent-outbound-message.ts')
    const at = guide.indexOf('AGENTMUX_RUNTIME_GUIDE')
    expect(at, '启动引导常量不见了——判据失去靶子').toBeGreaterThan(-1)
    // 只在那段引导语里判。全文件判的话，文件别处的一句注释就能满足，而引导语本身没写也会绿。
    const launchGuide = flat(guide.slice(at, guide.indexOf('\n\n', at)))

    expect(launchGuide, '启动引导没提应用链接——Agent 会把「页面没动」读成自己的失败')
      .toMatch(/desktop app[\s\S]{0,160}does not navigate/iu)
    // 发现面不许抄语法：确切用法的唯一真相在 skill（与既有那条「不抄 browser run --browser」同源）。
    expect(launchGuide, '启动引导抄了 scheme 清单，与 skill 争夺唯一真相').not.toContain('custom-app:')
  })

  it('三处说的是同一件事：都没把它说成静默移交', () => {
    // 反向的一半，横着判一次。三处各自的正向断言都满足、却各说各话时，用户读 CLI、Agent 读
    // skill、新 Agent 读引导，会得到三种不同的心智模型——而这个能力的要害恰恰是「有人被问了一次」。
    const surfaces: Array<[string, string]> = [
      ['CLI help', agentMuxCommandHelp('open.browser') ?? ''],
      ['skill', AGENTMUX_CLI_SKILL],
      ['启动引导', read('../../../packages/core/src/agent-outbound-message.ts')]
    ]
    for (const [name, text] of surfaces) {
      expect(flat(text), `${name} 没说到「有人被问了一次」，读起来像自动移交`)
        .toMatch(/asks? the person|asking the person|person is asked/iu)
    }
  })

  it('顶层 help 与三处说明的扫描面都非空', () => {
    // 空扫描全绿是本仓反复栽过的第三种白绿。上面几条都在扫文本，先证每一份文本真的在手上。
    expect(AGENTMUX_CLI_HELP.length, '顶层 help 是空的').toBeGreaterThan(200)
    expect(AGENTMUX_CLI_SKILL.length, 'skill 是空的').toBeGreaterThan(200)
    expect((agentMuxCommandHelp('open.browser') ?? '').length, 'open.browser help 是空的').toBeGreaterThan(100)
  })
})
