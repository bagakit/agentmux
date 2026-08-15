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

describe('projectIconHue：确定性与可分辨', () => {
  it('同一 id 恒得同一色相——身份的颜色不随渲染次数或顺序变', () => {
    const first = projectIconHue('ws-alpha')
    for (let i = 0; i < 50; i += 1) expect(projectIconHue('ws-alpha')).toBe(first)
  })

  it('相邻 id 散得开，不是差一度', () => {
    // 朴素字符和会让 ws-1/ws-2 落在相邻色相上，肉眼分不开——那就等于没上色。
    //
    // 判据必须是**间隔**而不是**互异**。此前这里只断言 `new Set(hues).size === hues.length`，
    // 那句话对「ws-1=0°, ws-2=1°, ws-3=2°」全真——正是注释说要挡的那个朴素实现，却能拿满分。
    //
    // 但**「五个固定 id 两两都隔开 15°」同样不是判据**，而是这五个串的巧合。上一版这么写过，
    // 实测揭穿：可用色相只有 190 个整数度（保留弧的补集），五个点里出现一对靠得近是生日问题，
    // 一个**正确**的实现也会经常违反——连续 ws-N 五连窗口 500 组里 41.2% 违反（ws-266..270 差 0°），
    // 随机 workspace id 五个一组 5000 组里 81.2% 违反。当前这组 ws-1..ws-5 最小弧 20.0°，
    // 离阈值只剩 5° 余量。谁动一下 id 列表、或者加第六个 id，就会红——而那个红不指控任何缺陷。
    //
    // 真正的性质是**统计性**的：avalanche 让「相邻输入」与「随机输入」无区别，所以大量相邻对里
    // 落在 15° 内的比例应该接近均匀分布的水平，而不是接近全部。实测：真实实现 6.5%，
    // 朴素字符和 91.5%。取 25% 作阈值，两边都有 3-4 倍余量，且不依赖任何一组特定 id。
    const ids = Array.from({ length: 201 }, (_, i) => `ws-${i + 1}`)
    const hues = ids.map(projectIconHue)

    // 色相是环形的，差值要按环上的最短弧算：359° 与 1° 相差 2°，不是 358°。
    const arc = (a: number, b: number): number => {
      const d = Math.abs(a - b) % 360
      return d > 180 ? 360 - d : d
    }

    const pairs = hues.slice(1).map((hue, i) => ({ a: ids[i]!, b: ids[i + 1]!, gap: arc(hues[i]!, hue) }))
    const tooClose = pairs.filter(({ gap }) => gap <= 15)
    const share = tooClose.length / pairs.length
    expect(
      share,
      `${(share * 100).toFixed(0)}% 的相邻 id 挤在 15° 内，例：${tooClose
        .slice(0, 3)
        .map(({ a, b, gap }) => `${a}/${b} 差 ${gap.toFixed(0)}°`)
        .join('，')}`
    ).toBeLessThanOrEqual(0.25)

    // 只留这一条比例判据，**没有**再加一条「平均间隔 > 60°」：试过，它是恒真的。
    // 三个变异体（朴素字符和、去 avalanche、只取前 20 个桶）里，凡是平均间隔塌掉的，比例判据先红；
    // 而比例通过却平均塌掉，需要把所有相邻对精确挤在 16-30° 这条窄带上——没有哪个手滑改法能做到。
    // 一条永远绿的断言会让下一个人以为这里守了两件事。
  })

  // 关于「大写钉死 en-US」这条：**它没有在进程内可写的判别器，所以这里不写测试。**
  //
  // 试过两稿，两稿都是恒真的。判据要观测的是「换一台宿主机器，结果会不会变」，而跑测试的这台
  // 是 en-US——无参 `toLocaleUpperCase()` 在这里本来就返回 'I'，与钉死 'en-US' 的结果逐字相同。
  // 把实现改回无参，两稿都照绿。变异测试当场揭穿：那一轮唯一变红的是下面的 ß 用例。
  // 第二稿加了 `not.toBe('istanbul'.toLocaleUpperCase('tr-TR')[0])`，看起来像在比对两种 locale，
  // 其实仍然只是在比 'I' 与 'İ' 这两个常量——被测函数的行为没有进入判据。
  //
  // 换宿主 locale 需要换进程的 ICU 默认值，vitest 起不来这个；而为一条装饰性断言去造一个假的
  // 全局 Intl，等于把「测实现」换成「测我的 mock」。与其留一条永远绿的断言让下一个人以为这里
  // 有守卫，不如如实说明这里没有——这段注释本身就是那个说明。
  //
  // 真要守住，判别器得在**渲染产物**那一层：拿一台 tr-TR 的机器跑一次截图对比。那不在本仓的
  // 测试能力范围内，故只在 project-monogram.ts 的文档里论证，并靠显式实参把行为固定下来。
  it('大写把一个字变成两个时只留第一个——牌面只有一格', () => {
    // 这条是真判别器：ß → SS、ﬁ → FI，两个字符会被 overflow:hidden 裁掉半个。
    // 去掉外层那次 firstGrapheme，它立刻红（实测：expected 'SS' to be 'S'）。
    expect(projectMonogram('ßeta')).toBe('S')
    expect(projectMonogram('ﬁle-server')).toBe('F')
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
