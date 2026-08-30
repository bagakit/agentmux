import { describe, expect, it } from 'vitest'
import { AGENT_DISPLAY_STATES, isNeedsYouState } from '../src/renderer/src/lib/attention-vocabulary'
// `allStyles` 只给剥注释自检用（证明剥注释真剥掉了东西）；所有判「声明在不在场」的断言走 `allStyleRules`。
import { allStyleRules, allStyles } from './helpers/styles.js'

// 把 #397/#409 那道**可达性**守卫从单一的「墨色（--status-ink）」轴推广到整个状态规则族。
//
// tsc 对 CSS 完全失明：给 `AgentDisplayState` 加第十个成员，或把某个态在 `NEEDS_YOU_BY_STATE` 里翻成
// true，都不会有编译错、也不会有测试红——新态会静默渲染成一枚默认灰点，没有脉动、没有描边、没有那枚
// 「等你」角标。墨色那一轴已经被 topic-agent-status.test.ts 用 `inkByState` / `HUE_OWNERS` 钉死（每个态
// 恰好被赋色一次、四个色相各归属哪些态），本文件**不重复它**，只补它没覆盖的四条轴：
//
//   PIP    —— needs-you 那枚 `?` 角标。共享状态点那道缝（`.status--<state> .status__dot::after`）。
//   PULSE  —— 「在跑」那颗点的脉动动画（`.status--<state> .status__dot { animation }`）。
//   SHAPE  —— 点的填充形态：默认实心 vs 掉线态的空心环（`background: transparent`）。
//   CONTOUR—— Provider alpha轮廓读共享墨色；状态点绝对定位在一个角上，不能重新画矩形状态框。
//
// 词表两半都从**代码**读，不在这里手抄：`AGENT_DISPLAY_STATES` 是成员全集，`isNeedsYouState` 是逐态判定
// （二者都来自 attention-vocabulary.ts 那张 total Record）。于是在 `NEEDS_YOU_BY_STATE` 里翻一个判定，
// 下面 NEEDS_YOU / NOT_NEEDS_YOU 两个集合自动跟着变——守卫钉的是 SSOT 今天的答案，而不是昨天抄下来的
// 一份。board-run-card.test.ts 用 `attentionAccentFor` 也是这么做的，比 needs-you-predicate-scope 里
// 重新走一遍 TS parser 更直接（那里必须解 union 成员，这里不必）。
//
// 判据一律落在**声明体**上，不是「选择器名字在场」——这一族在本仓反复以那种方式假绿过：grep 到
// `[data-state="waiting"]` 就放行，而有人把承重的声明体删空、只剩一条空规则，守卫照旧全绿。所以每条轴
// 问的都是「有没有一条规则真的把这个属性设成了一个有区别的值」，且每条都在下面配了一次删声明体的变异
// 见证（提交信息里记了真实的红/绿计数）。
//
// 每条轴按性质各自选了判据形态（constraint 4）：
//   - PIP 是**类结构**：needs-you 集合 ⟺ 带角标的态集合，两个方向都判。这是唯一与 SSOT 判定直接挂钩的
//     轴，也是「新 needs-you 判定不能静默落地」这条保证的落点。
//   - SHAPE / PULSE 用 **SSOT 负向约束 + 存在性**：不是每个态都脉动/都空心（那样反而是错的），但「会脉动
//     的点」必须与 needs-you 不相交（脉动=在忙，别打扰，恰是 needs-you 的反面）、「空心的点」也必须与
//     needs-you 不相交（等你的点必须是实心琥珀带角标，绝不能空心）。翻某个态成 needs-you 会立刻让这两条
//     红，这就是它们与 SSOT 的挂钩，且都不手抄任何状态名。
//   - CONTOUR 与共享状态点挂钩：在跑蓝色、断开中性色；轮廓跟随Provider alpha，不另造矩形状态框。

const NEEDS_YOU = AGENT_DISPLAY_STATES.filter(isNeedsYouState)
const NOT_NEEDS_YOU = AGENT_DISPLAY_STATES.filter((state) => !isNeedsYouState(state))

type Rule = { selector: string; body: string; members: string[] }

