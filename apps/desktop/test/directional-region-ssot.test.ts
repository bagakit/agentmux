import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  regionInDirection,
  orientationOf,
  REGION_GEOMETRY_EPSILON,
  type RegionGeometry
} from '../src/renderer/src/lib/split-direction.js'
import { regionNeighbor, type DirectionalNeighborInput } from '../src/renderer/src/lib/directional-addressing.js'
import { adjacentRegionId } from '../src/renderer/src/lib/workbench-shortcuts.js'
import {
  workbenchRegionBounds,
  type WorkbenchRegionLayoutNode,
  type WorkbenchViewLayout
} from '../src/renderer/src/lib/workbench-view-layout.js'
import type { SplitDirection } from '../src/renderer/src/lib/workbench-layout.js'

// 这个文件守的是一件事：「某方向上是哪一格」在整个渲染层只有**一个**答案。此前有两个——Agent 侧寻址
// （regionNeighbor → inspect）要求另一轴重叠，键盘焦点移动（adjacentRegionId）不要求、改按中心最近——
// 对同一份布局、同一个方向会给出不同的格子。于是 Agent 被告知「右边没有」，用户按右键却聚焦到紧挨着的
// 那格；将来「和右边那格互换」会换到 Agent 认知之外的一格。下面先钉住「两侧对每个方向都答同一格」，再用
// 一条 import 关系守卫钉住「这套几何只定义在一个模块里、两个消费者都从那里取、且各自不再自算几何」。

const DIRECTIONS: readonly SplitDirection[] = ['left', 'right', 'up', 'down']

/**
 * 对角错位的三格布局：C 占右半整列，左半上小下大切成 A(上小)/B(下大)。
 *
 * 关键在 C 问 left：A 与 B 都贴着 C 的左边缘、都与 C 纵向重叠，是并列的相邻候选。两套旧数学在这里
 * **各选一格**——寻址侧按另一轴坐标更小取最上面的 A，键盘侧按中心最近取 B。这是**并列取舍**上的分歧。
 * 布局由真实的分屏树经 workbenchRegionBounds 平铺得出，不手写 bounds，免得 fixture 与产物几何脱节。
 */
const DIAGONAL_TREE: WorkbenchRegionLayoutNode = {
  type: 'split',
  direction: 'horizontal',
  ratio: 0.25,
  first: {
    type: 'split',
    direction: 'vertical',
    ratio: 0.25,
    first: { type: 'leaf', regionId: 'A' },
    second: { type: 'leaf', regionId: 'B' }
  },
  second: { type: 'leaf', regionId: 'C' }
}

const DIAGONAL_REGIONS: ReadonlyArray<RegionGeometry> = workbenchRegionBounds(DIAGONAL_TREE)

/**
 * 重叠判定分歧的五格布局——比并列取舍更本质、且能钉住「重叠判定是承重的」那类分歧。
 * 上排左窄右宽切成 DIAG(左上小格)/ABOVE(右上宽格)，下排从左到右是 LEFT_LOWER / ORIGIN / RIGHT_LOWER。
 * 几何（workbenchRegionBounds 平铺得出，非手写）：
 *   ORIGIN x=[0.20,0.36]，中心 x≈0.28（出发点，下排中间的窄格）
 *   ABOVE  x=[0.20,1.00] y=[0,0.25] ——正压在 ORIGIN 上方、与 ORIGIN 横向**重叠**，但宽、中心 x=0.60 离得远
 *   DIAG   x=[0.00,0.20] y=[0,0.25] ——在 ORIGIN 左上、与 ORIGIN 横向**不重叠**（右缘 0.20 只贴到 ORIGIN
 *          左缘），但窄、中心 x=0.10 离 ORIGIN 中心更近
 *
 * ORIGIN 问 up：ABOVE 与 DIAG 都通过旧键盘的「y 更小」筛（主轴距离都≈0），旧键盘再按中心最近取 DIAG
 * ——一个与 ORIGIN 横向根本不重叠的左上斜格。这既证明 split-direction 注释里那条承重前提**确实成立**
 * （完整平铺下也能构造出「中心更近却不重叠」的格：大而重叠者中心偏、小而斜错者中心近），也让本组的
 * `toBe('ABOVE')` 断言成为对 `crossOverlaps` 这道闸的变异探针——一旦有人把重叠判定当死代码删掉，
 * 本函数就会退回按最小另轴坐标取 DIAG（x=0 最小），断言随即变红。
 */
