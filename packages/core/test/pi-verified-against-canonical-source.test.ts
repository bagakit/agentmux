import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Pi 的事件与 resume 声明必须对着**正确的那个产品**核验，证据文档要如实记着核的是哪一个。
 *
 * 这条守卫替换了 `pi-unverified-declaration.test.ts`。那一条的机制是对的（双向蕴含，且它自己就抓出过
 * 一次假绿），但它守的**前提是错的**：它记录「`agent_settled` 0 命中、`--session` 不存在、pi 没有
 * 文件 hook 面」，而那三条量出来的是 `~/proj/priv/zfaustk/prime-agent`——**另一个产品**。
 *
 * 两份 checkout 的 npm 包名相同（都是 `@earendil-works/pi-coding-agent`），所以极易混。区分它们的是
 * 上游自己的身份字段，`config.ts:498-504` 就是那份 SSOT：
 *
 *   APP_NAME       = pkg.piConfig?.name      || "pi"
 *   CONFIG_DIR_NAME= pkg.piConfig?.configDir || ".pi"
 *   ENV_AGENT_DIR  = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`
 *
 *   - `~/proj/github/pi`（0.84.4）：piConfig 无 name、configDir `.pi`
 *     → APP_NAME=`pi`、env=`PI_CODING_AGENT_DIR`。**这是 pi。**
 *   - `~/proj/priv/zfaustk/prime-agent`（0.7.2）：piConfig.name=`prime-agent`、configDir `.prime/agent`
 *     → env=`PRIME_AGENT_CODING_AGENT_DIR`。**这是 Prime（T-014），不是 pi。**
 *
 * 那个 fork 自己的 README 把话说死了（`packages/coding-agent/README.md:16`，逐字）：它保留
 * `pi` 的包名与 bin 只是 "for internal compatibility"，"release packaging rewrites the application
 * package and command to `prime-agent`"，并明令 "Do not use the inherited npm package as the Prime
 * Agent install path."——名字是继承来的壳，产品身份是 prime-agent。
 *
 * 对着正确的源码（0.84.4）实测，此前记为「无证据」的三条全部成立：
 *   - `agent_settled`：src 下 10 处命中，含 `on()` 重载（`core/extensions/types.ts:1285`）与事件类型
 *     （`:742`）。它是 0.80.4 才加的新事件（CHANGELOG），所以在 0.7.2 的 fork 里当然 0 命中。
 *   - `--session <path>`：`cli/args.ts:123` 逐字存在。
 *   - 文件 hook 面：`extensions/` 目录扫 `.js`/`.ts`，jiti 加载 default 导出的函数。
 *
 * 判据仍是**双向蕴含**，只是两侧换成了正确的一对：代码里声明 `agent_settled` ⟺ 文档记着它已对
 * canonical 源码核实。任一侧单独消失都红——代码删了而文档还说"已核实"是文档说谎；文档删了而代码还
 * 声明就回到了"无出处的声明"。
 */

const REPOSITORY = new URL('../../../', import.meta.url).pathname
const EVIDENCE = readFileSync(`${REPOSITORY}docs/reviews/agentmux-provider-cli-evidence.md`, 'utf8')
const PI_PROVIDER = readFileSync(`${REPOSITORY}packages/core/src/providers/pi.ts`, 'utf8')
const HOOK_EVENT = readFileSync(`${REPOSITORY}packages/core/src/agent-hook-event.ts`, 'utf8')

const VERIFIED_EVENT = 'agent_settled'
const SECTION_HEADING = '## Pi（T-005）'
/** 区分两个产品的那个字段值。文档必须点名它，否则下一个人还会量错 fork。 */
const FOREIGN_FAMILY_MARKER = 'prime-agent'

/** pi 的事件全集，逐字取自 canonical 源码的 `on()` 重载。 */
const PI_EVENTS = [
  'before_agent_start',
  'agent_start',
  'tool_call',
  'tool_execution_start',
  'tool_execution_end',
  'message_end',
  'agent_settled'
] as const

/**
 * `agent_settled` 被手抄的全部落点。**枚举而不是过滤**——按「谁包含它」过滤会让删掉一处的那个文件
 * 自己退出判据（漂移正好从判据里消失），这是本仓已有先例的一族假绿。
 */
const HAND_COPY_SITES = [
  { path: 'packages/core/src/providers/pi.ts', source: PI_PROVIDER },
  { path: 'packages/core/src/agent-hook-event.ts', source: HOOK_EVENT }
] as const

/** 本节必须落到的这一节，取左右两界——只取左界会让后面每一节都能替它变绿（此前的真实假绿）。 */
function evidenceSection(): string {
  const start = EVIDENCE.indexOf(SECTION_HEADING)
  expect(start, `证据文档必须有《${SECTION_HEADING}》这一节`).toBeGreaterThanOrEqual(0)
  const rest = EVIDENCE.slice(start + SECTION_HEADING.length)
  const nextHeading = rest.search(/\n## /)
  return nextHeading < 0 ? rest : rest.slice(0, nextHeading)
}

describe('pi 的声明与它所核验的 canonical 源码保持成对', () => {
  it('代码声明 agent_settled ⟺ 证据文档记着它已核实', () => {
    // 逐个落点成对，不是把两处 OR 起来——OR 会让「只删一处」变绿，而只删一处正是本节担心的漂移。
    const recordedInEvidence = EVIDENCE.includes(VERIFIED_EVENT)
    for (const { path, source } of HAND_COPY_SITES) {
      // 双向蕴含，不是两条独立断言。
      expect(source.includes(VERIFIED_EVENT), `${path} 与证据文档必须同时有它或同时没有`).toBe(
        recordedInEvidence
      )
    }
  })

  it('本节把 agent_settled 记成已核实，而不是当年那句"0 命中"', () => {
    // 只查名字在场，对「结论被改回无证据」完全失明。所以钉结论本身，且要求结论词与名字**同一行**
    // ——判据落在同一行是上一版守卫用假绿换来的教训，别退回整节搜索。
    const section = evidenceSection()
    const verdictLines = section.split('\n').filter((line) => line.includes(VERIFIED_EVENT))
    expect(verdictLines.length, `本节必须点名 ${VERIFIED_EVENT}`).toBeGreaterThan(0)
    expect(
      verdictLines.some((line) => /已核实|命中|确证/.test(line)),
      `本节必须有一行同时写着 ${VERIFIED_EVENT} 和它的核实结论`
    ).toBe(true)
    // 反向：不许再出现"0 命中/零命中"这个已被推翻的结论。
    expect(
      verdictLines.some((line) => /0 命中|零命中/.test(line)),
      `${VERIFIED_EVENT} 的"0 命中"结论量的是 prime-agent，不许写回本节`
    ).toBe(false)
  })

  it('本节必须写明两个产品之所以易混，以及靠什么区分', () => {
    // 这条守的是**踩空的原因**而不是结论。上一轮之所以量错，是因为两份 checkout 共用 npm 包名；
    // 只记"结论是什么"而不记"为什么会量错"，下一个人会原样再踩一次。
    const section = evidenceSection()
    expect(section, '本节必须点名 prime-agent 这个易混产品').toContain(FOREIGN_FAMILY_MARKER)
    expect(section, '本节必须写明区分两者的字段（piConfig）').toMatch(/piConfig/)
  })

  it('七个事件一个都不少地声明着——不许为了凑绿把规则删空', () => {
    // 反向失败模式：把整条 pi 事件规则删掉能让上面几条变绿，但那是能力回退。
    for (const event of PI_EVENTS) {
      expect(PI_PROVIDER, `${event} 是 canonical 源码确证的事件，不许删`).toContain(event)
    }
  })

  it('每个手抄了这个名字的代码落点都被文档记着，半个修复过不了', () => {
    // 同一概念手抄多份时只改一处必漂移（本仓已有先例）。守「每个落点都被文档点名」，
    // 且落点清单是枚举的——按「谁包含它」过滤，会让删掉它的那个文件自己退出判据。
    for (const { path } of HAND_COPY_SITES) {
      expect(EVIDENCE, `${path} 是 ${VERIFIED_EVENT} 的手抄落点，证据文档必须提到这个路径`).toContain(path)
    }
  })
})
