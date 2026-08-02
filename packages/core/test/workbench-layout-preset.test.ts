import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  WORKBENCH_LAYOUT_PRESETS,
  isWorkbenchLayoutPreset
} from '../src/workbench-layout-preset.js'

// ---------------------------------------------------------------------------
// 布局预设名的 SSOT（#516）。
//
// 这份清单此前有四处独立拼写：Core 的 control.ts 一份字面量 union、Renderer 的
// workbench-view-layout.ts 一份字面量 union，以及 control-host.ts / agentmux.ts 两处喂给
// `.includes(...)` 的内联字符串数组。tsc 看不见任何一处漂移——两份 union 是独立的字面量集合，
// 而喂给 .includes 的 `string[]` 对编译器只是 `string[]`。收敛后：元组是 SSOT，
// WorkbenchLayoutPreset 类型由 workbench-layout-preset.ts 里的双向 exactness 证明与它锁定
// （那道证明是**编译期**守卫，任一方向漂移都是编译错误，不在这里重测），成员判定由
// isWorkbenchLayoutPreset 从元组派生。
//
// 这个测试文件只钉**类型系统表达不了**的两件事：
//   1. isWorkbenchLayoutPreset 的**运行时答案**——`return true` / 截断元组 / 取反都能通过编译。
//   2. 那份清单不再有第二处**运行时**拼写——没有人把内联 `.includes([...])` 数组抄回去。
// 双向类型证明与 Renderer 侧的类型别名都是编译器背着的，不在这里重测（重测反而会把编译期保证
// 降级成一条更弱的文本断言）。
// ---------------------------------------------------------------------------
describe('workbench layout preset SSOT', () => {
  it('元组就是那四档预设，一个不多一个不少', () => {
    // 锚点写死历史字面量：不从 WORKBENCH_LAYOUT_PRESETS 反算期望值，否则期望值会跟着元组一起漂、
    // 恒相等（记忆 expected-value-must-not-derive-from-mutation-target）。加/删一档要在这里显式改。
    expect([...WORKBENCH_LAYOUT_PRESETS]).toEqual(['columns-3', 'grid-4', 'grid-6', 'grid-9'])
  })

  it('每一档元组成员都被判为合法', () => {
    // 逐一断言，而不是「数量对就行」：`return false` 会让这一条整体发红，
    // 而截断成只认前两档会让漏掉的那档发红。
    for (const preset of WORKBENCH_LAYOUT_PRESETS) {
      expect(isWorkbenchLayoutPreset(preset), `${preset} 该合法却被判非法`).toBe(true)
    }
  })

  it('近似但不在清单里的名字被判非法——挡住 `return true`', () => {
    // 这些正是最容易被误当合法的近邻（少一位数、多一位、换个前缀、空串）。任一条被判合法，
    // 说明谓词退化成了恒真，或元组混进了不该有的档。
    for (const notPreset of ['grid-2', 'grid-3', 'grid-8', 'grid-99', 'columns', 'columns-2', 'row-3', '', 'GRID-4', 'grid-4 ']) {
      expect(isWorkbenchLayoutPreset(notPreset), `${notPreset} 该非法却被判合法`).toBe(false)
    }
  })

  // -------------------------------------------------------------------------
  // 运行时成员判定只有一处拼写：谓词。
  //
  // 判据落在「这两个文件里不再出现内联的预设名字面量」上——那正是 Step 2 复现过的盲点：从
  // control-host.ts 的 `['columns-3','grid-4','grid-6','grid-9'].includes(...)` 删掉 'grid-9'，
  // core tsc 退 0、30 条测试全绿，而 `arrange --preset grid-9` 被静默判非法。谓词把那份清单收进
  // 元组一处，这条守卫钉住没有人把它抄回来。
  // -------------------------------------------------------------------------
  const CONSUMERS = ['control-host.ts', 'agentmux.ts'] as const

  it('前提自检：这两个消费者确实都调用了谓词', () => {
    // 没有这条，下面「文件里没有预设名字面量」会在文件根本没接谓词时也绿——那时清单是别处抄的，
    // 守卫却报平安。先证消费者真的在用 SSOT，再证它没同时留一份手抄。
    for (const file of CONSUMERS) {
      const text = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
      expect(text, `${file} 没有调用 isWorkbenchLayoutPreset——它的成员判定来自别处`).toContain(
        'isWorkbenchLayoutPreset('
      )
    }
  })

  it('这两个消费者里没有内联的预设名字面量——清单只在元组里', () => {
    // 自检：这个正则真能认出 Step 2 复现的那种内联数组。没有它，把正则写坏会让守卫恒绿
    //（记忆 grep 守卫看不见早退 / false-green-gate-patterns）。
    const PRESET_LITERAL = /'(?:columns-3|grid-4|grid-6|grid-9)'/
    expect(
      PRESET_LITERAL.test(`['columns-3', 'grid-4', 'grid-6', 'grid-9'].includes(x)`),
      '判据认不出它要防的那种内联数组，正则是坏的'
    ).toBe(true)
    for (const file of CONSUMERS) {
      const text = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
      expect(
        PRESET_LITERAL.test(text),
        `${file} 里又出现了内联的预设名字面量——第二处运行时拼写必与元组漂移`
      ).toBe(false)
    }
  })
})