const OVERLAP_GATE_TREE: WorkbenchRegionLayoutNode = {
  type: 'split',
  direction: 'horizontal',
  ratio: 0.2,
  first: {
    type: 'split',
    direction: 'vertical',
    ratio: 0.25,
    first: { type: 'leaf', regionId: 'DIAG' },
    second: { type: 'leaf', regionId: 'LEFT_LOWER' }
  },
  second: {
    type: 'split',
    direction: 'vertical',
    ratio: 0.25,
    first: { type: 'leaf', regionId: 'ABOVE' },
    second: {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.2,
      first: { type: 'leaf', regionId: 'ORIGIN' },
      second: { type: 'leaf', regionId: 'RIGHT_LOWER' }
    }
  }
}

const OVERLAP_GATE_REGIONS: ReadonlyArray<RegionGeometry> = workbenchRegionBounds(OVERLAP_GATE_TREE)

/** 把布局喂给 Agent 侧寻址的输入形状（tabOrder 留空——这里只问 Region，不问 Tab 退让）。 */
function addressingInput(
  originId: string,
  regions: ReadonlyArray<RegionGeometry> = DIAGONAL_REGIONS
): DirectionalNeighborInput {
  return { regionId: originId, regions, tabId: 'tab', tabOrder: [] }
}

/** 把布局喂给键盘侧的输入形状。 */
function viewLayout(activeRegionId: string, root: WorkbenchRegionLayoutNode = DIAGONAL_TREE): WorkbenchViewLayout {
  return { root, activeRegionId }
}

describe('对角布局：Agent 侧寻址与键盘侧焦点移动必须答同一格', () => {
  it('这份 fixture 确实是分歧现场：C 问 left 有两个并列的重叠候选（否则本测试无意义）', () => {
    // 自检——若哪天 workbenchRegionBounds 改了平铺规则、A/B 不再都贴着 C 左缘并与 C 重叠，这个断言先红，
    // 提醒下面的「两侧一致」不再测的是分歧、而退化成一句恒真。C 左缘在 x=0.25，A、B 的右缘都在 0.25。
    const c = DIAGONAL_REGIONS.find((r) => r.regionId === 'C')!.bounds
    const overlappingLeftCandidates = DIAGONAL_REGIONS.filter((r) => {
      if (r.regionId === 'C') return false
      const gap = c.x - (r.bounds.x + r.bounds.width)
      const crossOverlap = r.bounds.y < c.y + c.height && c.y < r.bounds.y + r.bounds.height
      return Math.abs(gap) <= REGION_GEOMETRY_EPSILON && crossOverlap
    })
    expect(overlappingLeftCandidates.map((r) => r.regionId).sort()).toEqual(['A', 'B'])
  })

  for (const originId of ['A', 'B', 'C']) {
    for (const direction of DIRECTIONS) {
      it(`${originId} 向 ${direction}：两侧同答`, () => {
        const fromAddressing = regionNeighbor(addressingInput(originId), direction)
        const fromKeyboard = adjacentRegionId(viewLayout(originId), direction)
        expect(fromKeyboard).toBe(fromAddressing)
      })
    }
  }

  it('C 问 left 是真正会分家的那格：收拢后两侧都答 A（不是各答各的）', () => {
    // 锚住具体值，而不只是「相等」——若两侧退化成都返回 null，上面的循环仍绿，但那不是修复。
    // 收拢后统一采用寻址侧原本的规则（重叠 + 并列取另一轴坐标更小者），C 的左侧 A、B 并列贴边，
    // 取坐标更小（更靠上）的 A。旧键盘实现在这里会答 B（中心最近），故这条同时钉住「键盘改成了 A」。
    const fromAddressing = regionNeighbor(addressingInput('C'), 'left')
    const fromKeyboard = adjacentRegionId(viewLayout('C'), 'left')
    expect(fromAddressing).toBe('A')
    expect(fromKeyboard).toBe('A')
  })
})

