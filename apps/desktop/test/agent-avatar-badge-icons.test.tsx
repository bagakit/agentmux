import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AgentAvatar } from '../src/renderer/src/components/AgentAvatar.js'

const SOURCE = readFileSync(
  new URL('../src/renderer/src/components/AgentEnamelFilter.tsx', import.meta.url),
  'utf8'
)

describe('Executor avatar badge icons', () => {
  it('renders a fixed icon beside the Provider mark without badge text', () => {
    const markup = renderToStaticMarkup(createElement(AgentAvatar, {
      label: 'Executor', providerId: 'codex', state: 'running', appearance: { badge: 'shield' }
    }))
    const markStart = markup.indexOf('class="agent-avatar__mark"')
    const markEnd = markup.indexOf('</span></span>', markStart)
    expect(markStart).toBeGreaterThan(-1)
    expect(markEnd).toBeGreaterThan(markStart)
    const mark = markup.slice(markStart, markEnd)
    expect(mark).toContain('data-agent-provider="codex"')
    expect(mark).toContain('data-avatar-badge="shield"')
    expect(mark).toContain('<svg')
    expect(mark).not.toContain('>shield<')
  })

  it('overlays a compact badge inside both provider marks', () => {
    // 只判尺寸与外伸量——**落角不归这条规则管**。叠压簇里那枚徽标的方位由
    // lib/presence-mark-corner.ts 分配、由 `[data-corner]` 规则翻译，守在
    // selector-presence-mark-corners.test.tsx。在这里再钉一次方位，就是同一个事实两份真相，
    // 改分配表时这里会打出一条与产品决定相反的假红。
    const sheets = [
      ['agent-avatar.css', '.agent-avatar__badge', 8, '--mark-inset'],
      ['session-connecting.css', '.session-connecting__executor-badge', 9, 'top']
    ] as const
    for (const [file, selector, size, inset] of sheets) {
      const css = readFileSync(new URL('../src/renderer/src/styles/' + file, import.meta.url), 'utf8')
      // 先剥注释：规则头捕获的是上一个 `}` 之后的全部文本，注释留在里面会让 trim() 后的头对不上，
      // 于是这条规则"没扫到"、body 为 undefined，后面每条 toContain 都在 undefined 上恒假。
      const rules = [...css.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      expect(rules.length).toBeGreaterThan(0)
      const body = rules.find(([, head]) => head!.trim() === selector)?.[2]
      expect(body, `${selector} 没扫到`).toBeDefined()
      expect(body).toContain('width: ' + size + 'px')
      expect(body).toContain('height: ' + size + 'px')
      expect(body).toMatch(new RegExp(`${inset}:\\s*[12]px`, 'u'))
    }
  })

  it('applies one combined contour source around Provider and badge', () => {
    const tinted = renderToStaticMarkup(createElement(AgentAvatar, {
      label: 'Executor', providerId: 'codex', state: 'running', appearance: { tint: '#8ab4f8', badge: 'shield' }
    }))
    expect(tinted).toContain('class="agent-avatar__mark" style="filter:url(')
    expect(tinted).toContain('data-avatar-badge="shield"')
    const filterStart = SOURCE.indexOf('<filter id={id}')
    const filterEnd = SOURCE.indexOf('</filter>', filterStart)
    expect(filterStart).toBeGreaterThan(-1)
    expect(filterEnd).toBeGreaterThan(filterStart)
    const filter = SOURCE.slice(filterStart, filterEnd)
    expect(filter).toContain('in="SourceAlpha"')
    expect(filter).toContain('result="solidAlpha"')
    expect(filter).toContain('result="backingAlpha"')
    expect(filter).toContain('result="rimAlpha"')
    expect(tinted).toContain('data-agent-provider="codex"')
    expect(tinted).toContain('data-avatar-badge="shield"')
    expect(SOURCE).not.toContain('drop-shadow(')
  })
})
