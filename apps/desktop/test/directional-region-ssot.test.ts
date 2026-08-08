import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
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

// ---------------------------------------------------------------------------
// 方向两半真相的**独占性**守卫：`orientationOf`（哪根轴）与 `placementOf`（哪一侧）是渲染层里
// 唯一能把一个 `SplitDirection` 拆成含义的地方。上面那组守的是「消费者从这里 import」，这一组守的是
// 「除这里以外没有第二份手抄」——两件事不同：import 在场不妨碍同一个文件里另写一份 `direction === 'right'`。
//
// 判据必须是**被比较那一侧的类型**，不是拼法。理由是拼法判据同时会漏又会误伤：
//   - 漏：`switch (direction)`、`['left','right'].includes(direction)`、`d !== 'up'` 都绕开
//     任何一条 `not.toContain("=== 'left'")`；
//   - 误伤：`workbench-tab-actions.ts` 的 `scope === 'left'` 逐字同形，但 `scope` 是 `TabCloseScope`
//     （`'others' | 'left' | 'right'`，「关左边的 tab」的关闭范围），跟方向毫无关系。拼法判据只能靠
//     豁免清单放行它，而豁免清单本身就是盲区（本仓 forbidden-list-guard-always-leaks）。
//
// 用类型检查器问「这个操作数的类型是不是恰好那四个方向字面量」，`scope === 'left'` 自动落在判据之外，
// 不需要任何豁免条目。先例是 `workbench-surface-kind-exhaustiveness.test.ts`：那里同样要把
// `surface.kind` 与逐字同形的 `session.kind` 分开，用的也是 checker 而不是正则。
//
// 建 program 的代价实测约 2s（与上述先例同量级），换来的是这条守卫不会因为换个拼法而失效。
// ---------------------------------------------------------------------------
const RENDERER_DIR = fileURLToPath(new URL('../src/renderer/src/', import.meta.url))
const DESKTOP_DIR = fileURLToPath(new URL('../', import.meta.url))
const DIRECTION_MEMBERS = ['left', 'right', 'up', 'down'] as const

/** 方向的两半真相所在——只有这个文件可以把 direction 拆成轴与侧。 */
const DIRECTION_SSOT = 'lib/split-direction.ts'

function rendererSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...rendererSourceFiles(full))
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

type DirectionComparison = { file: string; line: number; text: string }

/**
 * 渲染层里所有「拿一个方向类型的值与某个方向字面量比较」的位置。
 *
 * 覆盖两种写法：等值比较（`===`/`!==`/`==`/`!=`，字面量在左或在右都算）与 `switch` 的 case 子句。
 * 每一处都要求非字面量那一侧的类型**每个成员都是那四个方向字面量之一**——这既排除了 `TabCloseScope`
 * 这类同形但不同义的 union，也排除了 `string`（宽到什么都能比，不构成对方向的拆解）。
 */
function findDirectionComparisons(): { hits: DirectionComparison[]; scannedFiles: number; members: string[] } {
  const roots = rendererSourceFiles(RENDERER_DIR)
  const configFile = ts.readConfigFile(path.join(DESKTOP_DIR, 'tsconfig.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, DESKTOP_DIR)
  const program = ts.createProgram(roots, parsed.options)
  const checker = program.getTypeChecker()

  // 锚点从 SplitDirection 的声明处取，不在测试里重列那四个词——否则这里就成了第 N 份手抄。
  const declaration = program.getSourceFile(path.join(RENDERER_DIR, 'lib/workbench-layout.ts'))
  let unionType: ts.Type | undefined
  ts.forEachChild(declaration!, (node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'SplitDirection') {
      unionType = checker.getTypeAtLocation(node.name)
    }
  })
  const members = (unionType?.isUnion() ? unionType.types : [])
    .map((part) => (part.isStringLiteral() ? part.value : ''))
    .filter(Boolean)
    .sort()

  const isDirectionTyped = (node: ts.Node): boolean => {
    const type = checker.getTypeAtLocation(node)
    const parts = type.isUnion() ? type.types : [type]
    if (parts.length === 0) return false
    return parts.every((part) => part.isStringLiteral() && members.includes(part.value))
  }

  const scanned = program
    .getSourceFiles()
    .filter((file) => !file.isDeclarationFile && file.fileName.startsWith(RENDERER_DIR))
  const hits: DirectionComparison[] = []
  const EQUALITY = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken
  ])
  for (const file of scanned) {
    const record = (node: ts.Node): void => {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart())
      hits.push({
        file: path.relative(RENDERER_DIR, file.fileName),
        line: line + 1,
        text: node.getText().slice(0, 80)
      })
    }
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
        for (const [literal, other] of [
          [node.right, node.left],
          [node.left, node.right]
        ] as const) {
          if (ts.isStringLiteral(literal) && members.includes(literal.text) && isDirectionTyped(other)) {
            record(node)
            break
          }
        }
      }
      if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && members.includes(node.expression.text)) {
        const owner = node.parent?.parent
        if (owner && ts.isSwitchStatement(owner) && isDirectionTyped(owner.expression)) record(node)
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return { hits, scannedFiles: scanned.length, members }
}

