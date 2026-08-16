import { describe, expect, it } from 'vitest'
import {
  AGENT_COMMAND_GROUP_LABEL,
  composerKeywordAtCaret,
  composerKeywordMatches,
  composerShortcutForBareWord,
  composerShortcutSuggestion,
  composerShortcutsForProvider,
  resolveComposerShortcuts,
  SHORTCUT_GROUP_LABEL
} from '../src/shared/composer-shortcut-library.js'
import type { ComposerShortcut } from '../src/shared/contracts.js'

const generic: ComposerShortcut = { id: 'p-1', keyword: 'eli5', label: 'Explain simply', body: 'Explain this like I am five.' }
const bound: ComposerShortcut = { id: 'p-2', keyword: 'grill_me', label: 'Grill me', body: 'Attack my reasoning.', providerId: 'codex' }

describe('本地 prompt 库的取值层', () => {
  it('缺席与 null 都解析成空列表，不是抛也不是补默认', () => {
    // 缺席即空是这一族的地基：补默认会把用户删掉的 prompt 送回来（见 config-store 那族）。
    expect(resolveComposerShortcuts(undefined)).toEqual([])
    expect(resolveComposerShortcuts(null)).toEqual([])
    expect(resolveComposerShortcuts({})).toEqual([])
    // 而在场时原样给出——上面三条不是因为这个函数恒返回空。
    expect(resolveComposerShortcuts({ composerShortcuts: [generic] })).toEqual([generic])
  })

  it('缺席时返回同一个引用——就地新建 `[]` 会让 zustand 选择器无限重渲染', () => {
    // 这一条不是洁癖：取值层被放在 `useAppStore((state) => resolveComposerShortcuts(state.config))` 里，
    // 而 zustand 按引用比较。每次新建一个 `[]` 就等于"永远变了"，组件无限重渲染。它只在**没有这个
    // 字段**的配置上炸（默认配置带着两条），所以开发时一路正常——正是本仓 selector-inline-default
    // 那一族的形状。
    expect(resolveComposerShortcuts(undefined)).toBe(resolveComposerShortcuts({}))
    expect(resolveComposerShortcuts({})).toBe(resolveComposerShortcuts(null))
  })

  it('不绑定的 prompt 对所有 Agent 可见，绑定的只在那一个 Provider 出现', () => {
    // 判据必须是「缺席 **或** 相等」两支。只写相等会让所有通用 prompt 一条都不出现（那是最常见的
    // 情形），只写缺席则绑定这件事根本没有效果——两种写法各自都会让一半场景静默失效。
    expect(composerShortcutsForProvider([generic, bound], 'codex')).toEqual([generic, bound])
    expect(composerShortcutsForProvider([generic, bound], 'claude')).toEqual([generic])
    // 还不知道是哪个 Agent（新标签页尚未选 Provider）时只给通用那些：此时无从判断绑定条是否适用，
    // 端出来就是在一个它明确不属于的地方展示它。
    expect(composerShortcutsForProvider([generic, bound], undefined)).toEqual([generic])
  })

  it('候选项带上 / 前缀，并把来源放在 group 字段上——同名时用户要能看出这条不是 Agent 自己的命令', () => {
    // 来源必须能显示：候选里同时有 Agent 原生命令与用户自己的 Shortcut，而「打这个词会发生什么」在
    // 两者之间是不同的（一个交给 Agent 执行，一个只把正文填进草稿）。看不出区别就会误发。
    //
    // 来源走 `group` **字段**而不是拼进 description：浮层按它分段加标题（设计 SSOT「同一个 `/` 列表，
    // 但按来源分组并带组标题」）。此前这里断言 description 里含 "Your prompt"，那是把来源编码进一句
    // 文案、再让渲染层解析回来——文案一改就静默失效，而且两条来源的标注没有任何结构上的关系。
    const suggestion = composerShortcutSuggestion(generic)
    expect(suggestion.text).toBe('/eli5')
    expect(suggestion.description).toContain('Explain simply')
    expect(suggestion.group, '候选没有标出来源，浮层无从分段，与 Agent 命令无从区分').toBe(SHORTCUT_GROUP_LABEL)
    // 两个组标签必须不同，否则"分组"这件事在结构上成立而在屏幕上是一段。
    expect(SHORTCUT_GROUP_LABEL).not.toBe(AGENT_COMMAND_GROUP_LABEL)
    // 组标签不许为空：空字符串在浮层里被当作"无分组"，于是标题整个不画。
    for (const label of [SHORTCUT_GROUP_LABEL, AGENT_COMMAND_GROUP_LABEL]) {
      expect(label.length).toBeGreaterThan(0)
    }
  })

  it('裸词按整词相等命中，不按前缀——前缀会让每个以 e 开头的词都亮起来', () => {
    expect(composerShortcutForBareWord([generic, bound], 'eli5')).toEqual(generic)
    expect(composerShortcutForBareWord([generic, bound], 'grill_me')).toEqual(bound)
    // 前缀匹配的形状：`eli` 是 `eli5` 的前缀，但用户还没打完，不该算命中（否则正在打字的每一步都在下划线）。
    expect(composerShortcutForBareWord([generic, bound], 'eli')).toBeUndefined()
    // 反向：包含也不算。`grill_me_harder` 不是 `grill_me`。
    expect(composerShortcutForBareWord([generic, bound], 'grill_me_harder')).toBeUndefined()
    expect(composerShortcutForBareWord([generic, bound], 'unrelated')).toBeUndefined()
    // 空列表上不许恒命中：一个写成 `find(() => true)` 的实现会在这里返回第一条。
    expect(composerShortcutForBareWord([], 'eli5')).toBeUndefined()
  })
})

