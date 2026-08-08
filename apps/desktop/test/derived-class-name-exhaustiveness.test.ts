import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AgentTimelineItemKind } from '@agentmux/core'
import type { AsyncCheckState, HostCheckState } from '../src/renderer/src/store.js'
import { allStyleRules } from './helpers/styles.js'

/**
 * 一个 class 名由 union 成员**插值**拼出来时，「哪些成员有规则」是一个静默的子集。
 *
 * `rendered-class-has-rule.test.ts` 守的是「渲染了这个 class，样式表里有没有它」，但它的
 * `looksLikeClass` 明确把带 `${` 的 token 排除掉——模板拼出来的 class 是那道守卫**自陈的盲区**，
 * 因为它在源码里根本不以完整字面量的形式存在。于是 `log-row--${item.kind}` 这种写法两头都没人管：
 * 类型层不知道 CSS 的存在，CSS 层看不见那个 union，而 `rendered-class-has-rule` 看不见这个形状。
 *
 * 实测的两处（都在 HEAD 上）：
 *   - `activity-ruler__tick--${item.kind}` / `log-row--${item.kind}` 有 5 个成员，activity.css 只给了
 *     3 条规则。`tool_call` 与 `lifecycle` 今天就没有颜色。
 *   - `check-pill--${…}` 有 5 个可达取值，base.css 给了 4 条；`launch-host-health--${…}` 有 4 个可达
 *     取值，surfaces.css 给了 2 条。
 * 数据侧反而是守着的：`packages/core/src/session-timeline.ts` 用 `Record<AgentTimelineItemKind, true>`
 * 让加成员当场编译不过。**两层各有各的判据**——数据层被 tsc 钉住，不代表表现层跟上了；这条测试补的
 * 就是表现层那一格。
 *
 * 判据是**划分**而不是「全都得上色」：painted ∪ UNPAINTED 必须逐字等于可达成员集。照抄
 * `topic-agent-status.test.ts` 对 `starting` 的做法——「刻意不上色」是个正当答案，但它必须被**写下来**
 * 并带上理由，而不是靠一条缺席的规则表达。手工的「例外清单」在这里不是熵：它就是那个决定本身，
 * 而 union 加成员时它挡不住你，因为新成员既不在 painted 里也不在清单里，划分当场不成立。
 *
 * 三处自陈的边界（不说出来就是假承诺）：
 *   1. 只判「有没有一条规则」，不判**画得对不对**。`.log-row--permission` 被改成绿色，这里照旧绿——
 *      色相归属由 `topic-agent-status.test.ts` 那族按 token 判，两条测试问的不是同一件事。
 *   2. 只判**直接**以该 class 为主体的规则。靠后代选择器间接上色（`.foo .log-row`）不算，因为那不是
 *      「这个成员自己的取值」。
 *   3. 可达性取**类型**允许的集合，不取今天恰好有写入方的集合。`hostChecks` 今天没有任何一处写
 *      `'idle'`，但 `HostCheckState['state']` 允许它——按写入方判会让明天新加的那个写入点静默失守。
 */

const RENDERER_DIR = fileURLToPath(new URL('../src/renderer/src/', import.meta.url))

/**
 * 可达成员表。每张都写成 `Record<那个 union, true>`，于是**union 加成员在这里当场编译不过**
 * （TS2741），删成员也不过（TS2353）——这正是 `session-timeline.ts` 在数据侧用的机制，同一个道理
 * 搬到表现侧。注意它必须是显式注解而不是 `as const`/`satisfies`：只有注解形才在缺键时报错。
 *
 * `apps/desktop/tsconfig.test.json` 把 `test/**` 纳入了编译（见 `type-tree-typecheck.test.ts`），
 * 所以这些表是真会被 tsc 检查的，不是死代码。
 */
const TIMELINE_KIND_MEMBERS: Record<AgentTimelineItemKind, true> = {
  user_message: true,
  assistant_message: true,
  tool_call: true,
  permission: true,
  lifecycle: true
}

const ASYNC_CHECK_MEMBERS: Record<AsyncCheckState, true> = {
  idle: true,
  checking: true,
  ready: true,
  missing: true,
  error: true
}

/**
 * `launch-host-health--` 那一族的取值来自 `HostCheckState`，它用 `Exclude<AsyncCheckState, 'missing'>`
 * 收窄过。取 `HostCheckState['state']` 而不是重抄那个 `Exclude`：收窄一旦变化，这张表跟着红。
 */
const HOST_CHECK_MEMBERS: Record<HostCheckState['state'], true> = {
  idle: true,
  checking: true,
  ready: true,
  error: true
}

type Family = {
  /** class 前缀，末尾就是 `--`：成员名紧跟其后。 */
  prefix: string
  /** 拼出这个前缀的组件，相对 `src/renderer/src/`。前缀后面必须紧跟一个插值才算数。 */
  producers: readonly string[]
  /** 可达成员。取自上面那三张 tsc 强制的表。 */
  members: Record<string, true>
  /** 刻意不上色的成员，连同理由。painted ∪ 这个 = members，多一个少一个都红。 */
  unpainted: readonly string[]
}

