import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentAvatar } from '../src/renderer/src/components/AgentAvatar.js'
import { readStyleSheet } from './helpers/styles.js'
import { PRESENCE_MARK_CORNERS } from '@agentmux/client-ui/presence-mark-corner'

const SOURCE = readFileSync(
  resolve(import.meta.dirname, '../../../packages/client-ui/src/components/AgentEnamelFilter.tsx'),
  'utf8'
)

describe('Executor avatar badge icons', () => {
  it('preserves the Desktop status/count wrapper and host identity mark around the shared face', () => {
    const working = renderToStaticMarkup(createElement(AgentAvatar, {
      label: 'Executor', providerId: 'codex', state: 'working', count: 3, appearance: { badge: 'shield' }
    }))
    expect(working).toContain('agent-avatar__status agent-avatar__status--working')
    expect(working).toContain(`class="agent-avatar__status agent-avatar__status--working" data-corner="${PRESENCE_MARK_CORNERS.status}"`)
    expect(working).toContain(`class="agent-avatar__count" data-corner="${PRESENCE_MARK_CORNERS.count}"`)
    expect(working).toContain('style="width:14px;height:14px"')
    const originalMark = renderToStaticMarkup(createElement(AgentAvatar, {
      label: 'Mote', state: 'waiting', appearance: { tint: '#8ab4f8', badge: 'bolt' },
      mark: createElement('span', { 'data-original-identity': true }, 'Mote')
    }))
    expect(originalMark).toContain('data-original-identity="true"')
    expect(originalMark).toContain('data-avatar-badge="bolt"')
    expect(originalMark).toContain('agent-avatar__status status__dot')
    expect(originalMark).not.toContain('<filter')
  })

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

  it('overlays the compact badge through the shared live avatar style owner', () => {
    // 只判尺寸与外伸量——**落角不归这条规则管**。叠压簇里那枚徽标的方位由
    // client-ui/presence-mark-corner 分配、由 `[data-corner]` 规则翻译，守在
    // selector-presence-mark-corners.test.tsx。在这里再钉一次方位，就是同一个事实两份真相，
    // 改分配表时这里会打出一条与产品决定相反的假红。
    const sheets = [
      ['@agentmux/client-ui/styles/agent-avatar-face.css', '.agent-avatar__badge', 8, '--mark-inset']
    ] as const
    for (const [file, selector, size, inset] of sheets) {
      const css = readStyleSheet(file)
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