/**
 * 识别词的命中判定。下划线、打字提示、Tab 替换三处**共用**这一族函数——分开算必然漂移（划了线却
 * 按不动，或按下去替换掉半个词），本仓「读的 key 与写的 key 必须只判一次」记的就是这个。
 */
describe('识别词的整词命中', () => {
  const keywords = ['eli5', 'review-changes', 'grill_me']

  it('整词命中，词的一部分不命中', () => {
    expect(composerKeywordMatches('please eli5 this', keywords)).toEqual([{ from: 7, to: 11, keyword: 'eli5' }])
    // 前后粘着字母的不是这个词。写成 indexOf 无边界判定的实现在这两条上红。
    expect(composerKeywordMatches('preeli5', keywords)).toEqual([])
    expect(composerKeywordMatches('eli5x', keywords)).toEqual([])
  })

  it('带连字符与下划线的 keyword 也要判对边界——`\\b` 在这里是错的', () => {
    // 这是本仓默认 keyword 的真实形状（review-changes）。JS 的 `\b` 把 `-` 当非词字符，于是
    // `\breview-changes\b` 会在 `pre-review-changes` 里命中：`review` 前那个 `-` 正好满足边界。
    expect(composerKeywordMatches('review-changes now', keywords)).toEqual([{ from: 0, to: 14, keyword: 'review-changes' }])
    expect(composerKeywordMatches('pre-review-changes', keywords), '`-` 被当成词边界了：`\\b` 那种写法在这里假命中').toEqual([])
    expect(composerKeywordMatches('grill_me', keywords)).toEqual([{ from: 0, to: 8, keyword: 'grill_me' }])
    expect(composerKeywordMatches('x_grill_me', keywords)).toEqual([])
  })

  it('一段文字里的多处命中按位置给出，不漏后面那些', () => {
    // 只 indexOf 一次的实现只给第一处：第二个词就永远不划线。
    expect(composerKeywordMatches('eli5 then eli5 again', keywords).map((match) => match.from)).toEqual([0, 10])
    // 不同 keyword 混排也要按位置排序，否则装饰顺序与文本顺序不一致。
    expect(composerKeywordMatches('grill_me then eli5', keywords).map((match) => match.keyword))
      .toEqual(['grill_me', 'eli5'])
  })

  it('空 keyword 不参与匹配——否则每个位置都命中，整篇文字下划线', () => {
    // 设置页允许一条 keyword 还没填完就存在于草稿里；`''` 的 indexOf 在每个位置都返回命中。
    expect(composerKeywordMatches('anything at all', [''])).toEqual([])
    expect(composerKeywordMatches('', keywords)).toEqual([])
  })

  it('Tab 只认光标停在词尾那一刻', () => {
    // 'please eli5' 长 11，光标在 11 即刚打完这个词。
    expect(composerKeywordAtCaret('please eli5', 11, keywords)).toBe('eli5')
    // 词中间：这时按 Tab 的人在缩进/遍历焦点，不是要替换。写成「光标落在词里」的实现在这条上红。
    expect(composerKeywordAtCaret('please eli5', 9, keywords)).toBeUndefined()
    // 词尾之后又打了别的：不再是这个词的末尾。
    expect(composerKeywordAtCaret('please eli5 ok', 14, keywords)).toBeUndefined()
    // 没有任何命中时必须交回去（不 preventDefault），否则 Tab 永远出不了输入框。
    expect(composerKeywordAtCaret('nothing here', 12, keywords)).toBeUndefined()
    // 后一个词的词尾也要认，不能只认第一处命中。
    expect(composerKeywordAtCaret('eli5 and grill_me', 17, keywords)).toBe('grill_me')
  })
})