const FAMILIES: readonly Family[] = [
  {
    prefix: 'activity-ruler__tick--',
    producers: ['components/ActivityView.tsx'],
    members: TIMELINE_KIND_MEMBERS,
    // 标尺上的刻度回答「这一刻发生了什么值得看的事」。三个语义事件各占一个色相：谁说的（蓝/绿）、
    // 卡在等人（琥珀）。`tool_call` 与 `lifecycle` 是机器跑动的常态噪声——它们仍然画一枚刻度（有事
    // 发生过），但不占色相：一条满是彩色刻度的标尺等于没有标尺。这与设计 SSOT 里「机器上报那一路
    // 按 kind 画图标」不矛盾：图标回答「这是什么事件」，色相回答「要不要看」。
    unpainted: ['tool_call', 'lifecycle']
  },
  {
    prefix: 'log-row--',
    producers: ['components/ActivityView.tsx'],
    members: TIMELINE_KIND_MEMBERS,
    // 与刻度同一套划分，且必须同一套：同一条事件在标尺上有色、在行上没色（或反过来）会让两处对
    // 「这条重不重要」给出相反答案。
    unpainted: ['tool_call', 'lifecycle']
  },
  {
    prefix: 'check-pill--',
    producers: ['components/settings/AgentSettingsPane.tsx', 'components/settings/HostSettingsPane.tsx'],
    members: ASYNC_CHECK_MEMBERS,
    // `idle` 是「还没查过」——它经 `detection?.state ?? 'idle'` 这条兜底到达 DOM。中性底色**就是**
    // 它该有的样子（对照 `topic-agent-status.test.ts` 里 `starting` 的同一个理由）：没有事实可报时
    // 上色就是在报一个不存在的结论。
    unpainted: ['idle']
  },
  {
    prefix: 'launch-host-health--',
    producers: ['components/NewTabSurface.tsx'],
    members: HOST_CHECK_MEMBERS,
    // 同上，外加 `checking`：启动器上这一枚旁边就写着 "Checking" 字样，在途状态由文案承载而不是
    // 色相。（注意 `check-pill--checking` 反过来给了琥珀——两族对同一个取值的处理不一致，记在
    // #832，但那是一个配色决定，不该由这条守卫顺手改掉。）
    unpainted: ['idle', 'checking']
  }
]

/**
 * 样式表里**直接**以 `.<prefix><member>` 为主体的规则所覆盖的成员。
 *
 * 走 `allStyleRules()`（已剥注释）：一条解释规则为何存在的注释里如果逐字写着那个选择器，按原文扫会
 * 让「规则不存在」拿到通行证——这是本仓真出过的事故，见 `helpers/styles.ts`。
 */
function paintedMembers(prefix: string): Set<string> {
  // `-` 刻意不转义：在字符类**外**，`\-` 在 `/u` 模式下是非法转义（实测 SyntaxError: Invalid escape），
  // 而这些前缀个个带连字符。字符类外的裸 `-` 本就没有元字符含义。
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const found = new Set<string>()
  for (const match of allStyleRules().matchAll(new RegExp(`\\.${escaped}([a-z][\\w-]*)`, 'gu'))) {
    found.add(match[1]!)
  }
  return found
}

function producerSource(relativePath: string): string {
  return readFileSync(`${RENDERER_DIR}${relativePath}`, 'utf8')
}

describe('插值拼出来的 class 名，每个可达成员都要有归宿', () => {
  // 前缀在源码里必须真的**后接一个插值**。少了这条，把 `log-row--${item.kind}` 整个删掉或改名之后，
  // 这条测试会继续对着一个没人渲染的前缀数规则并全绿——扫描根写错却报告成功，是本仓最常见的假绿形状。
  for (const family of FAMILIES) {
    it(`${family.prefix} 确实由组件插值拼出（判据在场证明）`, () => {
      const rendered = family.producers.filter((producer) =>
        producerSource(producer).includes(`${family.prefix}\${`)
      )
      expect(rendered, `没有任何组件拼出 ${family.prefix}——这一族要么改名了要么没了`).toEqual([
        ...family.producers
      ])
    })
  }

  for (const family of FAMILIES) {
    it(`${family.prefix} 的上色成员 ∪ 刻意不上色 == 可达成员`, () => {
      const reachable = Object.keys(family.members)
      const painted = [...paintedMembers(family.prefix)].filter((member) => reachable.includes(member))
      // 划分的两半必须互斥：一个成员既有规则又被写进「刻意不上色」，说明那条理由已经过期。
      const both = painted.filter((member) => family.unpainted.includes(member))
      expect(both, `${family.prefix} 这些成员既有规则又被列为刻意不上色`).toEqual([])
      expect([...painted, ...family.unpainted].sort()).toEqual([...reachable].sort())
    })
  }

  // UNPAINTED 只能列可达成员。列一个不存在的名字，就是拿一条永远无害的例外把划分撑成立——
  // 前一条断言此时照旧全绿（它只比集合是否相等），所以这个洞要单独堵。
  for (const family of FAMILIES) {
    it(`${family.prefix} 的「刻意不上色」清单里没有陈旧名字`, () => {
      const reachable = Object.keys(family.members)
      expect(family.unpainted.filter((member) => !reachable.includes(member))).toEqual([])
    })
  }

  it('提取器真的读到了规则，而不是对着空集报成功', () => {
    // 反向自检：判据必须能区分「有规则」与「没规则」。上面每一族的 painted 都可能是空集而划分仍
    // 成立（只要 UNPAINTED 恰好列全），所以这里独立证明提取器在真样式表上确实认出了已知的那几条。
    expect([...paintedMembers('activity-ruler__tick--')].sort()).toEqual([
      'assistant_message',
      'permission',
      'user_message'
    ])
    // 分组选择器（`.check-pill--missing, .check-pill--error { … }`）里的每一个都要被认下来——
    // 只认逗号前那个会让第二个成员看起来没有规则。
    expect(paintedMembers('check-pill--').has('missing')).toBe(true)
    expect(paintedMembers('check-pill--').has('error')).toBe(true)
    // 不存在的前缀必须得到空集，否则上面那些「等于可达集」的断言可能是被别的规则顶住的。
    expect(paintedMembers('no-such-family--').size).toBe(0)
  })
})
