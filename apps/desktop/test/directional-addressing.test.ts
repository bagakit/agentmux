import { describe, expect, it } from 'vitest'
import {
  directionalNeighbor,
  regionNeighbor,
  tabNeighbor,
  type DirectionalNeighborInput
} from '../src/renderer/src/lib/directional-addressing.js'

// 用户原话：「当描述"右边"、"左边"的时候，除了识别 region，也可以去识别 tab」「如果要创建一个
// "左边、右边、上面、下面"，那应该就是 split」「但如果让他去查看的时候，如果没有 split，
// tab 应该也要能识别」。这里测的是"查看"那一侧——创建一侧仍然只产生 split，不归本模块管。

const bounds = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

/** 左右两栏。 */
function twoColumns(tabId = 'tab-1', tabOrder = ['tab-1']): DirectionalNeighborInput {
  return {
    regionId: 'left',
    tabId,
    tabOrder,
    regions: [
      { regionId: 'left', bounds: bounds(0, 0, 0.5, 1) },
      { regionId: 'right', bounds: bounds(0.5, 0, 0.5, 1) }
    ]
  }
}

/** 只有一格，没有任何分栏——这正是"退到 Tab"该发生的场景。 */
function single(regionId = 'only', tabId = 'tab-2', tabOrder = ['tab-1', 'tab-2', 'tab-3']): DirectionalNeighborInput {
  return {
    regionId,
    tabId,
    tabOrder,
    regions: [{ regionId, bounds: bounds(0, 0, 1, 1) }]
  }
}

describe('同一 View 内的方向', () => {
  it('分了栏就答那一格', () => {
    expect(regionNeighbor(twoColumns(), 'right')).toBe('right')
  })

  it('到边了如实说没有，而不是绕回去', () => {
    // 最左一格问 left 是合法问题的合法答案，不是失败。绕回最右会让 Agent 以为布局是环形的。
    expect(regionNeighbor(twoColumns(), 'left')).toBeNull()
  })

  it('只在一根轴上错开的格子不算"右边"', () => {
    // 右上角那一格 x 更大，但视线从左下平移过去撞不到它。只判"x 更大"会把它错答成右边。
    const input: DirectionalNeighborInput = {
      regionId: 'bottom-left',
      tabId: 'tab-1',
      tabOrder: ['tab-1'],
      regions: [
        { regionId: 'bottom-left', bounds: bounds(0, 0.5, 0.5, 0.5) },
        { regionId: 'top-right', bounds: bounds(0.5, 0, 0.5, 0.5) }
      ]
    }
    expect(regionNeighbor(input, 'right')).toBeNull()
  })

  it('多个候选时取最近的那一格，而不是数组里排在前面的那一格', () => {
    // regions 的顺序是**故意打乱**的：远的 c 排在近的 b 前面。布局树展平出来的顺序本就与屏幕
    // 上的远近无关，若照数组顺序取第一个，"右边"会答成隔壁的隔壁。按顺序摆放的 fixture 测不
    // 出这件事——去掉排序它照样绿。
    const input: DirectionalNeighborInput = {
      regionId: 'a',
      tabId: 'tab-1',
      tabOrder: ['tab-1'],
      regions: [
        { regionId: 'a', bounds: bounds(0, 0, 0.34, 1) },
        { regionId: 'c', bounds: bounds(0.67, 0, 0.33, 1) },
        { regionId: 'b', bounds: bounds(0.34, 0, 0.33, 1) }
      ]
    }
    expect(regionNeighbor(input, 'right')).toBe('b')
  })

  it('上下方向在 Region 之间是成立的——它只对 Tab 不成立', () => {
    const input: DirectionalNeighborInput = {
      regionId: 'top',
      tabId: 'tab-1',
      tabOrder: ['tab-1'],
      regions: [
        { regionId: 'top', bounds: bounds(0, 0, 1, 0.5) },
        { regionId: 'bottom', bounds: bounds(0, 0.5, 1, 0.5) }
      ]
    }
    expect(regionNeighbor(input, 'down')).toBe('bottom')
    expect(regionNeighbor(input, 'up')).toBeNull()
  })

  it('浮点尾数不该让对齐的两格判成不相邻', () => {
    // bounds 由 ratio 连乘得出，两条累加路径算同一条边会差出尾数：origin 的右边缘落在
    // 0.1+0.2 = 0.30000000000000004，而邻格的左边缘是干净的 0.3——**比它小**。零容差下
    // 「邻格在我右边」这一判定就不成立，明明贴着的两格会答成"没有右边"。
    // 反过来写（邻格的边缘更大）测不出这件事：零容差时 >= 照样成立，容差删掉也不会红。
    expect(0.1 + 0.2).toBeGreaterThan(0.3)
    const input: DirectionalNeighborInput = {
      regionId: 'a',
      tabId: 'tab-1',
      tabOrder: ['tab-1'],
      regions: [
        { regionId: 'a', bounds: bounds(0, 0, 0.1 + 0.2, 1) },
        { regionId: 'b', bounds: bounds(0.3, 0, 0.7, 1) }
      ]
    }
    expect(regionNeighbor(input, 'right')).toBe('b')
  })
})

