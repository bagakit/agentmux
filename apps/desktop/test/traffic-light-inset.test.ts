import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { allStyles } from './helpers/styles.js'

// ---------------------------------------------------------------------------
// macOS 红绿灯让位：两个进程各写一半，且此前没有任何人守。
//
// 主进程只设 `titleBarStyle: 'hiddenInset'`，由 **系统** 决定三颗灯画在哪；renderer 在
// `.sidebar-toggle-chrome` 里硬写 `padding-left: 80px` 给它们腾地方。两个常量必须一致，
// 却分居两个进程、彼此不知道对方存在——教科书式的 drift 形状。
//
// 实测（2026-09-03，#270）：把那 80px 删掉，2485 条测试全绿。唯一提到这个选择器的是
// surface-scale-contract 的 LAYOUT_GEOMETRY，但那是一条**放行**条目
// （`if (px > 24 && LAYOUT_GEOMETRY.has(selector)) continue`），只让 80 这个数值躲过
// 间距刻度检查。放行不是断言：删掉它描述的那条声明，什么都不会红。
//
// 症状是我们自己的图标被系统的关闭/最小化/最大化按钮压住——按不到，也看不见。
// ---------------------------------------------------------------------------

/** 让位宽度。改这个数就必须同时改主进程那侧的锚点，否则下面的一致性断言会红。 */
const TRAFFIC_LIGHT_INSET_PX = 80

const styles = allStyles().replace(/\/\*[\s\S]*?\*\//g, '')

const mainProcessSource = readFileSync(
  new URL('../src/main/index.ts', import.meta.url),
  'utf8'
)

function declarationsFor(selector: string): string {
  // 逐字匹配选择器再取它自己那个块。用 [^{}]* 而不是 [\s\S]* 是为了不跨块吞进邻居——
  // 只取左界的切片会让下一条规则顶上来（见记忆 section-slice-without-right-bound）。
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = styles.match(new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^{}]*)\\}`, 'm'))
  return match?.[1] ?? ''
}

describe('红绿灯让位在场且两个进程说的是同一件事', () => {
  it('前提自检：样式表真的被读进来了，判据没有挂在空处', () => {
    // 扫不到东西的检查会全绿地什么也不说。allStyles() 若返回空串，下面每条 toMatch
    // 都会红在误导人的位置上，所以先把「有内容」本身做成断言。
    expect(styles.length).toBeGreaterThan(10_000)
    expect(declarationsFor('.sidebar-toggle-chrome').length).toBeGreaterThan(0)
  })

  it('.sidebar-toggle-chrome 左侧留出让位宽度', () => {
    // 承重。这条就是删掉后 2485 条全绿的那行声明。
    // 判 padding 的**左值**而不是「文件里出现过 80px」：别处任何一个 80px 都能满足后者。
    const padding = declarationsFor('.sidebar-toggle-chrome').match(
      /padding\s*:\s*([^;]+);/
    )?.[1]
    expect(padding).toBeDefined()
    // `padding: 0 X 0 Y` 的第四个值是左内距。
    const left = padding?.trim().split(/\s+/)[3]
    expect(left).toBe(`${TRAFFIC_LIGHT_INSET_PX}px`)
  })

  it('主进程用的是让系统画灯的那种标题栏——这是让位存在的前提', () => {
    // 这条独立于上一条：主进程若改成 'default'（系统自绘完整标题栏）或 'customButtonsOnHover'，
    // 灯就不在那个位置了，80px 会变成一段无理由的空白——**反向**的缺陷，症状是左上角一大块空。
    // 不写死整行是为了不与格式化打架，但必须钉住那个取值。
    expect(mainProcessSource).toMatch(/titleBarStyle:[^,]*'hiddenInset'/)
  })

  it('主进程没有自己指定灯的位置——一旦指定，两处就必须一起改', () => {
    // 现状是「位置由系统定，我们照抄一个数」。如果哪天主进程开始用
    // `trafficLightPosition` 显式摆放，那么 80px 就不再是抄系统的值，而是必须与
    // 主进程那个坐标一致的派生量。届时这条会红，提醒把两者接成一处而不是各写一份。
    //
    // 这不是「禁止使用那个 API」，是「用了就得回来改这道门」。
    expect(mainProcessSource).not.toMatch(/trafficLightPosition/)
  })

  it('容器把左内距让给内部元素，而不是自己也留一份', () => {
    // 工具坞那条路（.surface-tool-activitybar--compact-chrome）里 SidebarToggleChrome 是子元素，
    // 容器刻意把左 padding 归零，靠内部那 80px 让位。两边都留就是两倍空白，
    // 都不留就是压住灯——所以「容器为 0」和「内部为 80」是成对的事实，各钉一次。
    const dock = declarationsFor('.surface-tool-activitybar--compact-chrome')
    expect(dock.length).toBeGreaterThan(0)
    const padding = dock.match(/padding\s*:\s*([^;]+);/)?.[1]
    expect(padding?.trim().split(/\s+/)[3]).toBe('0')
  })

  it('项目栏那条路只改右内距，不动左侧的让位', () => {
    // .project-rail-titlebar .sidebar-toggle-chrome 覆写了 width 与 padding-right。
    // 它若改用简写 `padding:` 就会连左值一起重设，静默吃掉让位——这是同一族里最容易
    // 犯的那一种（覆写的粒度比它想改的东西更粗）。
    const railOverride = declarationsFor('.project-rail-titlebar .sidebar-toggle-chrome')
    expect(railOverride.length).toBeGreaterThan(0)
    expect(railOverride).toMatch(/padding-right\s*:/)
    expect(railOverride).not.toMatch(/padding\s*:/)
  })
})