describe('重叠判定分歧：完整平铺下也存在「中心更近却不重叠」的格', () => {
  // 这一组钉住 split-direction 注释里那条承重前提**确实成立**：旧键盘「y 更小/x 更大 + 中心最近、不设
  // 重叠判定」会在完整平铺（workbenchRegionBounds 永远铺满单位面）下选中一个与出发点另一轴不重叠的斜
  // 错开格。若无此 fixture，注释声称的「实测存在斜错开、不重叠却被中心最近选中的布局」就无从查证，下一个
  // 人会把 crossOverlaps 当死代码删掉而测试全绿。这份 fixture 同时是那道闸的变异探针——见下条断言注释。

  it('自检：ORIGIN 问 up 的两个候选一个重叠、一个不重叠，且不重叠者中心更近（否则本组无意义）', () => {
    // 不经 SSOT，用原始几何独立算一遍，钉死这份 fixture 的判别性质：ABOVE 与 ORIGIN 横向重叠、DIAG 不
    // 重叠，而 DIAG 的中心离 ORIGIN 更近——正是这个「近但不重叠」让旧键盘选错。任一性质被平铺规则改动
    // 破坏，这条先红。
    const g = (id: string) => OVERLAP_GATE_REGIONS.find((r) => r.regionId === id)!.bounds
    const origin = g('ORIGIN')
    const above = g('ABOVE')
    const diag = g('DIAG')
    const overlapsX = (b: { x: number; width: number }): boolean =>
      b.x < origin.x + origin.width - REGION_GEOMETRY_EPSILON && origin.x < b.x + b.width - REGION_GEOMETRY_EPSILON
    const centerXGap = (b: { x: number; width: number }): number =>
      Math.abs(b.x + b.width / 2 - (origin.x + origin.width / 2))
    // 两者都在 ORIGIN 上方且主轴距离≈0（同一条下缘 y=0.25 贴着 ORIGIN 上缘）。
    expect(above.y + above.height).toBeCloseTo(origin.y, 9)
    expect(diag.y + diag.height).toBeCloseTo(origin.y, 9)
    expect(overlapsX(above)).toBe(true)
    expect(overlapsX(diag)).toBe(false)
    // 关键：不重叠的那个中心反而更近——这才是「中心最近会自然排除斜对角」为假的原因。
    expect(centerXGap(diag)).toBeLessThan(centerXGap(above))
  })

  it('ORIGIN 问 up：两侧都答 ABOVE（真正在上方、重叠的那格），不是中心更近的斜格 DIAG', () => {
    // 旧键盘在这里会答 DIAG（不重叠、中心近）。收拢到带重叠判定的 SSOT 后 DIAG 被挡掉，选真正在上方的
    // ABOVE。这条同时是 `crossOverlaps` 的变异探针：删掉那道闸后，本函数会退回按最小另轴坐标（x）取值，
    // DIAG 的 x=0 最小于是被选中，`toBe('ABOVE')` 立即变红——所以这道闸不是能被当死代码删掉的摆设。
    // 两侧都答 ABOVE 亦证明键盘侧确实改用了这套带闸的判定。
    const fromAddressing = regionNeighbor(addressingInput('ORIGIN', OVERLAP_GATE_REGIONS), 'up')
    const fromKeyboard = adjacentRegionId(viewLayout('ORIGIN', OVERLAP_GATE_TREE), 'up')
    expect(fromAddressing).toBe('ABOVE')
    expect(fromKeyboard).toBe('ABOVE')
  })
})

// ---------------------------------------------------------------------------
// import 关系 + 「消费者不自算几何」守卫：方向几何只能定义在 split-direction 一个模块里。
// 判据不是「某几个旧函数名不在场」（换个拼法就绕过、还会误伤），而是两条结构性质：
//   1) 消费 Region 几何的每个 lib 文件都从 './split-direction' import 方向判定；
//   2) 消费 Region 几何的文件里**只有 split-direction 自己**含 bounds 字段算术
//      （`.width`/`.height`/`.x +`/`.y +`/EPSILON/1e-）——任何消费者重新自算几何都会被这条抓住，
//      无论它把函数叫什么名字。
// 「消费 Region 几何的文件」由目录扫描发现（import 了 workbench-view-layout 或 split-direction），
// 不写死清单：明天新增第三个消费者若自算几何，一样落网。每条都带自证，防止扫错目录时守卫恒绿。
// ---------------------------------------------------------------------------
const LIB_DIR = new URL('../src/renderer/src/lib/', import.meta.url)

function readLib(relative: string): string {
  return readFileSync(new URL(relative, LIB_DIR), 'utf8')
}

/** lib 目录下所有 .ts 源文件（排除 .d.ts）。 */
function libSourceFiles(): string[] {
  return readdirSync(LIB_DIR).filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
}

