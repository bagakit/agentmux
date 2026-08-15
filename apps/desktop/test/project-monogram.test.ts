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
    //
    // 判据必须是**间隔**而不是**互异**。此前这里只断言 `new Set(hues).size === hues.length`，
    // 那句话对「ws-1=0°, ws-2=1°, ws-3=2°」全真——正是注释说要挡的那个朴素实现，却能拿满分。
    // 断言恒真的典型形态：判据比注释弱一档，读的人以为已经守住了。
    const ids = ['ws-1', 'ws-2', 'ws-3', 'ws-4', 'ws-5']
    const hues = ids.map(projectIconHue)
    expect(new Set(hues).size, '相邻 id 撞到了同一个色相').toBe(hues.length)

    // 色相是环形的，差值要按环上的最短弧算：359° 与 1° 相差 2°，不是 358°。
    const arc = (a: number, b: number): number => {
      const d = Math.abs(a - b) % 360
      return d > 180 ? 360 - d : d
    }
    // 15° 是肉眼能分开的下限量级（相邻色卡约 20-30°）。不写得更严：可用弧被语义色切成三段
    // （见 conversation-avatar-color 的保留弧），五个点挤在窄弧里时过严的阈值会变成偶发红。
    for (let i = 0; i < hues.length; i += 1) {
      for (let j = i + 1; j < hues.length; j += 1) {
        expect(
          arc(hues[i]!, hues[j]!),
          `${ids[i]} (${hues[i]!.toFixed(1)}°) 与 ${ids[j]} (${hues[j]!.toFixed(1)}°) 只差一点点，肉眼分不开`
        ).toBeGreaterThan(15)
      }
    }
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
