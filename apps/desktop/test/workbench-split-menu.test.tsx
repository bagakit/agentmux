import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import {
  WORKBENCH_TAB_SPLIT_ACTIONS,
  workbenchRegionPresetMenu,
  workbenchSplitMenuEntries
} from '../src/renderer/src/lib/workbench-tab-actions'
import {
  workbenchRegionPresetIcon,
  workbenchSplitDirectionIcon,
  workbenchSplitMenuIcon,
  workbenchSplitMenuKey
} from '../src/renderer/src/components/workbench-split-menu-icons'
import { createRegionCopyModel } from '../src/renderer/src/components/RegionContextMenu'
import type { SplitDirection } from '../src/renderer/src/lib/workbench-layout'
import type { WorkbenchRegionLayoutPreset } from '../src/renderer/src/lib/workbench-view-layout'

const COMPONENTS = join(__dirname, '../src/renderer/src/components')

function componentSource(name: string): string {
  return readFileSync(join(COMPONENTS, name), 'utf8')
}

/**
 * 某个 JSX 元素上某个属性的**值表达式源文本**。
 *
 * 为什么必须走 AST 而不是 `toContain('splitMenu={workbenchSplitMenuEntries(')`：那种判据只问
 * 「这串字符在不在」，而实测能杀死整节的两种写法都让它原样通过——
 *   - `splitMenu={undefined && workbenchSplitMenuEntries({…})}`：字符串在场，整节消失，15 条全绿
 *   - `splitMenu={[]}`：属性必填也拦不住，类型合法
 * 前者是我真跑出来的存活变异（变异 5）。文本判据看得见字符，看不见「这个属性的值到底是什么」。
 * 取到值表达式的节点之后，判据就能落在**表达式的种类**上：它必须就是一次调用，而不是一个 `&&`、
 * 一个三元、一个数组字面量、或任何把调用包在里面的形状。
 *
 * 注释与字符串里的同名片段根本不会进 AST（记忆 lexical-boundaries-need-a-real-lexer：按行猜词法
 * 边界是一族盲点——本文件顶部与被测组件里都有大段解释这个属性的注释，正则会全部命中）。
 */
