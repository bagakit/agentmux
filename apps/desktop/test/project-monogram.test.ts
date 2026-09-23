import { describe, expect, it } from 'vitest'
import { projectMonogram } from '../src/renderer/src/lib/project-monogram.js'

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

  it('零宽字符不是首字母——它会画出一枚完全看不见的牌子', () => {
    // trim() 认识空格/NBSP/表意空格/BOM，**不**认识 U+200B。实测未修前返回 U+200B：牌面空无一物，
    // 而空无一物正是这个函数存在要消灭的结果。零宽空格是富文本复制粘贴的常见污染物。
    expect(projectMonogram('​project')).toBe('P')
    expect(projectMonogram('​​﻿  project')).toBe('P')
    // trim() 本来就认识的那几类，一并钉住，免得有人把剥零宽那步误当成它们的守卫。
    expect(projectMonogram(' project')).toBe('P')
    expect(projectMonogram('　project')).toBe('P')
  })

  it('不可见字符远不止零宽那五个——判据是 Unicode 属性，不是手抄的码点清单', () => {
    // 此前这里剥的是枚举出来的五个码点（U+200B-200D、U+2060、U+FEFF）。禁止清单必漏：下面每一个
    // 在那一版里都原样进了牌面，画出一枚看不见的牌子——正是上一条要消灭的那个结果，只是换了个码点。
    // 换成 Default_Ignorable_Code_Point 后全部归位；上一条那五个码点是它的严格子集（逐个验过），
    // 所以那条不会因为这次替换而退化。
    //
    // 这里写 \u 转义而不是字面量：每个都配一个写明码点的标签，否则这张表在编辑器里就是一列空白，
    // 下一个人没法确认自己读到的是哪个字符——而「看不见」正是本条要测的东西。
    const invisible: ReadonlyArray<readonly [string, string]> = [
      ['U+00AD 软连字符', '­'],
      ['U+034F 组合字素连接符', '͏'],
      ['U+061C 阿拉伯字母标记', '؜'],
      ['U+180E 蒙古文元音分隔符', '᠎'],
      ['U+2061 函数应用', '⁡'],
      ['U+3164 韩文填充符', 'ㅤ'],
      ['U+115F 初声填充符', 'ᅟ'],
      ['U+E0001 语言标签', '\u{E0001}']
    ]
    for (const [label, prefix] of invisible) {
      expect(projectMonogram(`${prefix}project`), `${label} 开头的名字画出了一枚看不见的牌子`).toBe('P')
    }
  })

  it('前导标点仍然是牌面——剥掉看不见的东西不许顺手改「取哪个」', () => {
    // 允许清单（只收第一个 \p{L}/\p{N}/\p{Emoji} 簇）也能把上面那张表清零，但会把这两个变成
    // G 和 F。跳过前导标点是另一个决定，有它自己的取舍，不该搭这趟车。这条钉住两者的边界。
    expect(projectMonogram('.gitignore')).toBe('.')
    expect(projectMonogram('-flag')).toBe('-')
  })

  it('串中间的 ZWJ 是承重的——只剥前导，不许拆散家族 emoji', () => {
    // 若上面那条改成全串替换，这条立刻红：👨‍👩‍👧 靠 U+200D 连成一个簇，剥掉就只剩 👨。
    expect(projectMonogram('​👨‍👩‍👧 family')).toBe('👨‍👩‍👧')
  })

  it('取不到就返回空串——不编一个看起来像首字母的 ? 或 #', () => {
    // 空串让调用方如实退回图形字形；编一个字符会让人以为项目真叫那个名。
    expect(projectMonogram('')).toBe('')
    expect(projectMonogram('    ')).toBe('')
  })
})
