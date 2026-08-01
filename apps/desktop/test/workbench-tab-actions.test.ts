import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  WORKBENCH_TAB_SPLIT_ACTIONS,
  moveSessionViewTargets,
  tabIdsForCloseScope,
  workbenchRegionPresetMenu
} from '../src/renderer/src/lib/workbench-tab-actions'
import { workbenchRegionPresetSize } from '../src/renderer/src/lib/workbench-view-layout'

describe('workbench tab context actions', () => {
  const tabs = ['one', 'two', 'three', 'four']

  it('selects close targets without including the context tab', () => {
    expect(tabIdsForCloseScope(tabs, 'three', 'others')).toEqual(['one', 'two', 'four'])
    expect(tabIdsForCloseScope(tabs, 'three', 'left')).toEqual(['one', 'two'])
    expect(tabIdsForCloseScope(tabs, 'three', 'right')).toEqual(['four'])
  })

  it('fails closed when the context tab is no longer in the pane', () => {
    expect(tabIdsForCloseScope(tabs, 'missing', 'others')).toEqual([])
    expect(tabIdsForCloseScope(tabs, 'missing', 'left')).toEqual([])
    expect(tabIdsForCloseScope(tabs, 'missing', 'right')).toEqual([])
  })

  it('keeps every direct split direction visible in one shared menu vocabulary', () => {
    expect(WORKBENCH_TAB_SPLIT_ACTIONS).toEqual([
      { direction: 'left', label: 'Split Left' },
      { direction: 'right', label: 'Split Right' },
      { direction: 'up', label: 'Split Up' },
      { direction: 'down', label: 'Split Down' }
    ])
  })

  it('offers every other workspace as an explicit move destination, never the current one', () => {
    const workspaces = [
      { id: 'workspace-a', name: 'Main' },
      { id: 'workspace-b', name: 'Feature Worktree' },
      { id: 'workspace-c', name: 'Hotfix Worktree' }
    ]
    // The View currently lives in workspace-a; moving there is a no-op so it is excluded.
    expect(moveSessionViewTargets(workspaces, 'workspace-a')).toEqual([
      { workspaceId: 'workspace-b', name: 'Feature Worktree' },
      { workspaceId: 'workspace-c', name: 'Hotfix Worktree' }
    ])
  })

  it('offers no destinations when the current workspace is the only one', () => {
    expect(moveSessionViewTargets([{ id: 'only', name: 'Only' }], 'only')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 布局预设的菜单模型。
//
// 预设的格数只增不减：arrangeWorkbenchControlTab 对格数已经超过预设的 Tab 抛
// LAYOUT_CAPACITY_EXCEEDED。这里判的是「哪几项列得出来」，而这件事必须只判一次——
// 若菜单照单全列、由动作那侧去撞拒绝，用户点了只会收到一条内部错误串。
// ---------------------------------------------------------------------------
describe('workbenchRegionPresetMenu', () => {
  const arrange = () => {}

  it('单格 Tab 上四个预设全可用', () => {
    expect(workbenchRegionPresetMenu({ regionCount: 1, arrange }).presets).toEqual([
      { preset: 'columns-3', label: '3 Columns' },
      { preset: 'grid-4', label: '2 × 2 Grid' },
      { preset: 'grid-6', label: '2 × 3 Grid' },
      { preset: 'grid-9', label: '3 × 3 Grid' }
    ])
  })

  it('格数已超的预设不列出来——列了点下去只会收到内部错误串', () => {
    // 5 格：columns-3(3) 与 grid-4(4) 都装不下，grid-6(6)/grid-9(9) 可以。
    expect(
      workbenchRegionPresetMenu({ regionCount: 5, arrange }).presets.map((item) => item.preset)
    ).toEqual(['grid-6', 'grid-9'])
  })

  it('恰好等于格数的预设仍然列出来（重排是有意义的操作）', () => {
    // 4 格摆 grid-4 不补格，但会把它排成 2×2——这与「装不下」是两件事，边界不能画错。
    expect(
      workbenchRegionPresetMenu({ regionCount: 4, arrange }).presets.map((item) => item.preset)
    ).toEqual(['grid-4', 'grid-6', 'grid-9'])
  })

  it('九格以上一项都不列，菜单那一节整段消失', () => {
    expect(workbenchRegionPresetMenu({ regionCount: 10, arrange }).presets).toEqual([])
  })

  it('前提自检：判据用的是引擎自己的格数表，不是手抄的数字', () => {
    // 若这里的过滤改成手抄常量（3/4/6/9 各写一遍），引擎那侧改了预设尺寸就会漂移，
    // 而漂移的症状是菜单列出一个必然被拒的项。逐 preset 对齐 workbenchRegionPresetSize：
    // 恰好装满时可用、多一格时不可用。
    for (const preset of ['columns-3', 'grid-4', 'grid-6', 'grid-9'] as const) {
      const size = workbenchRegionPresetSize(preset)
      const atCapacity = workbenchRegionPresetMenu({ regionCount: size, arrange }).presets
      const overCapacity = workbenchRegionPresetMenu({ regionCount: size + 1, arrange }).presets
      expect(atCapacity.map((item) => item.preset), `${preset} 恰好装满时被漏掉了`).toContain(preset)
      expect(overCapacity.map((item) => item.preset), `${preset} 装不下却仍被列出`).not.toContain(preset)
    }
  })

  it('点下去发的就是那一项的 preset，不是别的一项', () => {
    // 与 moveSessionViewMenu 同一道理：清单与动作出自同一个返回值。把 onSelect 接到
    // 一个固定 preset 上（菜单画 4 项、点哪项都摆同一个布局）能过前面每一条，只有这里能抓到。
    const spy = vi.fn()
    const menu = workbenchRegionPresetMenu({ regionCount: 1, arrange: spy })
    for (const item of menu.presets) menu.onSelect(item.preset)
    expect(spy.mock.calls.map(([preset]) => preset)).toEqual([
      'columns-3',
      'grid-4',
      'grid-6',
      'grid-9'
    ])
  })
})

// ---------------------------------------------------------------------------
// 接线层：「预设要补几个 Region」只有一处推导。
//
// 上面那族判的是菜单模型算得对，workbench-region-store.test.ts 判的是布局真的摆成了那个形状。
// 两者都判不到的事是：**第二个调用方有没有自己抄一份那次推导**。而这正是 #325 的形状——
// 那次推导原先是 arrangeWorkbenchControlTab 的入参（addedRegionIds），于是住在调用方；
// 一个调用方时看不出问题，第二个调用方必须抄一份，两份必漂移。漂移的症状是抄错的那侧撞
// `required - present` 校验，用户点了预设只收到内部错误串，而另一侧照旧工作。
//
// 判据落在 **id 从哪来**：引擎的第三个形参必须是「铸一个 id 的手段」而不是「一串已经算好的 id」。
// 这样调用方连数都数不着，也就没有可漂移的余地。
// ---------------------------------------------------------------------------
describe('补几个 Region 这次推导只有一处', () => {
  const control = readFileSync(
    new URL('../src/renderer/src/lib/control.ts', import.meta.url),
    'utf8'
  )
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')

  /**
   * 推导的形状：按预设容量与当前格数之差铸出那么多 id。
   * `Array.from({length: required - present.length}, mint)` 是它，
   * `for (let i = 0; i < n - m; i++)` 也是它——判的是「拿容量减格数当数量」这个动作，
   * 不是某种具体写法。
   */
  const DERIVES_COUNT =
    /workbenchRegionPresetSize|presetSize|required\s*-\s*|-\s*present\.length|-\s*current\.length/

  it('前提自检：这个判据认得引擎里那次推导本身，不是一个恒不匹配的正则', () => {
    // 没有这条，把正则写坏（多一个字符）会让整族守卫静默变成恒绿——它检查的是「别处没有」，
    // 而恒不匹配的正则在任何地方都「没有」。
    expect(DERIVES_COUNT.test(control), '引擎里那次推导都认不出来，判据是坏的').toBe(true)
  })

  it('引擎收的是铸 id 的手段，不是一串算好的 id', () => {
    // 形参是 `addedRegionIds: readonly string[]` 时，数量由调用方决定——那就是漂移的入口。
    expect(
      /export function arrangeWorkbenchControlTab\([^)]*mintRegionId:\s*\(\)\s*=>\s*string/s.test(control),
      'arrangeWorkbenchControlTab 又收回了一串算好的 id：调用方重新有了数错的自由'
    ).toBe(true)
    expect(
      /export function arrangeWorkbenchControlTab\([^)]*addedRegionIds/s.test(control),
      'addedRegionIds 回到形参上了'
    ).toBe(false)
  })

  it('store 里两个调用方都不自己算数量', () => {
    // 控制协议分支与 GUI 入口（arrangeTabRegions）都只交 newRegionId。任一侧自己算一遍，
    // 这条就红——那正是要防的靶子。
    const callSites = store.match(/arrangeWorkbenchControlTab\([^)]*\)/gs) ?? []
    expect(callSites.length, '前提自检：store 里找不到调用点，判据挂在空处').toBe(2)
    for (const site of callSites) {
      expect(site, `这个调用点自己算了数量：${site}`).not.toMatch(DERIVES_COUNT)
      expect(site, `这个调用点传的不是铸 id 的手段：${site}`).toMatch(/newRegionId\s*\)/)
    }
  })

  it('菜单模型也不算数量——它只判「能不能提供」', () => {
    const actions = readFileSync(
      new URL('../src/renderer/src/lib/workbench-tab-actions.ts', import.meta.url),
      'utf8'
    )
    // 这个文件确实读容量表（workbenchRegionPresetSize）来决定列不列，那是另一件事。
    // 不该出现的是「容量减当前格数」——那就是在算 additions。
    expect(actions).not.toMatch(/-\s*(?:input\.)?regionCount|regionCount\s*-\s*/)
  })
})

// ---------------------------------------------------------------------------
// 渲染层：菜单项在场不等于点得动。
//
// Radix Content 默认关闭且在 Portal 里，renderToStaticMarkup 渲不出它——与
// workspace-row-context-menu.test.ts / region-context-menu.test.tsx 同一个教训，
// 「渲出来数菜单项」这条路走不通。于是把判据落在「渲染层有没有可以取反的在场判断」：
// 只要 JSX 只 map 那份清单、不自己读任何 gating 字段，就没有条件可以被静默取反。
//
// 若这条不在，`{false && ...}` 或一个多余的三元就能让四个预设对用户彻底消失，而上面每一条
// （模型算得对、布局摆得对、只有一处推导）照旧全绿——那正是 #325 本身的形状：能力在场、入口不在。
// ---------------------------------------------------------------------------
describe('PaneSplitMenu 的预设那一段没有可取反的在场判断', () => {
  const source = readFileSync(
    new URL('../src/renderer/src/components/PaneSplitMenu.tsx', import.meta.url),
    'utf8'
  )
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const opens = withoutComments.indexOf('<DropdownMenu.Content')
  const closes = withoutComments.indexOf('</DropdownMenu.Content>')
  const content = withoutComments.slice(opens, closes)

  it('自检：真的截到了那段 JSX（左右界都在，不是切到文件末尾）', () => {
    // 只取左界会让邻节顶上来，判据就落在了别处（记忆 section-slice-without-right-bound）。
    expect(opens).toBeGreaterThan(-1)
    expect(closes).toBeGreaterThan(opens)
    expect(content).toContain('DropdownMenu.Item')
  })

  it('画的是模型给的那份清单，不是一串手写项', () => {
    expect(content, '预设项不是从 presetMenu.presets 画出来的').toContain('presetMenu.presets.map(')
    expect(content).toContain('WORKBENCH_TAB_SPLIT_ACTIONS.map(')
  })

  it('渲染层不自己判「这个预设可不可用」——那个判断只在菜单模型里', () => {
    // 出现这些就说明容量判定被抄进了组件：与 workbenchRegionPresetMenu 两份，必漂移。
    for (const smell of ['regionCount >', 'regionCount <', 'regionCount ===', 'workbenchRegionPresetSize']) {
      expect(content, `${smell} 又被渲染层直接读了`).not.toContain(smell)
    }
  })

  it('点下去发的是模型的 onSelect，不是绕过它直接调 onArrange', () => {
    // 绕过 onSelect 直接 onArrange 今天等价（onSelect 就是转发），但那样一来模型侧的
    // 「清单与动作同源」就买不到任何东西了——下一次给 onSelect 加副作用时会静默漏掉这一路。
    expect(content).toContain('presetMenu.onSelect(')
    expect(content, '渲染层绕过模型直接调了 onArrange').not.toMatch(/onArrange\s*\(/)
  })
})