function jsxAttributeExpression(
  sourceText: string,
  fileName: string,
  element: string,
  attribute: string
): { kind: ts.SyntaxKind; text: string } | null {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found: { kind: ts.SyntaxKind; text: string } | null = null
  const walk = (node: ts.Node): void => {
    const opening = ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) ? node : null
    if (opening && ts.isIdentifier(opening.tagName) && opening.tagName.text === element) {
      for (const property of opening.attributes.properties) {
        if (!ts.isJsxAttribute(property) || property.name.getText(source) !== attribute) continue
        const initializer = property.initializer
        // `splitMenu` 裸写（无 `=`）也是一种「没真接上」，用 JsxAttribute 自身代表它。
        const expression =
          initializer && ts.isJsxExpression(initializer) && initializer.expression
            ? initializer.expression
            : (initializer ?? property)
        found = { kind: expression.kind, text: expression.getText(source) }
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
  return found
}

/**
 * 分屏与重排那一节现在出现在四个容器里（Tab 条的 Split 下拉、Tab 右键菜单、一格的右键菜单、
 * 以及点链接的目的地选择器）。它们必须共用一份清单与一份图标——本仓刚修完的真缺陷正是「图标
 * 表达的方向与落点相反」，四个方向同时反了；同一族图标散在多个文件里就意味着修对一处而另几处
 * 静默留着反的那份，且每个容器各自的测试照旧全绿。
 *
 * 所以这里的判据分两层，各自能被单独变异打红：
 *   - 取值层：清单与图标的取值本身（纯函数，跑得到）
 *   - 接线层：每个容器真的从共用模块取图标，而不是自己再写一张表
 * 接线层用 **import 关系**判，不用「字面量在不在场」——`not.toContain('ArrowLeft')` 这种判据
 * 会被「重新 import 一次 lucide 再写一张同名表」原样绕过（见 guard-criterion-must-be-import-relation）。
 */
describe('分屏与重排菜单：一份清单、一份图标、四个容器', () => {
  it('清单把四个方向全列出来，顺序与 SSOT 一致', () => {
    const entries = workbenchSplitMenuEntries({ regionCount: 1, split: () => {}, arrange: () => {} })
    const splits = entries.filter((entry) => entry.kind === 'split')
    expect(splits.map((entry) => (entry.kind === 'split' ? entry.direction : null))).toEqual(
      WORKBENCH_TAB_SPLIT_ACTIONS.map((action) => action.direction)
    )
    // 四个方向一个不少：少一个就是某个方向的分屏对用户彻底不存在。
    expect(new Set(splits.map((entry) => (entry.kind === 'split' ? entry.direction : '')))).toEqual(
      new Set<SplitDirection>(['left', 'right', 'up', 'down'])
    )
  })

  it('点一条分屏，发出的就是那一条的方向', () => {
    const split = vi.fn<(direction: SplitDirection) => void>()
    const entries = workbenchSplitMenuEntries({ regionCount: 1, split, arrange: () => {} })
    for (const entry of entries) {
      if (entry.kind !== 'split') continue
      split.mockClear()
      entry.onSelect()
      expect(split, `"${entry.label}" 发错了方向`).toHaveBeenCalledWith(entry.direction)
    }
  })

  it('点一档预设，发出的就是那一档', () => {
    const arrange = vi.fn<(preset: WorkbenchRegionLayoutPreset) => void>()
    const entries = workbenchSplitMenuEntries({ regionCount: 1, split: () => {}, arrange })
    const presets = entries.filter((entry) => entry.kind === 'preset')
    expect(presets.length, '预设那一组整组消失了').toBeGreaterThan(0)
    for (const entry of presets) {
      if (entry.kind !== 'preset') continue
      arrange.mockClear()
      entry.onSelect()
      expect(arrange, `"${entry.label}" 发错了预设`).toHaveBeenCalledWith(entry.preset)
    }
  })

  it('容量判定只此一处：清单里的预设与 workbenchRegionPresetMenu 逐档相同', () => {
    // 覆盖到「全都摆得成」「只剩最大那档」「一档也摆不成」三种格数。
    for (const regionCount of [1, 2, 3, 4, 5, 7, 10]) {
      const fromMenu = workbenchRegionPresetMenu({ regionCount, arrange: () => {} }).presets.map(
        (action) => action.preset
      )
      const fromEntries = workbenchSplitMenuEntries({
        regionCount,
        split: () => {},
        arrange: () => {}
      })
        .filter((entry) => entry.kind === 'preset')
        .map((entry) => (entry.kind === 'preset' ? entry.preset : null))
      expect(fromEntries, `${regionCount} 格时两处容量判定不一致`).toEqual(fromMenu)
    }
  })

  it('分隔线与预设那一组同生共死（不画悬在末尾的线）', () => {
    const withPresets = workbenchSplitMenuEntries({
      regionCount: 1,
      split: () => {},
      arrange: () => {}
    })
    expect(withPresets.some((entry) => entry.kind === 'preset')).toBe(true)
    expect(withPresets.filter((entry) => entry.kind === 'separator')).toHaveLength(1)
    // 分隔线两侧都得真有东西。
    const separatorIndex = withPresets.findIndex((entry) => entry.kind === 'separator')
    expect(separatorIndex).toBeGreaterThan(0)
    expect(separatorIndex).toBeLessThan(withPresets.length - 1)

    // 格数超过全部预设时，预设整组消失，那条线也不该留下。
    const noPresets = workbenchSplitMenuEntries({
      regionCount: 99,
      split: () => {},
      arrange: () => {}
    })
    expect(noPresets.some((entry) => entry.kind === 'preset')).toBe(false)
    expect(noPresets.some((entry) => entry.kind === 'separator')).toBe(false)
  })

  it('每条可点条目都有图标与稳定 key，且分隔线不与任何条目撞 key', () => {
    const entries = workbenchSplitMenuEntries({ regionCount: 1, split: () => {}, arrange: () => {} })
    const keys = entries.map((entry, index) => workbenchSplitMenuKey(entry, index))
    expect(new Set(keys).size, 'key 撞了，React 会丢条目').toBe(entries.length)
    for (const entry of entries) {
      if (entry.kind === 'separator') continue
      // lucide 的图标是 forwardRef 组件（对象，不是函数），所以只能判「有且能渲染」。
      expect(workbenchSplitMenuIcon(entry), `"${entry.label}" 没有图标`).toBeTruthy()
    }
  })

  it('同一个方向从哪个取值口拿都是同一个图标', () => {
    // Tab 菜单的「移到新组」按方向出图标，走的是 workbenchSplitDirectionIcon；分屏菜单走
    // workbenchSplitMenuIcon。两者若各有一张表，同一张菜单里两处朝向会不一致。
    for (const action of WORKBENCH_TAB_SPLIT_ACTIONS) {
      const viaEntry = workbenchSplitMenuIcon({
        kind: 'split',
        direction: action.direction,
        label: action.label,
        onSelect: () => {}
      })
      expect(viaEntry, `${action.direction} 两个取值口给出不同图标`).toBe(
        workbenchSplitDirectionIcon(action.direction)
      )
    }
  })

  it('四个方向的图标各不相同（同一个图标画四个方向等于没画方向）', () => {
    const icons = WORKBENCH_TAB_SPLIT_ACTIONS.map((action) =>
      workbenchSplitDirectionIcon(action.direction)
    )
    expect(new Set(icons).size).toBe(icons.length)
  })

  it('每档预设的图标各不相同', () => {
    const presets = workbenchRegionPresetMenu({ regionCount: 1, arrange: () => {} }).presets
    const icons = presets.map((action) => workbenchRegionPresetIcon(action.preset))
    expect(new Set(icons).size).toBe(icons.length)
  })

  /**
   * 接线层。判的是「这个容器从共用模块取图标」，而不是某个字面量在不在场。
   *
   * 自检在前：若共用模块改名或搬家，这条守卫会静默恒绿（每个容器都「没 import 那个不存在的名字」
   * 也算不上违规）。所以先断言那个模块路径确实是我们在用的那个。
   */
  const ICON_MODULE = './workbench-split-menu-icons'
  const ICON_CONTAINERS = [
    'PaneSplitMenu.tsx',
    'RegionContextMenu.tsx',
    'WorkbenchTabContextMenu.tsx'
  ] as const

  it('自检：共用图标模块存在且导出三个取值口', () => {
    const source = componentSource('workbench-split-menu-icons.ts')
    for (const name of [
      'workbenchSplitMenuIcon',
      'workbenchSplitDirectionIcon',
      'workbenchRegionPresetIcon'
    ]) {
      expect(source, `共用图标模块不再导出 ${name}，下面的接线守卫会变成恒绿`).toContain(
        `export function ${name}`
      )
    }
  })

  it('每个菜单容器都从共用模块取图标，没有谁自己再建一张方向表', () => {
    for (const container of ICON_CONTAINERS) {
      const source = componentSource(container)
      expect(source, `${container} 没有从 ${ICON_MODULE} 取图标`).toContain(ICON_MODULE)
      // 自己从 lucide 直接取方向箭头，就是又建了一张表。ArrowRight 等四个名字只该出现在共用模块里。
      const lucideImport = source.match(/import\s*\{([^}]*)\}\s*from\s*'lucide-react'/)
      expect(lucideImport, `${container} 读不出 lucide 的 import 段`).not.toBeNull()
      for (const arrow of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
        expect(
          lucideImport![1]!,
          `${container} 自己从 lucide 取了 ${arrow}——方向图标只该有共用模块那一份`
        ).not.toContain(arrow)
      }
    }
  })

  /**
   * 「这个容器真的把清单画出来了」这一层在本仓渲不出来（Radix 的 Content 默认关闭且在 Portal 里，
   * renderToStaticMarkup 拿不到）。所以判据落在容器**只有一次 map、没有自己的条件**上：
   * 只要它是 `entries.map`，`{false && …}` 那类让整项永不渲染的形状就无处可写。
   *
   * 这条规矩是实测出来的，且我第一版就违反过：一格的右键菜单最初把分屏一节写成
   * `{splitMenu && splitMenu.length > 0 ? (` 的第二个 JSX 分支，改成 `false ?` 后整节永不渲染
   * （用户完全点不到分屏）而 13 条全绿。所以分屏项现在住进 `createRegionCopyModel` 的 entries 里，
   * 「这一节在不在」由下面那条数据断言守。
   */
  it('分屏下拉与一格的右键菜单都只 map 共用清单，不自己列一遍方向', () => {
    for (const container of ['PaneSplitMenu.tsx', 'RegionContextMenu.tsx'] as const) {
      const source = componentSource(container)
      expect(
        source,
        `${container} 没有走 workbenchSplitMenuEntries/splitMenu 那份清单`
      ).toMatch(/workbenchSplitMenuEntries|splitMenu/)
      expect(
        source,
        `${container} 自己 map 了 WORKBENCH_TAB_SPLIT_ACTIONS——那是第二份清单`
      ).not.toContain('WORKBENCH_TAB_SPLIT_ACTIONS')
    }
  })

  it('一格右键菜单的分屏一节住在 entries 里：给了清单就有，没给就整节不出现', () => {
    const splitMenu = workbenchSplitMenuEntries({
      regionCount: 1,
      split: () => {},
      arrange: () => {}
    })
    const withSplit = createRegionCopyModel({
      regionId: 'region-1',
      agentSessionId: null,
      writeClipboardText: async () => {},
      splitMenu
    }).entries
    const splitEntries = withSplit.filter((entry) => entry.kind === 'split')
    // 逐条都在，不是「有几条就算」——少一条就是那个方向的分屏在这个菜单上不存在。
    expect(splitEntries).toHaveLength(splitMenu.length)
    expect(
      splitEntries.map((entry) => (entry.kind === 'split' ? entry.entry : null))
    ).toEqual([...splitMenu])
    // 排在地址项之后（布局是次要一组），且与地址项之间恰好隔一道线。
    const firstSplitAt = withSplit.findIndex((entry) => entry.kind === 'split')
    expect(firstSplitAt).toBeGreaterThan(0)
    expect(withSplit[firstSplitAt - 1]?.kind, '分屏一节前面缺一道分隔线').toBe('separator')
    expect(
      withSplit.slice(firstSplitAt).some((entry) => entry.kind === 'action'),
      '地址项跑到分屏后面去了'
    ).toBe(false)

    // 不给清单：整节连同那道线都不出现（不是画一组禁用的假按钮）。
    const withoutSplit = createRegionCopyModel({
      regionId: 'region-1',
      agentSessionId: null,
      writeClipboardText: async () => {}
    }).entries
    expect(withoutSplit.some((entry) => entry.kind === 'split')).toBe(false)
    expect(withoutSplit.some((entry) => entry.kind === 'separator')).toBe(false)
  })

  it('一格右键菜单里点分屏，发出的就是那一条', () => {
    const split = vi.fn<(direction: SplitDirection) => void>()
    const arrange = vi.fn<(preset: WorkbenchRegionLayoutPreset) => void>()
    const entries = createRegionCopyModel({
      regionId: 'region-1',
      agentSessionId: null,
      writeClipboardText: async () => {},
      splitMenu: workbenchSplitMenuEntries({ regionCount: 1, split, arrange })
    }).entries
    for (const entry of entries) {
      if (entry.kind !== 'split' || entry.entry.kind === 'separator') continue
      split.mockClear()
      arrange.mockClear()
      entry.entry.onSelect()
      if (entry.entry.kind === 'split') {
        expect(split, `"${entry.entry.label}" 在这个菜单里发错了方向`).toHaveBeenCalledWith(
          entry.entry.direction
        )
      } else {
        expect(arrange, `"${entry.entry.label}" 在这个菜单里发错了预设`).toHaveBeenCalledWith(
          entry.entry.preset
        )
      }
    }
  })

  it('Tab 右键菜单的重排一节走容量判定，且以缺席表达「摆不成」', () => {
    const source = componentSource('WorkbenchTabContextMenu.tsx')
    expect(source, 'Tab 菜单没有接容量判定').toContain('workbenchRegionPresetMenu')
    expect(source, 'Tab 菜单没有重排入口').toContain('Rearrange Splits')
    // 触发器整段挂在「有没有可选预设」上：不画一个点开只有空清单的入口。
    expect(source).toContain('presetMenu.presets.length > 0')
  })

  /**
   * 接线层的第二半：**这两个菜单真的被接上了**。
   *
   * 前面那些判据管的是「清单算得对」与「容器从共用模块取图标」。它们全绿时，把调用点的属性值
   * 换掉，整节照旧对用户消失——实测两种：
   *   - `splitMenu={undefined && workbenchSplitMenuEntries({…})}` → 15 条全绿（这是我真跑出的
   *     存活变异；`splitMenu?` 当时是可选的，所以连 tsc 都不报。属性已改必填，但那只挡住这一种拼法）
   *   - `splitMenu={[]}` → 类型完全合法，整节消失
   * 两者的共同点是「属性在场、字符串在场、值不是那次调用」，所以判据落在**值表达式的种类**上，
   * 不落在文本上（记忆 guard-must-check-reachability-not-presence / guard-criterion-must-be-import-relation）。
   *
   * 自检在前：取不到那个属性（组件改名、调用点被删、属性改名）时，「它不是 `&&`」会恒真地通过。
   * 所以先断言确实取到了值。
   */
  const WORKBENCH = 'WorkspaceWorkbench.tsx'

  it('一格的右键菜单真的接上了共用清单：属性值就是那次调用本身', () => {
    const attribute = jsxAttributeExpression(
      componentSource(WORKBENCH),
      WORKBENCH,
      'RegionContextMenu',
      'splitMenu'
    )
    expect(attribute, `${WORKBENCH} 里的 <RegionContextMenu> 没有 splitMenu 属性——整节对用户不存在`)
      .not.toBeNull()
    // 值必须**就是**一次调用，不是把调用包在 `&&`／三元／数组字面量里的任何形状。
    expect(
      ts.SyntaxKind[attribute!.kind],
      `splitMenu 的值不是一次调用而是 ${ts.SyntaxKind[attribute!.kind]}：\n${attribute!.text}`
    ).toBe('CallExpression')
    expect(attribute!.text.startsWith('workbenchSplitMenuEntries('), 'splitMenu 调的不是共用清单').toBe(
      true
    )
    // #337 的要害：分屏必须落在**右键点中的那一格**。用 activeRegionId／activeSurface 推断出来的
    // 格子在「想切旁边那一格」时就是错的，而那正是这个菜单存在的全部理由。
    expect(attribute!.text, 'splitMenu 没有把右键点中的 regionId 交给分屏').toContain('node.regionId')
  })

  it('Tab 右键菜单的重排真的接上了 store：不是一个什么都不做的回调', () => {
    const source = componentSource(WORKBENCH)
    const onArrange = jsxAttributeExpression(source, WORKBENCH, 'WorkbenchTabContextMenu', 'onArrange')
    expect(onArrange, `${WORKBENCH} 里的 <WorkbenchTabContextMenu> 没有 onArrange——点了没反应`)
      .not.toBeNull()
    expect(onArrange!.text, 'onArrange 没有调 arrangeTabRegions').toContain('arrangeTabRegions')
    // 重排的是**被右键点中的那张** Tab。用活动 Tab 的 id 会在非活动 Tab 上重排错的那张。
    expect(onArrange!.text, 'onArrange 重排的不是被右键点中的那张 Tab').toContain('tab.id')

    const regionCount = jsxAttributeExpression(
      source,
      WORKBENCH,
      'WorkbenchTabContextMenu',
      'regionCount'
    )
    expect(regionCount, 'Tab 菜单没有拿到格数——容量判定会按错的前提过滤预设').not.toBeNull()
    // 同理：格数取自这张 Tab 自己的 regions，不是当前活动 Tab 的。
    expect(regionCount!.text, 'regionCount 不是这张 Tab 自己的格数').toContain('tab.regions')
  })
})
