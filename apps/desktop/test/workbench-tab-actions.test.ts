import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import {
  WORKBENCH_TAB_SPLIT_ACTIONS,
  moveSessionViewTargets,
  regionSwapMenuEntries,
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
    //
    // 发出去的是引擎那个三档 union 里的 preset 档，不是裸档名：#486 之前 store 的签名只收裸
    // preset，于是均分／当前格优先根本表达不出来。这里连 `kind` 一起钉住，那个签名一收窄就红。
    const spy = vi.fn()
    const menu = workbenchRegionPresetMenu({ regionCount: 1, arrange: spy })
    for (const item of menu.presets) menu.onSelect(item.preset)
    expect(spy.mock.calls.map(([mode]) => mode)).toEqual([
      { kind: 'preset', preset: 'columns-3' },
      { kind: 'preset', preset: 'grid-4' },
      { kind: 'preset', preset: 'grid-6' },
      { kind: 'preset', preset: 'grid-9' }
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
//
// **判据跟着结构走过一次**：这一节最初只钉 PaneSplitMenu，且钉的是它当时那两份手抄 map
// （`presetMenu.presets.map` + `WORKBENCH_TAB_SPLIT_ACTIONS.map`）与 `presetMenu.onSelect`。
// #337/#340 把这份清单抽成了 `workbenchSplitMenuEntries`，那三个名字在 PaneSplitMenu 里一个不剩，
// 于是旧判据钉在了**已经不存在的结构名**上并变红。改判据而不是改回实现：它守的性质没变
// （这一段里没有可取反的在场判断），换的只是那份清单叫什么。
//
// 同时补上一个**被承诺却从未落地**的判据：workbench-split-menu.test.tsx:241 的注释写着
// 「判据落在容器只有一次 map、没有自己的条件上」，而它下面那条测试只做了
// `toContain('workbenchSplitMenuEntries|splitMenu')`——注释描述的那件事没有任何人在做
// （记忆 declared-capability-silently-not-done：纯描述没有消费者，那条轴上的谎言免检）。
// 那条注释所记的事故（一格右键菜单把分屏一节写成 `{splitMenu && … ? (`，改成 `false ?` 后整节
// 永不渲染而 13 条全绿）能在**两个**容器里各犯一次，所以这里逐容器判。
//
// 为什么不把 WorkbenchTabContextMenu 也算进来：它不是这份清单的消费者。它自己 map 的
// `WORKBENCH_TAB_SPLIT_ACTIONS` 是「Move Tab to New Group」（另一件事：移动 Tab，不是分屏），
// `presetMenu.presets` 是它自己那个 Rearrange 子菜单——两者各自由
// workbench-split-menu.test.tsx:326 与本文件上面那族守着。把它塞进来只会让判据松到恒真。
// ---------------------------------------------------------------------------
describe('分屏菜单的那一段没有可取反的在场判断', () => {
  /**
   * 共用清单的两个消费者。各自带上「这份清单在这个容器里叫什么」，判据就不必松到能同时命中
   * 两种拼法——那种松法正是它要防的东西（记忆 counting-a-symbol-misses-other-spellings）。
   */
  const CONTAINERS = [
    {
      file: 'PaneSplitMenu.tsx',
      tag: 'DropdownMenu',
      /** 壳自己算清单：`const entries = workbenchSplitMenuEntries({…})`。 */
      list: 'entries',
      entry: 'entry'
    },
    {
      file: 'RegionContextMenu.tsx',
      tag: 'ContextMenu',
      /** 清单住在模型的 entries 里（分屏项与地址项同一份），由 createRegionCopyModel 组装。 */
      list: 'model.entries',
      entry: 'entry'
    }
  ] as const

  /** `<X.Content>` 那个 JSX 元素本身。边界由词法器给，不靠猜左右界。 */
  function contentElementIn(
    text: string,
    fileName: string,
    tag: string
  ): { node: ts.JsxElement; source: ts.SourceFile } | null {
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    let found: ts.JsxElement | null = null
    const walk = (node: ts.Node): void => {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === `${tag}.Content`) {
        found = node
      }
      ts.forEachChild(node, walk)
    }
    walk(source)
    return found ? { node: found, source } : null
  }

  function contentElement(file: string, tag: string): { node: ts.JsxElement; source: ts.SourceFile } {
    const text = readFileSync(
      new URL(`../src/renderer/src/components/${file}`, import.meta.url),
      'utf8'
    )
    const found = contentElementIn(text, file, tag)
    if (!found) throw new Error(`${file} 里找不到 <${tag}.Content> ——组件换了容器或改了名`)
    return found
  }

  /**
   * 这段 JSX 的子节点里所有**内联条件**：三元与 `&&`。
   *
   * 为什么必须走词法器：按标点猜是一族盲点。我第一版写的 `/\?(?![.?])/` 把 `a ?? b` 的第二个 `?`
   * 当成三元门（下面那条自检当场抓到），而字符串、模板字面量、类型标注里的 `?` 也全会误报；
   * 反过来把正则放松到躲开这些，`{cond ? … : null}` 就漏了。词法器分得清这四种 `?`，正则分不清
   * （记忆 lexical-boundaries-need-a-real-lexer）。
   *
   * map 回调里的 `if (entry.kind === …) return …` 不算：那是按数据分支，每一项都到得了。被挡的是
   * 「整节要不要出现」这种只有渲染层知道的判断。
   */
  function inlineConditions(node: ts.JsxElement, source: ts.SourceFile): string[] {
    const out: string[] = []
    const walk = (child: ts.Node): void => {
      if (ts.isConditionalExpression(child)) out.push(child.getText(source))
      if (
        ts.isBinaryExpression(child) &&
        child.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        out.push(child.getText(source))
      }
      ts.forEachChild(child, walk)
    }
    for (const child of node.children) walk(child)
    return out
  }

  /** 那段 JSX 的源文本，注释已剥掉（注释里描述规则的文字不是规则本身）。 */
  function contentText(file: string, tag: string): string {
    const { node, source } = contentElement(file, tag)
    return node
      .getText(source)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  }

  it('自检：真的取到了那段 JSX，且它确实在画菜单项', () => {
    for (const { file, tag } of CONTAINERS) {
      expect(contentText(file, tag), `${file} 取到的那段里没有菜单项`).toContain(`${tag}.Item`)
    }
  })

  it('画的是共用的那份清单，且整段只 map 一次', () => {
    for (const { file, tag, list, entry } of CONTAINERS) {
      const content = contentText(file, tag)
      expect(
        content,
        `${file} 的菜单项不是从 ${list} 画出来的——它要么自己列了一遍，要么换了清单来源`
      ).toContain(`${list}.map(`)
      // 「只有一次 map」是 workbench-split-menu.test.tsx:241 那段注释承诺过、却从未落地的判据本身：
      // 第二次 map 就是第二份清单，改一处漏另一处。
      expect(
        [...content.matchAll(/\.map\(/g)].length,
        `${file} 的 Content 里有不止一次 map——第二份清单必与共用那份漂移`
      ).toBe(1)
      // 标签与图标都取自清单元素，不能是写死的字面量（写死了就等于自绘项）。
      expect(content, `${file} 的项标签不是取自清单元素`).toMatch(
        new RegExp(`\\{${entry}[\\w.]*\\.label\\}`)
      )
    }
  })

  it('这一段里没有内联条件——想让某项消失只能改清单，改不了 JSX', () => {
    // 事故原样：`{splitMenu && splitMenu.length > 0 ? (` → 改成 `false ?` 整节永不渲染而 13 条全绿。
    // 判据是「这一段里连写条件的地方都没有」，比枚举某几种坏拼法牢固：`{false && …}`、
    // `{cond ? … : null}`、`{list.length > 0 && …}` 全被同一条挡住。
    // 真需要条件时把它挪进清单——那里跑得到、断言得着。
    for (const { file, tag } of CONTAINERS) {
      const { node, source } = contentElement(file, tag)
      expect(
        inlineConditions(node, source),
        `${file} 的 Content 里有内联条件——整节可以被它取反成永不渲染`
      ).toEqual([])
    }
  })

  it('渲染层不自己判「这个预设可不可用」——那个判断只在菜单模型里', () => {
    // 出现这些就说明容量判定被抄进了组件：与 workbenchRegionPresetMenu 两份，必漂移。
    for (const { file, tag } of CONTAINERS) {
      const content = contentText(file, tag)
      for (const smell of ['regionCount >', 'regionCount <', 'regionCount ===', 'workbenchRegionPresetSize']) {
        expect(content, `${file} 里 ${smell} 又被渲染层直接读了`).not.toContain(smell)
      }
    }
  })

  it('点下去发的是清单元素带的 onSelect，不是绕过它直接调 split/arrange', () => {
    // 绕过 onSelect 直接调 onArrange/onSplit 今天等价（onSelect 就是转发），但那样一来模型侧的
    // 「清单与动作同源」就买不到任何东西了——下一次给 onSelect 加副作用时会静默漏掉这一路。
    for (const { file, tag, entry } of CONTAINERS) {
      const content = contentText(file, tag)
      expect(content, `${file} 没有把清单元素的 onSelect 接上`).toMatch(
        new RegExp(`onSelect=\\{${entry}[\\w.]*\\.onSelect\\}`)
      )
      expect(content, `${file} 的渲染层绕过清单直接调了 onArrange(`).not.toMatch(/onArrange\s*\(/)
      expect(content, `${file} 的渲染层绕过清单直接调了 onSplit(`).not.toMatch(/onSplit\s*\(/)
    }
  })

  it('自检：条件检测器认得 && 门与三元门，且不把 ?. / ?? 误当条件', () => {
    // 没有这条，检测器写坏会让整族静默变恒绿——「没找到违规」与「认不出违规」在结果上同形。
    // 逐个喂它该拒的与该放的形状：判据自己也得受质询。
    const detect = (body: string): string[] => {
      const found = contentElementIn(
        `const X = () => (<DropdownMenu.Content>${body}</DropdownMenu.Content>)`,
        'probe.tsx',
        'DropdownMenu'
      )
      expect(found, '探针源码里取不到 Content——自检本身是坏的').not.toBeNull()
      return inlineConditions(found!.node, found!.source)
    }
    // 该拒：两种把整节取反的门。
    expect(detect('{false && entries.map((entry) => <I key={entry.key} />)}'), '认不出 && 门')
      .not.toEqual([])
    expect(detect('{entries.length > 0 ? entries.map((entry) => null) : null}'), '认不出三元门')
      .not.toEqual([])
    // 该放：可选链与 `??` 不是条件门（我第一版的正则判据正是在这里误报的）。
    expect(
      detect('{entries.map((entry) => <I key={entry.key}>{entry.action?.label ?? entry.label}</I>)}'),
      '把 ?. / ?? 误当成了条件门'
    ).toEqual([])
    // 该放：map 回调里按数据分支的 if——每一项都到得了，不是「整节要不要出现」。
    expect(
      detect('{entries.map((entry) => { if (entry.kind === "separator") return null; return <I /> })}'),
      '把 map 回调里的 if 误当成了整节的门'
    ).toEqual([])
    // 第二份清单：两次 map 必须被数出来（这条判据是文本计数，同样要自证）。
    expect(
      [...'{a.map(x => x)}{b.map(y => y)}'.matchAll(/\.map\(/g)].length,
      '「只 map 一次」判据数不出第二份清单'
    ).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// #471「右键 region 在已有布局中和其他 region 交换位置」的菜单模型。
//
// 换位是纯布局代数（swapWorkbenchRegions），但「能和谁换、点了换哪个」这份清单必须是数据，
// 理由与 workbenchSplitMenuEntries / moveSessionViewMenu 完全相同：RegionContextMenu 的 Content
// 只 map 一份 entries、不写任何内联条件（Radix Content 在 Portal 里且默认关闭，renderToStaticMarkup
// 渲不出，"真挂载点一下"这条路在本仓走不通）。所以在场、顺序、点了发什么都降成这份清单。
// ---------------------------------------------------------------------------
describe('regionSwapMenuEntries：能和哪些 region 换位', () => {
  it('列出除自己外的每一格，点下去换的就是那一格', () => {
    const swap = vi.fn<(a: string, b: string) => void>()
    const entries = regionSwapMenuEntries({
      regionId: 'r1',
      regions: [
        { regionId: 'r0', label: 'Agent · repo' },
        { regionId: 'r1', label: 'Terminal' },
        { regionId: 'r2', label: 'example.com' }
      ],
      swap
    })
    // 自己不在清单里——和自己换是 no-op，画出来只是噪音。
    expect(entries.map((entry) => entry.targetRegionId)).toEqual(['r0', 'r2'])
    expect(entries.map((entry) => entry.label)).toEqual([
      'Swap with Agent · repo',
      'Swap with example.com'
    ])
    for (const entry of entries) {
      swap.mockClear()
      entry.onSelect()
      // 源格闭包在 onSelect 里（'r1'），目标是这一项自己的 regionId——两者不能错位。
      expect(swap, `${entry.label} 换错了目标`).toHaveBeenCalledWith('r1', entry.targetRegionId)
    }
  })

  it('只有一格时清单为空——没有可换的对象，整节以缺席表达', () => {
    expect(
      regionSwapMenuEntries({
        regionId: 'r0',
        regions: [{ regionId: 'r0', label: 'Only' }],
        swap: () => {}
      })
    ).toEqual([])
  })

  it('同名多格编号，否则「和哪一格换」无从分辨；唯一的保持裸名', () => {
    const entries = regionSwapMenuEntries({
      // 右键中间那个终端。编号覆盖全体（含自己），故目标仍是 1 和 3，不被重新数成 1、2。
      regionId: 't2',
      regions: [
        { regionId: 't1', label: 'Terminal' },
        { regionId: 't2', label: 'Terminal' },
        { regionId: 't3', label: 'Terminal' },
        { regionId: 'f1', label: 'index.ts' }
      ],
      swap: () => {}
    })
    expect(entries.map((entry) => entry.label)).toEqual([
      'Swap with Terminal 1',
      'Swap with Terminal 3',
      // index.ts 只有一个，保持裸名——不无谓地加「1」。
      'Swap with index.ts'
    ])
    // 编号是显示层的事，targetRegionId 仍是真 id。
    expect(entries.map((entry) => entry.targetRegionId)).toEqual(['t1', 't3', 'f1'])
  })

  it('被点的格不在 regions 里也不炸，只是无自身可排除——列出全部其它格', () => {
    // 防御式：右键与投影之间若有一瞬 regionId 尚未进 regions，仍给出其它格而非抛错。
    const entries = regionSwapMenuEntries({
      regionId: 'stale',
      regions: [
        { regionId: 'r0', label: 'A' },
        { regionId: 'r1', label: 'B' }
      ],
      swap: () => {}
    })
    expect(entries.map((entry) => entry.targetRegionId)).toEqual(['r0', 'r1'])
  })
})
