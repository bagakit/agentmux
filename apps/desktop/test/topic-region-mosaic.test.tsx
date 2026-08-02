import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { RegionMosaic } from '../src/renderer/src/components/SurfaceToolDock.js'
import { workbenchRegionBounds, createWorkbenchViewLayout, splitWorkbenchRegion } from '../src/renderer/src/lib/workbench-view-layout.js'
import { readFileSync } from 'node:fs'

const dockSource = readFileSync(
  new URL('../src/renderer/src/components/SurfaceToolDock.tsx', import.meta.url),
  'utf8'
)
const branchesSource = readFileSync(
  new URL('../src/renderer/src/components/BranchesPanel.tsx', import.meta.url),
  'utf8'
)

// 行尾那枚 Region 缩略图（Topic 行 only，且只在该 Topic 开着 Tab 时）。这里断言的是**渲染出来的
// 结构**，而不是「禁止某个形状不在场」—— 后者对这一族是弱判据（换个包装就绕过）。缩略图必须：
// 只画 Topic 行的这枚（Branch 行不传它）、门禁开时画出、每个 Region 一格且几何来自 workbenchRegionBounds。

describe('行尾 Region 缩略图的渲染', () => {
  it('单区 Tab 画一个铺满的格子', () => {
    const bounds = workbenchRegionBounds(createWorkbenchViewLayout('r0').root)
    const markup = renderToStaticMarkup(createElement(RegionMosaic, { cells: bounds }))
    expect(markup).toContain('topic-region-mosaic')
    // 每个 Region 一格。
    expect(markup.split('topic-region-mosaic__cell').length - 1).toBe(1)
    // 归一化几何直接乘成百分比：单区铺满 0–100%。
    expect(markup).toContain('width:100%')
    expect(markup).toContain('height:100%')
  })

  it('分屏 Tab 画多格，每格坐标来自真实几何而非另发明一套', () => {
    let layout = createWorkbenchViewLayout('r0')
    layout = splitWorkbenchRegion(layout, 'r0', 'right', 'r1')
    const bounds = workbenchRegionBounds(layout.root)
    expect(bounds).toHaveLength(2)
    const markup = renderToStaticMarkup(createElement(RegionMosaic, { cells: bounds }))
    expect(markup.split('topic-region-mosaic__cell').length - 1).toBe(2)
    // 右半从 x=50% 起：这是竖切后第二块的真实归一化坐标。
    expect(markup).toContain('left:50%')
    // 每块半宽。
    expect(markup.split('width:50%').length - 1).toBe(2)
  })

  it('bounds 为空时不画任何格子（门禁本身在面板里，这里守「没有几何就没有格子」）', () => {
    const markup = renderToStaticMarkup(createElement(RegionMosaic, { cells: [] }))
    expect(markup).not.toContain('topic-region-mosaic__cell')
  })

  it('只有 Topic 行装它，Branch 行不装——且它挂在门禁后面而不是无条件渲染', () => {
    // 用户批准的是「Topic 行 only，且只在该 Topic 开着 Tab 时」。缩略图的构造点只能在 Topic 行，
    // Branch 那侧连引用都不该有——否则「Branch 行保留头像簇」这条就破了。
    expect(branchesSource, 'Branch 面板引用了 Region 缩略图——它只该出现在 Topic 行')
      .not.toContain('RegionMosaic')
    expect(branchesSource).not.toContain('topic-region-mosaic')
    // Topic 行侧：缩略图必须挂在 openMosaics 门禁后面（三元），不是无条件塞进 trailing。
    // 「禁止形状不在场」是弱判据，所以这里正面钉住那次条件构造的确切形状。
    expect(dockSource).toContain('openMosaics.has(topic.id)')
    expect(dockSource).toMatch(/openMosaics\.has\(topic\.id\)\s*\?\s*<RegionMosaic cells=\{openMosaics\.get\(topic\.id\)!\}/)
    // 门禁本身来自那份唯一投影，不是各行自己扫 tabs。
    expect(dockSource).toContain('openTopicRegionMosaics(layout, tabs)')
  })
})
