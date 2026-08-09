import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// 只从**公共入口**取，绝不深入 `src/`——这正是「包可从外部消费」的证明：包外消费者拿到的就是这一个
// 说明符，能用它跑通整套代数，就说明 exports map 与内部依赖图都自洽。深 import（`@agentmux/layout/src/...`）
// 在 exports map 里没有条目，本就取不到；这里用公共入口，是把「消费者视角」钉死。
import {
  type SplitTreeNode,
  MIN_SPLIT_RATIO,
  EVEN_SPLIT_RATIO,
  clampSplitRatio,
  collectLeafIds,
  removeLeaf,
  setSplitRatioAtPath,
  regionInDirection,
  createWorkspaceLayout,
  addTab,
  removeTab,
  createWorkbenchViewLayout,
  splitWorkbenchRegion,
  regionIds,
  workbenchRegionBounds
} from '@agentmux/layout'

// -----------------------------------------------------------------------------
// 验收条款「纯布局代数可包外消费」：只 import 公共入口，在**裸的非 DOM/Node 环境**里端到端跑一遍。
// 这不重测各原语的行为（那由 desktop 侧的 substrate / view-layout / region-invariant 套件逐一钉住），
// 只证「从包外拿到的这一个入口，把整套代数串起来能用」——建树、夹比例、收叶、方向寻址、tab-group reducer。
// -----------------------------------------------------------------------------
type Leaf = { id: string }
const idOf = (leaf: { id: string }): string => leaf.id

describe('@agentmux/layout 可从公共入口端到端消费（验收：纯布局代数可包外消费）', () => {
  it('分屏树建树、按路径改比例、收叶——都只用公共入口的原语', () => {
    const tree: SplitTreeNode<Leaf> = {
      type: 'split',
      direction: 'horizontal',
      ratio: EVEN_SPLIT_RATIO,
      first: { type: 'leaf', id: 'a' },
      second: {
        type: 'split',
        direction: 'vertical',
        ratio: EVEN_SPLIT_RATIO,
        first: { type: 'leaf', id: 'b' },
        second: { type: 'leaf', id: 'c' }
      }
    }
    expect(collectLeafIds(tree, idOf)).toEqual(['a', 'b', 'c'])

    // 比例夹到下限（0.02 < MIN_SPLIT_RATIO）。
    const narrowed = setSplitRatioAtPath(tree, '', 0.02)
    expect(narrowed.type === 'split' ? narrowed.ratio : null).toBe(MIN_SPLIT_RATIO)
    expect(clampSplitRatio(0.02)).toBe(MIN_SPLIT_RATIO)

    // 收掉 b，兄弟 c 被提升。
    const afterRemove = removeLeaf(tree, idOf, 'b')!
    expect(collectLeafIds(afterRemove, idOf)).toEqual(['a', 'c'])
  })

  it('方向寻址在裸几何上成立（无 DOM）——regionInDirection 只吃归一化 bounds', () => {
    const regions = [
      { regionId: 'left', bounds: { x: 0, y: 0, width: 0.5, height: 1 } },
      { regionId: 'right', bounds: { x: 0.5, y: 0, width: 0.5, height: 1 } }
    ]
    expect(regionInDirection(regions, 'left', 'right')).toBe('right')
    expect(regionInDirection(regions, 'left', 'left')).toBeNull()
  })

  it('tab-group reducer 与 region reducer 都从公共入口拿到、跑得通', () => {
    const workspace = addTab(createWorkspaceLayout('g0', ['t0']), 'g0', 't1')
    expect(workspace.groups[0]!.tabOrder).toEqual(['t0', 't1'])
    const closed = removeTab(workspace, 'g0', 't1')
    expect(closed.groups[0]!.tabOrder).toEqual(['t0'])

    const view = splitWorkbenchRegion(createWorkbenchViewLayout('r0'), 'r0', 'right', 'r1')
    expect(regionIds(view.root).sort()).toEqual(['r0', 'r1'])
    // workbenchRegionBounds 把树平铺成归一化几何，纯算术、不碰渲染层。
    expect(workbenchRegionBounds(view.root).map((r) => r.regionId).sort()).toEqual(['r0', 'r1'])
  })
})