describe('Tab 条上的方向', () => {
  it('左右落在相邻的 Tab 上', () => {
    expect(tabNeighbor(single(), 'right')).toBe('tab-3')
    expect(tabNeighbor(single(), 'left')).toBe('tab-1')
  })

  it('上下对 Tab 不成立，绝不折成 prev/next', () => {
    // 本 task 最容易被悄悄做错的一条：把 up 当 prev，Agent 会以为拿到了上方的东西，
    // 实际拿到的是左边那张，而且它无从发现自己被骗。
    expect(tabNeighbor(single(), 'up')).toBeNull()
    expect(tabNeighbor(single(), 'down')).toBeNull()
  })

  it('最后一张 Tab 问 right 是没有，不是绕回第一张', () => {
    expect(tabNeighbor(single('only', 'tab-3'), 'right')).toBeNull()
    expect(tabNeighbor(single('only', 'tab-1'), 'left')).toBeNull()
  })
})

describe('先 Region 后 Tab——优先级由"屏幕上更近"决定', () => {
  it('有分栏时答 Region，哪怕 Tab 条右边也有 Tab', () => {
    // 这是优先级的判据本身：两边都有答案时必须选 Region。反过来会让一个分了栏的 View
    // 把用户指向另一张 Tab，与他所见不符。
    const input = twoColumns('tab-2', ['tab-1', 'tab-2', 'tab-3'])
    expect(directionalNeighbor(input, 'right')).toEqual({ kind: 'region', regionId: 'right' })
  })

  it('没有分栏时退到 Tab——这正是用户要补的那件事', () => {
    expect(directionalNeighbor(single(), 'right')).toEqual({ kind: 'tab', tabId: 'tab-3' })
  })

  it('分了栏但该方向没有兄弟 Region 时，同样退到 Tab', () => {
    // 分栏与退让不是互斥的：左边那一格的左侧没有 Region，但 Tab 条上仍可能有。
    const input = twoColumns('tab-2', ['tab-1', 'tab-2', 'tab-3'])
    expect(directionalNeighbor(input, 'left')).toEqual({ kind: 'tab', tabId: 'tab-1' })
  })

  it('两边都没有就是没有，不抛异常', () => {
    // 到边是合法问题的合法答案。抛异常会让 Agent 以为自己问错了，而它只是到边了。
    expect(directionalNeighbor(single('only', 'tab-1', ['tab-1']), 'right')).toEqual({ kind: 'none' })
    expect(directionalNeighbor(single(), 'up')).toEqual({ kind: 'none' })
  })

  it('答案只会是既有的 Region 或 Tab 地址，不发明第四级身份', () => {
    const answers = (['left', 'right', 'up', 'down'] as const).map((direction) =>
      directionalNeighbor(twoColumns('tab-2', ['tab-1', 'tab-2']), direction).kind
    )
    expect(new Set(answers).size).toBeGreaterThan(0)
    for (const kind of answers) expect(['region', 'tab', 'none']).toContain(kind)
  })

  it('出发点不在自己的 regions 里时不猜，直接落到 Tab 判定', () => {
    // 布局刚变、投影还没跟上时会出现这种输入。猜一个 Region 比答不出更糟。
    const input: DirectionalNeighborInput = {
      regionId: 'stale',
      tabId: 'tab-2',
      tabOrder: ['tab-1', 'tab-2', 'tab-3'],
      regions: [{ regionId: 'other', bounds: bounds(0, 0, 1, 1) }]
    }
    expect(directionalNeighbor(input, 'right')).toEqual({ kind: 'tab', tabId: 'tab-3' })
  })
})
