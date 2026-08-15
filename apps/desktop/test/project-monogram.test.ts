import { describe, expect, it } from 'vitest'
import { projectIconHue, projectMonogram } from '../src/renderer/src/lib/project-monogram.js'
import { clearsSemanticHues } from '../src/renderer/src/lib/conversation-avatar-color.js'

// 这枚牌子存在的唯一理由是「Rail 上十个项目不再是十枚一模一样的灰图标」。所以判据必须是
// **互不相同**与**同一输入恒等**，而不是「返回了个非空串」——后者对「全都返回 A」也成立。

describe('projectMonogram：牌面上的那个字', () => {
  it('取首字母并大写', () => {
    expect(projectMonogram('agentmux')).toBe('A')
    expect(projectMonogram('Bagakit')).toBe('B')
  })

  it('前导空白不是首字母', () => {
    // name[0] 在这里会取到一个空格，牌子上空无一物。
    expect(projectMonogram('   spaced')).toBe('S')
  })

  it('emoji 取整个字素簇，不劈出孤立代理项', () => {
    // name[0] 取到 '\ud83d'（高代理项），渲染成 �。这是真实项目名会踩到的。
    expect(projectMonogram('🚀 deploy')).toBe('🚀')
    // 带 ZWJ 的多码点家族簇同样不许被劈开。
    expect(projectMonogram('👨‍👩‍👧 family')).toBe('👨‍👩‍👧')
  })

  it('中日韩原样通过，不被 toLocaleUpperCase 改写', () => {
    expect(projectMonogram('中文项目')).toBe('中')
  })

  it('取不到就返回空串——不编一个看起来像首字母的 ? 或 #', () => {
    // 空串让调用方如实退回图形字形；编一个字符会让人以为项目真叫那个名。
    expect(projectMonogram('')).toBe('')
    expect(projectMonogram('    ')).toBe('')
  })
})

describe('projectIconHue：确定性与可分辨', () => {
  it('同一 id 恒得同一色相——身份的颜色不随渲染次数或顺序变', () => {
    const first = projectIconHue('ws-alpha')
    for (let i = 0; i < 50; i += 1) expect(projectIconHue('ws-alpha')).toBe(first)
  })

  it('相邻 id 散得开，不是差一度', () => {
    // 朴素字符和会让 ws-1/ws-2 落在相邻色相上，肉眼分不开——那就等于没上色。
    const hues = ['ws-1', 'ws-2', 'ws-3', 'ws-4', 'ws-5'].map(projectIconHue)
    expect(new Set(hues).size).toBe(hues.length)
  })

  it('永远让开语义色——身份色不许被读成状态', () => {
    // 落在 amber 附近的项目图标会被读成「这个项目在等你」。这条判据直接问那个谓词，
    // 而不是在测试里手抄一份保留色表（那只是把同一份数据抄到第三个地方）。
    for (let i = 0; i < 400; i += 1) {
      expect(clearsSemanticHues(projectIconHue(`workspace-${i}`))).toBe(true)
    }
  })

  it('键是 workspaceId 而不是名字——改名不该换颜色', () => {
    // 两个项目可以同名，同一个项目也可以改名；颜色跟身份走。
    expect(projectIconHue('ws-alpha')).not.toBe(projectIconHue('ws-beta'))
  })
})