describe('方向的两半含义只在 split-direction 里拆一次', () => {
  const { hits, scannedFiles, members } = findDirectionComparisons()

  it('自证：锚点解析出的确实是那四个方向（解析失败时判据会恒真）', () => {
    // 若 SplitDirection 解析不到（文件改名、alias 变 interface），members 为空，isDirectionTyped 恒假，
    // 下面那条「没有第二处」会毫无意义地全绿。先把锚点本身钉住。
    expect(members).toEqual([...DIRECTION_MEMBERS].sort())
  })

  it('自证：扫描确实覆盖到渲染层的一批文件（扫空目录时判据会恒真）', () => {
    expect(scannedFiles).toBeGreaterThan(50)
  })

  it('自证：判据在 SSOT 自己身上认得出方向拆解（判据不是恒假）', () => {
    // `orientationOf` 与 `placementOf` 各含两处方向比较，`edgeGap` 的 switch 含四条 case。
    // 这条同时证明「类型判据能认出方向操作数」——它若退化成恒假，上面那条独占性检查会恒绿。
    const inSsot = hits.filter((hit) => hit.file === DIRECTION_SSOT)
    expect(inSsot.length).toBeGreaterThanOrEqual(6)
  })

  it('除 SSOT 外，渲染层没有第二处把方向拆成轴或侧', () => {
    // 任何消费者要知道「哪根轴」或「哪一侧」，只能调 orientationOf / placementOf。此前这条被违反过
    // 五次（region 树建树、tab-group 树建树、邻居查找、寻址侧轴判、寻址侧侧判），五处今天都对纯属它们
    // 同期写成；改一处而别处不跟上，同一个「向左」会在两棵树上给出相反的落点，而两边各自的测试全绿。
    const offenders = hits.filter((hit) => hit.file !== DIRECTION_SSOT)
    expect(offenders).toEqual([])
  })

  it('自证：类型判据不会把同形但不同义的 union 算成方向（豁免清单会有的误伤）', () => {
    // `workbench-tab-actions.ts` 的 `scope === 'left'` 与方向逐字同形，但 scope 是 TabCloseScope
    // （关闭范围，`'others' | 'left' | 'right'`）。拼法判据必须给它一条豁免；类型判据天然排除。
    // 这条把那个前提钉住：那处比较真的还在（否则这条自证就成了对不存在代码的空话），且没被算成 offender。
    const tabActions = readFileSync(path.join(RENDERER_DIR, 'lib/workbench-tab-actions.ts'), 'utf8')
    expect(tabActions).toContain("scope === 'left'")
    expect(hits.some((hit) => hit.file === 'lib/workbench-tab-actions.ts')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 跨包方向证明的**出处**：两半必须来自两个不同的包，否则证明是恒真的死代码
//
// `directional-addressing.ts` 里那道 `_addressDirectionMatchesControlProtocol` 用双向 `extends` 把渲染
// 层的 `SplitDirection` 与控制协议 `AgentMuxOpenDestination` 的 direction 锁在一起。它的承重前提是
// **两个操作数分别取自两个包**：一侧解析到本包的类型声明，另一侧解析到 `@agentmux/core` 的控制契约。
//
// 前提破掉时证明不会报错，只会静默变成 `X extends X ? true : never` 这个恒真式。实测（本轮变异 D3）：
// 把 `ControlSplitDirection` 的定义从 `Extract<AgentMuxOpenDestination, { kind: 'split' }>['direction']`
// 改成 `SplitDirection`，`tsc --noEmit -p tsconfig.json` **exit 0**，`directional-region-ssot` 与
// `directional-addressing` 两个 suite **43 条全绿**——那道证明当场成了永不失败的装饰，而任一侧加删一个
// 方向都不再有人报错。同族：[承诺的判据比断言强] 与「期望值不能由被测对象算出」。
//
// 所以这里判的不是「证明在场」（那正是 D3 满足的），而是每一半的 `extends` 两侧**定义来自哪个包**。
//
// 关键是别把问题问成「这个名字在哪个文件里声明」：两个操作数今天都是本包里的**局部别名**
// （`ControlSplitDirection` 就写在被测文件里，`SplitDirection` 从 `./workbench-layout` 导入），
// 按声明位置判会把干净的代码也读成 renderer↔renderer——这个错判据我先写过一遍，干净树上就报了红。
// 要顺着别名链一路追到定义的**出处**：别名还在本包内就展开它的定义继续追，一旦落到本包之外就按
// 那个文件归包。于是 `Extract<AgentMuxOpenDestination, …>['direction']` 追到 `@agentmux/core`（无论
// 它经 node_modules 链还是 packages/core 解析），而 `= SplitDirection` 追到本包，D3 当场红。
// 换等价写法（把 `AgentMuxOpenDestination['direction']` 直接写进元组之类）照旧通过。
// ---------------------------------------------------------------------------
const ADDRESSING_FILE = path.join(RENDERER_DIR, 'lib/directional-addressing.ts')
const CROSS_PACKAGE_PROOF = '_addressDirectionMatchesControlProtocol'

type OriginPackage = 'renderer' | 'core' | 'unresolved'

/** 这个声明文件属于哪一侧。`lib` 是 TS 自带声明（`Extract` 之类），不参与归包。 */
function packageOfFile(file: string): OriginPackage | 'lib' {
  if (/[\\/]node_modules[\\/]typescript[\\/]/.test(file)) return 'lib'
  if (/[\\/]packages[\\/]core[\\/]|[\\/]@agentmux[\\/]core[\\/]/.test(file)) return 'core'
  if (file.startsWith(RENDERER_DIR)) return 'renderer'
  return 'unresolved'
}

/** 类型位置上真正引用了别的类型的地方——属性名、字面量都不算，否则 `{ kind: 'split' }` 会污染出处。 */
function typeReferencesIn(node: ts.TypeNode): ts.EntityName[] {
  const found: ts.EntityName[] = []
  const walk = (child: ts.Node): void => {
    if (ts.isTypeReferenceNode(child)) found.push(child.typeName)
    else if (ts.isTypeQueryNode(child)) found.push(child.exprName)
    ts.forEachChild(child, walk)
  }
  walk(node)
  return found
}

function leftmostIdentifier(entity: ts.EntityName): ts.Identifier {
  let current = entity
  while (ts.isQualifiedName(current)) current = current.left
  return current
}

/**
 * 这个类型节点的定义**出处**集合。别名仍在本包内就展开继续追（这才是 D3 那次变异的判别点），
 * 落到包外就按文件归包。解析不出来记 `unresolved`，绝不当成通过。
 */
function originsOfTypeNode(checker: ts.TypeChecker, node: ts.TypeNode, seen: Set<ts.Node>): Set<OriginPackage> {
  const origins = new Set<OriginPackage>()
  for (const entity of typeReferencesIn(node)) {
    let symbol = checker.getSymbolAtLocation(leftmostIdentifier(entity))
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      symbol = checker.getAliasedSymbol(symbol)
    }
    const declaration = symbol?.declarations?.[0]
    if (declaration === undefined) {
      origins.add('unresolved')
      continue
    }
    const pkg = packageOfFile(declaration.getSourceFile().fileName)
    if (pkg === 'lib') continue
    if (pkg !== 'renderer') {
      origins.add(pkg)
      continue
    }
    if (ts.isTypeAliasDeclaration(declaration) && !seen.has(declaration)) {
      seen.add(declaration)
      const nested = originsOfTypeNode(checker, declaration.type, seen)
      if (nested.size > 0) {
        for (const value of nested) origins.add(value)
        continue
      }
    }
    origins.add('renderer')
  }
  return origins
}

/** 出处集合收成一个词。刻意严格：混了两个包也要说出来，而不是挑一个当答案。 */
function sideLabel(origins: Set<OriginPackage>): string {
  if (origins.size === 1) return [...origins][0]
  if (origins.size === 0) return 'none'
  return `mixed(${[...origins].sort().join(',')})`
}

type ProofProbe = {
  readonly found: boolean
  readonly halves: string[]
  /** 自证用：本文件里两个真实类型引用各自的出处，证明这个判据不是常量。 */
  readonly coreWitness: string
  readonly rendererWitness: string
}

function crossPackageProofProbe(): ProofProbe {
  const configFile = ts.readConfigFile(path.join(DESKTOP_DIR, 'tsconfig.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, DESKTOP_DIR)
  const program = ts.createProgram([ADDRESSING_FILE], parsed.options)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(ADDRESSING_FILE)
  if (file === undefined) return { found: false, halves: [], coreWitness: 'none', rendererWitness: 'none' }

  const halves: string[] = []
  let found = false
  const side = (node: ts.TypeNode): string => sideLabel(originsOfTypeNode(checker, node, new Set()))

  ts.forEachChild(file, (node) => {
    if (!ts.isVariableStatement(node)) return
    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== CROSS_PACKAGE_PROOF) continue
      found = true
      const annotation = declaration.type
      if (annotation === undefined || !ts.isTupleTypeNode(annotation)) return
      for (const element of annotation.elements) {
        if (!ts.isConditionalTypeNode(element)) continue
        halves.push(`${side(element.checkType)}->${side(element.extendsType)}`)
      }
    }
  })

  // 见证节点取本文件里两个真实用到的类型：一个来自 core，一个来自本包。它们不是为测试造的探针，
  // 所以「判据能分开两个包」这件事是在生产代码上证的。
  const witnessOf = (name: string): string => {
    let label = 'none'
    const walk = (child: ts.Node): void => {
      if (label !== 'none') return
      if (ts.isTypeReferenceNode(child) && leftmostIdentifier(child.typeName).text === name) label = side(child)
      else ts.forEachChild(child, walk)
    }
    ts.forEachChild(file, walk)
    return label
  }
  return { found, halves, coreWitness: witnessOf('AgentMuxRegionNeighbor'), rendererWitness: witnessOf('WorkbenchRegionBounds') }
}

describe('方向的跨包证明必须真的跨包（否则它是恒真的死代码）', () => {
  const probe = crossPackageProofProbe()

  it('自证：那道证明还在，且它的注解是由两半组成的元组（改名或换形状时先在这里红）', () => {
    // found 为假说明证明被删或改名；长度不为 2 说明它不再是「两个包含方向各一半」的形状。
    // 缺了这条，下面那条按出处判的断言会对空数组恒绿。
    expect(probe.found).toBe(true)
    expect(probe.halves).toHaveLength(2)
  })

  it('自证：出处判据在本文件的两个真实类型引用上给出不同的包（判据不是常量）', () => {
    // `AgentMuxRegionNeighbor` 来自 @agentmux/core/control，`WorkbenchRegionBounds` 来自本包的
    // workbench-view-layout。若判据坏成恒 'core' 或恒 'renderer'（或恒 unresolved），这里先红。
    expect(probe.coreWitness).toBe('core')
    expect(probe.rendererWitness).toBe('renderer')
  })

  it('两半各自的 extends 两侧分居 renderer 与 core，方向相反', () => {
    // 这就是 D3 被挡住的地方：把 ControlSplitDirection 的定义改成 `= SplitDirection` 后，追出处得到
    // 的是本包，两半都变成 renderer->renderer，于是这条红——而 tsc 对那次变异是 exit 0 的。
    expect([...probe.halves].sort()).toEqual(['core->renderer', 'renderer->core'])
  })
})