/** 该文件是否消费 Region 几何：import 了 workbench-view-layout 的几何或 split-direction 的判定。 */
function consumesRegionGeometry(source: string): boolean {
  return (
    /from\s*['"]\.\/split-direction['"]/.test(source) ||
    /\bworkbenchRegionBounds\b/.test(source) ||
    /\bRegionGeometry\b/.test(source)
  )
}

/** 该文件是否含 Region bounds 字段算术——自算几何的印记（不依赖任何具体函数名）。 */
function hasBoundsArithmetic(source: string): boolean {
  return /\.(width|height)\b|\.x\s*\+|\.y\s*\+|\bEPSILON\b|\b1e-[0-9]/.test(source)
}

describe('几何 SSOT 的 import 关系与消费者不自算几何', () => {
  const addressingSource = readLib('directional-addressing.ts')
  const shortcutsSource = readLib('workbench-shortcuts.ts')
  const ssotSource = readLib('split-direction.ts')

  // 合法拥有 Region bounds 算术的两个文件——不是「消费者」而是几何本身的产地：
  //   - workbench-view-layout.ts：把分屏树平铺成 bounds 的 tiler（`workbenchRegionBounds` 的定义处）。
  //   - split-direction.ts：把「某方向上是哪一格」判成一格的方向判定 SSOT。
  // 别的任何文件出现 bounds 算术即回归。豁免按路径给，并在下面自证每一项都真实存在且确实含该算术，
  // 免得豁免表把不存在的名字或本就没算术的文件白白放行（那样豁免就成了守卫的盲区）。
  const GEOMETRY_OWNERS = ['workbench-view-layout.ts', 'split-direction.ts'] as const

  it('自证：读到的确实是这三个源文件（扫错文件时这里先红）', () => {
    // 每个文件都含一个只属于它自己的锚点标识。扫错路径 / 文件为空时，下面的判据会恒绿，这条先拦住。
    expect(ssotSource).toContain('export function regionInDirection')
    expect(addressingSource).toContain('export function directionalNeighbor')
    expect(shortcutsSource).toContain('export function dispatchWorkbenchCommand')
  })

  it('SSOT 模块导出了那套几何原语', () => {
    expect(ssotSource).toContain('export function regionInDirection')
    expect(ssotSource).toContain('export function orientationOf')
    expect(ssotSource).toContain('export const REGION_GEOMETRY_EPSILON')
    // 运行期再证一次这些名字真的可用（不是被注释掉的空壳）。
    expect(typeof regionInDirection).toBe('function')
    expect(typeof orientationOf).toBe('function')
    expect(typeof REGION_GEOMETRY_EPSILON).toBe('number')
  })

  it('两个消费者都从 ./split-direction import 几何原语', () => {
    // import 关系而非名字字面量：只有真的从那个模块取，才算共用同一份真相。
    const importsSsot = (source: string): boolean =>
      /import\s*\{[^}]*\bregionInDirection\b[^}]*\}\s*from\s*['"]\.\/split-direction['"]/.test(source)
    expect(importsSsot(addressingSource)).toBe(true)
    expect(importsSsot(shortcutsSource)).toBe(true)
  })

  it('自证：这个目录里确实存在会被扫到的消费者（扫空目录时守卫恒绿）', () => {
    const consumers = libSourceFiles().filter((name) => consumesRegionGeometry(readLib(name)))
    // 至少 split-direction 自身之外还有两个消费者（addressing 与 shortcuts），否则下面的检查没扫到东西。
    expect(consumers).toEqual(expect.arrayContaining(['directional-addressing.ts', 'workbench-shortcuts.ts']))
    expect(consumers.length).toBeGreaterThanOrEqual(3)
  })

  it('消费 Region 几何的文件里，只有几何产地（tiler 与方向判定 SSOT）含 bounds 字段算术', () => {
    // 发现式扫描：任何消费者（今天的两个、将来新增的第三个）若在自己文件里重新算 bounds 几何，
    // 就会出现在这份清单里——无论它把那套数学叫什么名字。两个几何产地是应该算几何的，故排除它们。
    const offenders = libSourceFiles().filter((name) => {
      if ((GEOMETRY_OWNERS as readonly string[]).includes(name)) return false
      const source = readLib(name)
      return consumesRegionGeometry(source) && hasBoundsArithmetic(source)
    })
    expect(offenders).toEqual([])
  })

  it('自证：每个豁免的几何产地都真实存在且确实含 bounds 算术（豁免不是盲区）', () => {
    // 豁免表若写了不存在的文件、或写了本就没有几何算术的文件，就等于凭空放行——这条把每一项都质询一遍。
    const libFiles = libSourceFiles()
    for (const owner of GEOMETRY_OWNERS) {
      expect(libFiles).toContain(owner)
      expect(hasBoundsArithmetic(readLib(owner))).toBe(true)
    }
  })

  it('自证：hasBoundsArithmetic 确实认得 split-direction 里的几何算术（判据不是恒 false）', () => {
    // 若这个正则退化成永远返回 false，上一条会恒绿。用 SSOT 自身（确定含 .width/.height 算术）反证它在场。
    expect(hasBoundsArithmetic(ssotSource)).toBe(true)
    // 再证它不会把「没有几何算术」的文本误报（一句纯字符串不该命中）。
    expect(hasBoundsArithmetic('const label = "left"')).toBe(false)
  })
})
