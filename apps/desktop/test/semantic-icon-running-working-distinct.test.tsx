import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SemanticIcon } from '../src/renderer/src/components/semantic-icons/index.js'
import { allStyles } from './helpers/styles.js'

// ---------------------------------------------------------------------------
// running 与 working 必须同时在字形与动势上可分（约束原文见
// docs/design/agentmux-surface-density.md「running 使用稳定静态 glyph，working 使用带节奏的动态 glyph；
// 两者不能只靠颜色区分」，以及 agentmux-desktop-interaction.md「running=进程活着未产出→静态；
// working=正在产出→带节奏」，reduced-motion 下动势退化为静态但**字形差异必须保留**）。
//
// 判据分两轴，两个方向都钉：
//   字形轴（静屏也分得开）：lucide 给 Activity/Radio 各自的 glyph class 与不同的 SVG path。
//   动势轴：`working` 的字形挂 `.semantic-icon--working`（activity.css 里绑到 activity-working-pulse
//     这条 opacity 节奏），`running` 不挂——所以 running 无动画、working 有。
//
// 修在共享的 SemanticIcon renderer 一处：ProjectActivity 的会话行、ConversationMessage 的 Streaming 徽标
// 等全部调用方都经它路由（memory: 两个写入点要收成一处投影），不逐站点各挂一次动画。
// ---------------------------------------------------------------------------

function markup(name: 'running' | 'working'): string {
  return renderToStaticMarkup(createElement(SemanticIcon, { name, size: 13 }))
}

describe('running 与 working 在字形与动势上都可分', () => {
  const running = markup('running')
  const working = markup('working')

  it('自检：两个字形都真的渲染出来了（否则下面在空串上比对，恒真）', () => {
    // lucide 的 glyph class 是字形身份的证据。两者都在场，才谈得上"它们不同"。
    expect(running).toContain('lucide-radio')
    expect(working).toContain('lucide-activity')
    // 反向：running 不是 Activity，working 不是 Radio——字形没被换成同一个。
    expect(running).not.toContain('lucide-activity')
    expect(working).not.toContain('lucide-radio')
  })

  it('字形轴：两者的 SVG 结构不同——静屏截图也分得开', () => {
    // 剥掉 class 属性只比结构，证明差异来自不同的 glyph（不同 path），不是仅仅 class 名不一样。
    const strip = (s: string) => s.replace(/class="[^"]*"/g, '')
    expect(strip(running)).not.toBe(strip(working))
  })

  it('动势轴：working 挂 semantic-icon--working，running 不挂', () => {
    expect(working).toContain('semantic-icon--working')
    expect(running).not.toContain('semantic-icon--working')
    // 两者都还带共享基类，证明差异只在那枚 working 标记上，不是整条 class 拼错。
    expect(running).toContain('semantic-icon')
    expect(working).toContain('semantic-icon')
  })
})

describe('semantic-icon--working 的动势规则与 reduced-motion 退化（从样式表反推）', () => {
  const css = allStyles()

  it('自检：扫到了东西', () => {
    expect(css.length).toBeGreaterThan(100_000)
    // 锚点必须真的存在于样式表里，否则下面每条切片都在空串上恒真。
    expect(css.indexOf('.semantic-icon--working')).toBeGreaterThan(-1)
  })

  // 该选择器的每一处规则体（正常上下文一条 + reduced-motion 里一条）。
  const bodies = [...css.matchAll(/\.semantic-icon--working\s*\{([^}]*)\}/g)].map((m) => m[1]!)

  it('恰好两处规则：一处带节奏动画，一处（reduced-motion 下）退化为静态', () => {
    // 两处都在，才谈得上"正常动、reduced-motion 静"。少一处就漏掉一半合同。
    expect(bodies.length).toBe(2)
    const animated = bodies.filter((body) => /animation:\s*[a-z][\w-]+\s/.test(body))
    const stilled = bodies.filter((body) => /animation:\s*none/.test(body))
    expect(animated.length, 'working 字形没有任何带节奏的 animation 规则——只剩字形区分不满足合同').toBe(1)
    expect(stilled.length, 'reduced-motion 下 working 字形没有退化为静态').toBe(1)
  })

  it('那条动画绑定的是样式表里真实存在的 @keyframes，不是打错的名字（打错会被浏览器静默丢弃）', () => {
    const declared = /animation:\s*([a-z][\w-]+)\s/.exec(bodies.find((b) => /animation:\s*[a-z][\w-]+\s/.test(b)) ?? '')
    expect(declared, 'working 字形的 animation 名解析不出来').not.toBeNull()
    const keyframe = declared![1]!
    // 从样式表反推：这个名字必须有一条 @keyframes 定义它，否则动画不生效。
    expect(css.indexOf(`@keyframes ${keyframe}`), `${keyframe} 没有对应的 @keyframes 定义`).toBeGreaterThan(-1)
  })
})