// -----------------------------------------------------------------------------
// 验收条款「无 UI/Agent 依赖」的机器可检形式：静态扫描 packages/layout/src 下每个文件的 import 说明符，
// 禁止任何 UI/Agent 依赖，只放行 node-free 的类型 SSOT 子路径 @agentmux/core/workbench-layout-preset。
// 这条守的是「纯」这个字：一个 import 了渲染层类型的『纯』包不是纯的。
// -----------------------------------------------------------------------------
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url))

function srcFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full)
    }
  }
  walk(SRC_DIR)
  return out
}

/** 一个源文件里所有 import/export-from 的模块说明符。 */
function importSpecifiers(source: string): string[] {
  const specs: string[] = []
  const re = /(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) specs.push(match[1]!)
  // 也覆盖裸副作用 import（`import 'x'`）与动态 import。
  const bare = /import\s*\(?\s*['"]([^'"]+)['"]\s*\)?/g
  while ((match = bare.exec(source)) !== null) specs.push(match[1]!)
  return specs
}

describe('packages/layout/src 无 UI/Agent 依赖（验收：无 UI/Agent 依赖）', () => {
  // 允许清单：sibling 相对 import（本包内部）与恰好这一个 node-free 子路径。别的一律禁。
  const ALLOWED_BARE = new Set(['@agentmux/core/workbench-layout-preset'])
  // 明确点名的禁止依赖——UI 框架、桌面运行时、状态库、渲染层/桌面包，以及 @agentmux/core 的 **barrel**
  //（barrel 会把 process/filesystem 运行时拖进来；只有 node-free 的预设子路径可以）。
  const FORBIDDEN = [
    'react',
    'react-dom',
    'electron',
    'zustand',
    '@agentmux/desktop',
    '@agentmux/core' // 精确匹配 barrel；下面对子路径单独放行 workbench-layout-preset
  ]

  it('每个 src 文件的 import 说明符都在允许范围内', () => {
    const offenders: string[] = []
    for (const file of srcFiles()) {
      const rel = file.slice(SRC_DIR.length)
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('./') || spec.startsWith('../')) continue // 本包内部
        if (ALLOWED_BARE.has(spec)) continue
        // node: 内置也不该出现（纯代数不碰 fs/process），但真正承重的是下面的 FORBIDDEN 名单。
        if (spec === '@agentmux/core' || spec.startsWith('@agentmux/core/')) {
          // 只放行明确 node-free 的子路径。
          if (ALLOWED_BARE.has(spec)) continue
          offenders.push(`${rel}: ${spec}`)
          continue
        }
        if (FORBIDDEN.includes(spec) || FORBIDDEN.some((f) => spec === f || spec.startsWith(`${f}/`))) {
          offenders.push(`${rel}: ${spec}`)
          continue
        }
        // 其余任何裸包（renderer 路径已被相对判据放过、这里剩下的都是外部包）一律报出来——
        // 纯代数今天不需要任何第三方运行时。
        offenders.push(`${rel}: ${spec}`)
      }
    }
    expect(
      offenders,
      '这些 import 违反「无 UI/Agent 依赖」：packages/layout/src 只允许本包内部相对 import 与 node-free 的 ' +
        '@agentmux/core/workbench-layout-preset。任何 react/electron/zustand/渲染层路径、或 @agentmux/core 的 ' +
        'barrel，都会把 UI/Agent 运行时拖进这个『纯』包，使验收条款「无 UI/Agent 依赖」失真。'
    ).toEqual([])
  })

  it('自证：扫描确实读到了 src 文件，且判据认得出被禁的说明符（判据不是恒真）', () => {
    const files = srcFiles()
    expect(files.length, '扫不到 packages/layout/src 下的源文件——扫描根写错，判据会恒绿').toBeGreaterThan(3)
    // 判据在场证明：合成一段含 react import 的源码，importSpecifiers 必须认出它。
    const specs = importSpecifiers(`import x from 'react'\nimport { y } from './z'`)
    expect(specs).toContain('react')
    expect(specs).toContain('./z')
  })

  it('自证：允许的 SSOT 子路径确实被某个 src 文件消费（否则放行条目是死的）', () => {
    const consumed = srcFiles().some((file) =>
      importSpecifiers(readFileSync(file, 'utf8')).includes('@agentmux/core/workbench-layout-preset')
    )
    expect(
      consumed,
      'workbench-layout-preset 子路径没有任何 src 文件在用——要么放行条目是死的，要么预设 SSOT 的 import 丢了'
    ).toBe(true)
  })
})
