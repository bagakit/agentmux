import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AgentAvatar } from '../src/renderer/src/components/AgentAvatar.js'

const SOURCE = readFileSync(
  new URL('../src/renderer/src/components/AgentEnamelFilter.tsx', import.meta.url),
  'utf8'
)

function tintedAvatarMarkup(): string {
  return renderToStaticMarkup(createElement(AgentAvatar, {
    label: 'Executor',
    providerId: 'opencode',
    state: 'running',
    appearance: { tint: '#8ab4f8' }
  }))
}

describe('AgentAvatar executor tint contour', () => {
  it('uses a closed enamel backing and a crisp one-pixel outside rim', () => {
    const markup = tintedAvatarMarkup()
    expect(markup).toContain('agent-avatar__filters')
    expect(markup).toContain('agent-provider-icon')
    expect(markup).toContain('operator="dilate"')
    expect(markup).toContain('radius="2"')
    expect(markup).toContain('radius="3"')
    expect(markup).toContain('result="solidAlpha"')
    expect(markup).toContain('result="backingAlpha"')
    expect(markup).toContain('result="rimAlpha"')
    expect(markup).toContain('operator="out"')
    expect(markup).toContain('result="enamelBacking"')
    expect(markup).toContain('result="enamelRim"')
    expect(markup).toContain('flood-opacity="1"')
  })

  it('keeps tint behind SourceGraphic instead of flooding the source image', () => {
    const filterStart = SOURCE.indexOf('<filter id={id}')
    const filterEnd = SOURCE.indexOf('</filter>', filterStart)
    expect(filterStart).toBeGreaterThan(-1)
    expect(filterEnd).toBeGreaterThan(filterStart)
    const filter = SOURCE.slice(filterStart, filterEnd)
    expect(filter).toContain('in="SourceAlpha" operator="dilate" radius="4" result="solidDilated"')
    expect(filter).toContain('in="solidDilated" operator="erode" radius="4" result="solidAlpha"')
    expect(filter).toContain('in="solidAlpha" operator="dilate" radius="2" result="backingAlpha"')
    expect(filter).toContain('in="solidAlpha" operator="dilate" radius="3" result="rimOuterAlpha"')
    expect(filter).toContain('in="rimOuterAlpha" in2="backingAlpha" operator="out"')
    // 底色那一句只在源码里问「它是不是从 token 契约取的」——不再钉死字面量。
    // `9223f0aa` 把它换成了 `themeVar('surface0')`，值一样（`var(--surface-0)`）但多了类型，
    // 钉字面量会把一次正确的收敛判成缺陷。**真实取值由下面那条渲染断言负责**，两层各守一侧：
    // 这里守「没有人绕过契约自己写一个色」，那里守「算出来的确实是 surface-0」。
    expect(filter).toContain("floodColor={themeVar('surface0')} floodOpacity=\"1\"")
    expect(filter).toContain('in="SourceGraphic" in2="enamelSurface" operator="over"')
    expect(filter).not.toContain('in2="SourceAlpha" operator="in" />')
    expect(filter).not.toContain('floodOpacity="0.55"')
  })

  it('底衬真的取到 surface-0，而不是只在源码里长得像', () => {
    // 上一条读的是源码文本，它看不穿一次函数调用——`themeVar('surface0')` 若哪天改指别的 token，
    // 那条照旧全绿。所以这里问渲染结果：底衬那枚 feFlood 的颜色必须就是 `var(--surface-0)`。
    const markup = tintedAvatarMarkup()
    const backing = markup.match(/<feFlood[^>]*result="backingColor"[^>]*>/u)?.[0]
    expect(backing, '没有找到底衬那枚 feFlood——下面的断言会恒真').toBeTruthy()
    expect(backing).toContain('flood-color="var(--surface-0)"')
  })
})