/**
 * 逐条拆出规则体，选择器归一化后按逗号拆成成员。
 *
 * 与本族其它守卫同一套 brace-walk：`[^{}]+` 进不了嵌套的 `{`，所以 `@keyframes` 的百分比块会被当成
 * 选择器为 `50%` 之类的伪规则漏出来——它们既不含 `.status--` 也不含 `.status__dot`，被下面每条轴的
 * 提取器天然忽略。`@` 开头的一律跳过。
 */
function parseRules(sheet: string): Rule[] {
  const rules: Rule[] = []
  for (const [, rawSelector, body] of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rawSelector!.trim().replace(/\s+/g, ' ')
    if (selector.startsWith('@')) continue
    rules.push({ selector, body: body!, members: selector.split(',').map((member) => member.trim()) })
  }
  return rules
}

/** 这个选择器成员点名了哪些状态类。用词法边界，`.status--work` 不会命中 `working`。 */
function statesIn(member: string): string[] {
  return AGENT_DISPLAY_STATES.filter((state) => new RegExp(`\\.status--${state}(?![\\w-])`, 'u').test(member))
}

/** 取一条声明的值（首个匹配）。`prop` 要用词法边界避免 `outline-offset` 命中 `outline`。 */
function declValue(body: string, prop: string): string | undefined {
  return new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;}]+)`, 'u').exec(body)?.[1]?.trim()
}

describe('状态规则族的可达性：新态/新判定不能静默落地', () => {
  const styles = allStyleRules()
  const rules = parseRules(styles)

  it('自检：词表从代码解出、CSS 真的读到了（防两个方向的空过）', () => {
    // (a) 词表非平凡，且 needs-you 是**真子集**——否则 PIP 的「两个方向」有一侧恒真。
    expect(AGENT_DISPLAY_STATES.length, '状态词表空了，下面每条轴都会空转').toBeGreaterThan(5)
    expect(NEEDS_YOU.length, 'needs-you 集合空了，PIP 轴会退化').toBeGreaterThan(0)
    expect(
      NEEDS_YOU.length,
      'needs-you 若等于全集，「非 needs-you 态不许带角标」就没有可判的对象了'
    ).toBeLessThan(AGENT_DISPLAY_STATES.length)

    // (b) 样式表真的被读到、被解析成规则。扫描根写错时这几条先红，而不是让下面每条断言在空集上恒真。
    expect(styles.length, '样式表读出来是空的——扫描根写错了').toBeGreaterThan(10_000)
    expect(rules.length, '一条规则都没解析出来').toBeGreaterThan(50)

    // (c) 剥注释真的剥掉了散文、且没把规则一起吃空（本族反复踩过的两个方向）：
    //     dock.css 那段理由注释里逐字写着 `.status__dot`，若不剥注释，判「声明在不在场」会命中散文而假绿。
    expect(styles).toContain('.status__dot')
    expect(styles, '注释里的散文没被剥掉——判据会命中注释而非规则').not.toContain('状态→颜色只在这里说一次')
    expect(allStyles(), '把全文吃空的剥法会让下面每条 not/equal 恒真').toContain('状态→颜色只在这里说一次')
  })

  /**
   * PIP —— needs-you 那枚角标。
   *
   * 判据是**类结构且双向**：带角标的态集合必须**恰好等于** needs-you 集合。
   *   - 少一个（新 needs-you 态没拿到角标）→ 不等 → 红。这正是「新判定静默落地」要防的。
   *   - 多一个（给 done 之类非 needs-you 态加了角标）→ 不等 → 红。
   * 豁免自带前提：非 needs-you 态「不带角标」不是写在一张手抄豁免表里，而是这条等式的另一半——翻
   * `NEEDS_YOU_BY_STATE` 里任一判定，集合自动移动，等式两侧同时跟着变。
   *
   * 只看共享状态点那道缝 `.status--<state> .status__dot::after`：它挂在 `.status--<state>` 上，于是 tab、
   * board 卡、快切、关注度栏所有全尺寸表面一次抬起（chrome.css 那条规则的注释）。头像那枚
   * `[data-attention]::after` 是另一个载体，已由 topic-agent-status 逐 category 守住，不在这条轴内。
   */
  it('PIP：带 `?` 角标的态集合恰好等于 needs-you（从 SSOT 判定派生，双向）', () => {
    const withPip = new Set<string>()
    for (const rule of rules) {
      const content = declValue(rule.body, 'content')
      // `!` 是error字形；这里只发现needs-you问号。空 content（`''` / `""` / none）不是一枚角标，是抹除。
      if (content !== '"?"' && content !== "'?'" ) continue
      for (const member of rule.members) {
        if (!/\.status__dot::after/u.test(member)) continue
        for (const state of statesIn(member)) withPip.add(state)
      }
    }
    // 自检：真的扫到了角标规则（否则 withPip 恒空，下面等式只在 needs-you 也空时才成立，而它不空）。
    expect(withPip.size, '一条 .status__dot::after 角标规则都没扫到——判据会退化').toBeGreaterThan(0)
    expect(
      [...withPip].sort(),
      '带 needs-you 角标的态必须与 NEEDS_YOU_BY_STATE 的 true 项一致：缺一个是新判定静默无角标，' +
        '多一个是给非 needs-you 态发了不该有的角标'
    ).toEqual([...NEEDS_YOU].sort())
  })

  /**
   * PULSE —— 「在跑」那颗点的脉动。
   *
   * 不是每个态都脉动（那是错的：脉动=正在忙、别打扰），所以不按词表全集判。判三件真事：
   *   1. 至少有一个态在脉动——删掉脉动（`animation: none` 或删声明体）会让这条红，那颗「在跑」的心跳
   *      就不会静默消失。`.agent-status-bar` 那条 `animation: none` 是**抑制**（常驻 chrome 不脉动），
   *      取值为 none 被排除，不会被误当成一次脉动。
   *   2. 会脉动的态与 needs-you **不相交**：一颗脉动的点说「我在忙」，与「等你」语义相反；把某个态翻成
   *      needs-you 又让它脉动，这条立刻红。这是 PULSE 与 SSOT 的挂钩，且不手抄任何状态名。
   *   3. 动画名指向一条**真实定义**的 `@keyframes`：`animation: ghost …` 指向不存在的关键帧等于没有动画
   *      （静默失效），所以要求引用的关键帧在表里定义过。
   */
  it('PULSE：有态在脉动、且脉动的态与 needs-you 不相交、且动画名有真实关键帧', () => {
    const definedKeyframes = new Set(
      [...allStyles().matchAll(/@keyframes\s+([\w-]+)/gu)].map((match) => match[1]!)
    )
    expect(definedKeyframes.size, '一个 @keyframes 都没扫到——关键帧可达性判据会退化').toBeGreaterThan(0)

    const pulseStates = new Set<string>()
    const referencedKeyframes: string[] = []
    for (const rule of rules) {
      if (!/\.status__dot(?![\w-])/u.test(rule.selector)) continue
      const animation = declValue(rule.body, 'animation') ?? declValue(rule.body, 'animation-name')
      if (!animation || animation === 'none') continue
      const named = animation.split(/\s+/u).filter((token) => definedKeyframes.has(token))
      referencedKeyframes.push(...named)
      // 只有真的引用了某条已定义关键帧，才算「这颗点会动」；引用不存在的名字＝静默失效，不计入。
      if (named.length === 0) continue
      for (const member of rule.members) for (const state of statesIn(member)) pulseStates.add(state)
    }

    expect(pulseStates.size, '没有任何状态点在脉动——「在跑」的心跳被删掉了').toBeGreaterThan(0)
    expect(referencedKeyframes.length, '脉动规则没有引用任何已定义关键帧＝静默失效').toBeGreaterThan(0)
    expect(
      [...pulseStates].filter((state) => isNeedsYouState(state)),
      '一个 needs-you 态在脉动：脉动说「在忙别打扰」，与「等你」相反，两者不能同一枚点'
    ).toEqual([])
  })

  /**
   * SHAPE —— 点的填充形态。
   *
   * 默认点是实心的（`.status__dot { background: var(--status-ink) }`，且 --status-ink 由墨色轴证明对每个态
   * 都有值），所以**默认可达性天然是全集**：每个态都经继承拿到一枚实心点。这条轴的职责是守那唯一一处
   * 偏离——掉线态的空心环——它必须合法：
   *   - 至少存在一个空心态（删掉 `background: transparent` 会让这条红，掉线点就退回成一枚普通实心点，
   *     与「在跑但闲置」逐像素同款，#473 那类「曾在 vs 在跑」被画成同一件事）。
   *   - 空心态与 needs-you **不相交**：等你的点必须是实心琥珀带角标，绝不能空心。把某个 needs-you 态画成
   *     空心会让这条红。
   *   - 空心（transparent）与默认实心（var(--status-ink)）本身是两个有区别的值（区分度）。
   */
  it('SHAPE：默认点实心、空心偏离仅限非 needs-you 态、且空心与实心确有区别', () => {
    const baseDot = rules.find((rule) => /^\.status__dot$/u.test(rule.selector))
    expect(baseDot, '找不到 .status__dot 基础规则——扫描根或选择器变了').toBeDefined()
    const baseFill = declValue(baseDot!.body, 'background')
    expect(baseFill, '基础点没有 background——每个态默认拿到的实心填充没了').toBeDefined()

    const hollowStates = new Set<string>()
    for (const rule of rules) {
      if (!/\.status__dot(?![\w-])/u.test(rule.selector)) continue
      if (declValue(rule.body, 'background') !== 'transparent') continue
      for (const member of rule.members) for (const state of statesIn(member)) hollowStates.add(state)
    }

    expect(hollowStates.size, '没有任何态画成空心环——掉线点退回实心，与在跑闲置同款').toBeGreaterThan(0)
    expect(baseFill, '默认填充等于 transparent，空心态就不再有区别了').not.toBe('transparent')
    expect(
      [...hollowStates].filter((state) => isNeedsYouState(state)),
      '一个 needs-you 态被画成空心：等你的点必须是实心琥珀带角标'
    ).toEqual([])
    // 与词表挂钩的自检：空心态确实落在 NOT_NEEDS_YOU 里（不是恒真——上一条已排除交集，这条钉「有对象」）。
    expect(NOT_NEEDS_YOU.length).toBeGreaterThan(0)
    expect([...hollowStates].every((state) => NOT_NEEDS_YOU.includes(state as (typeof NOT_NEEDS_YOU)[number]))).toBe(true)
  })

  it('CONTOUR：Provider alpha描边与共享状态点可达，不重建矩形状态框', () => {
    const contour = rules.find((rule) => rule.selector === '.agent-avatar__contour')
    expect(contour, 'alpha轮廓规则缺失').toBeDefined()
    expect(declValue(contour!.body, 'filter')).toBe('none')
    const avatar = rules.find((rule) => rule.selector === '.agent-avatar')
    expect(avatar).toBeDefined()
    expect(declValue(avatar!.body, 'background')).toBe('transparent')
    expect(declValue(avatar!.body, 'outline')).toBeUndefined()
    // 状态点定位在某个角上。定位由共享的 `[data-corner]` 翻译规则给，每枚记号只声明自己的外伸量;
    // **落哪个角**不在这里判——那是叠压几何的裁决，由 selector-presence-mark-corners.test.ts
    // 从头像尺寸与叠压量推出来。在这里再钉一次方位就是把同一个决定写两遍，2026-09-25 把 right
    // 改成 left 时红的正是那种重复。这里只判「这条通路还在」：翻译规则绝对定位，状态点喂得进外伸量。
    const translate = rules.find((rule) => rule.selector === '.agent-avatar [data-corner]')
    expect(translate, '角位翻译规则缺失——记号会退回文档流').toBeDefined()
    expect(declValue(translate!.body, 'position')).toBe('absolute')
    const corner = rules.find((rule) => rule.selector === '.agent-avatar .agent-avatar__status')
    expect(corner, '状态点没有自己的规则').toBeDefined()
    expect(declValue(corner!.body, '--mark-inset'), '状态点没声明外伸量，翻译规则会拿不到值').toBeDefined()
    const ink = (state: string) => {
      const rule = rules.find((item) => item.selector === `.status--${state}`)
      expect(rule, `没有共享${state}墨色`).toBeDefined()
      return declValue(rule!.body, '--status-ink')
    }
    expect(ink('running')).toBe('var(--blue)')
    expect(ink('disconnected')).toBe('var(--text-3)')
    // Any new per-state rectangular outline would compete with the shared corner language.
    const rectangular = rules.filter((rule) => /\.agent-avatar\.status--/u.test(rule.selector) &&
      /(?:^|;)\s*outline\s*:/u.test(rule.body))
    expect(rectangular).toEqual([])
  })
})
