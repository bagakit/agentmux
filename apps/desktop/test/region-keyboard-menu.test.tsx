import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { opensContextMenuFromKeyboard } from '../src/renderer/src/lib/context-menu-key.js'
import { isFileExplorerMenuKey } from '../src/renderer/src/lib/file-explorer-move.js'

// ---------------------------------------------------------------------------
// Region 右键菜单的键盘入口（可达性缺口）。
//
// 缺口：承载 RegionContextMenu 的 <section> 此前只有 onPointerDown，没有键盘路径。Radix 的
// ContextMenu.Trigger 只认真正的 `contextmenu` 事件（右键），所以纯键盘用户根本进不去，于是一批
// 后端齐全的能力（promote / arrange 预设 / 均分 / move-to-workspace / split-left / split-up）对
// 他们完全不可达。修法是给 section 加 tabIndex + Shift+F10 / Menu 键 → 合成 contextmenu 打开
// **同一个**菜单，所有菜单项一次性获得键盘路径。
//
// 本仓约束：desktop 测试跑在 node 环境、无 jsdom，renderToStaticMarkup 不跑 effect、也发不出
// keydown；Radix 的 Portal 内容在 renderToStaticMarkup 下渲染为空。所以判据分三层：
//   1) 纯谓词层：「这个键该不该开菜单」（跑得到）
//   2) SSOT 层：这条规则只有一处，文件树那份委托到它（不许两处手抄漂移）
//   3) 接线层：section 真的带 tabIndex/onKeyDown，handler 真的合成 contextmenu（AST 读源码，
//      因为渲染/effect 在本仓证不了——「抽进 lib 只解决一半」的补法）
// ---------------------------------------------------------------------------

describe('opensContextMenuFromKeyboard：哪些键盘手势打开右键菜单', () => {
  const base = { key: '', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }

  it('Menu / Application 键（key === "ContextMenu"）无条件开', () => {
    // PC 键盘上那颗专用键。它不需要任何修饰键。
    expect(opensContextMenuFromKeyboard({ ...base, key: 'ContextMenu' })).toBe(true)
    // 带上修饰键也仍然是开菜单键（那颗键就是干这个的）。
    expect(opensContextMenuFromKeyboard({ ...base, key: 'ContextMenu', shiftKey: true })).toBe(true)
  })

  it('Shift+F10 开——mac 上没有 Menu 键，这才是通行的那个', () => {
    expect(opensContextMenuFromKeyboard({ ...base, key: 'F10', shiftKey: true })).toBe(true)
  })

  it('裸 F10（没有 Shift）不开——那是别的东西，不能误当成开菜单', () => {
    expect(opensContextMenuFromKeyboard({ ...base, key: 'F10' })).toBe(false)
  })

  it('F10 那一支要求“只有 Shift”：搭上 Alt / Ctrl / Meta 都不算', () => {
    // 否则 Ctrl+Shift+F10 之类的系统 / 应用组合会被误吞成开菜单。四个修饰位各钉一次。
    expect(opensContextMenuFromKeyboard({ ...base, key: 'F10', shiftKey: true, altKey: true })).toBe(false)
    expect(opensContextMenuFromKeyboard({ ...base, key: 'F10', shiftKey: true, ctrlKey: true })).toBe(false)
    expect(opensContextMenuFromKeyboard({ ...base, key: 'F10', shiftKey: true, metaKey: true })).toBe(false)
  })

  it('别的键一律不开', () => {
    for (const key of ['Enter', ' ', 'F9', 'F11', 'ArrowDown', 'a', 'Escape']) {
      expect(opensContextMenuFromKeyboard({ ...base, key }), `${key} 不该开菜单`).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// SSOT 层：这条规则只此一处。file-explorer-move 的 isFileExplorerMenuKey 保留自己的名字（它的
// foundations 测试按那个名字钉着），但实现必须委托到共用谓词——两处各抄一份必在「要不要认某个新
// 拼法」时漂移，而漂了没人会红（本仓反复栽在重复规则上：duplicated-rule-defeats-the-fix）。
//
// 判据是「两函数对每一个事件逐个同答」，而不是抽样一两个（抽样会放过只在某个修饰位上分岔的漂移）。
// ---------------------------------------------------------------------------
describe('两个命名入口读的是同一条规则（不许各抄一份漂移）', () => {
  it('穷举 key × 四个修饰位的组合，isFileExplorerMenuKey 与共用谓词逐个同答', () => {
    const keys = ['ContextMenu', 'F10', 'F9', 'Enter', ' ', 'a']
    let checked = 0
    for (const key of keys) {
      for (let mask = 0; mask < 16; mask += 1) {
        const event = {
          key,
          shiftKey: Boolean(mask & 1),
          altKey: Boolean(mask & 2),
          ctrlKey: Boolean(mask & 4),
          metaKey: Boolean(mask & 8)
        }
        expect(
          isFileExplorerMenuKey(event),
          `两个入口对 ${JSON.stringify(event)} 给出不同答案——规则漂移了`
        ).toBe(opensContextMenuFromKeyboard(event))
        checked += 1
      }
    }
    // 扫描式断言自证扫到了东西（空循环恒绿）。
    expect(checked).toBe(keys.length * 16)
  })
})

// ---------------------------------------------------------------------------
// 接线层：section 真的接上了键盘入口。
//
// 渲染 / effect 在本仓证不了（node 无 jsdom；renderToStaticMarkup 不跑 effect、也发不出 keydown；
// Radix Portal 渲成空），所以这一层读源码用 AST 判：
//   - 承载 RegionContextMenu 的那个 <section> 带 tabIndex 与 onKeyDown（缺任一都进不去）
//   - onKeyDown 接的就是 openRegionMenuFromKeyboard
//   - 那个 handler 用共用谓词做门，并在命中时合成一个 contextmenu 事件去开菜单
//
// 「抽进 lib 只解决一半」：谓词对、菜单模型对，都不代表 section 真被接上。这里就是补那半。
// ---------------------------------------------------------------------------
describe('WorkspaceWorkbench 把键盘入口接到了 Region 的 <section>', () => {
  const WORKBENCH = join(__dirname, '../src/renderer/src/components/WorkspaceWorkbench.tsx')
  const source = readFileSync(WORKBENCH, 'utf8')
  const file = ts.createSourceFile('WorkspaceWorkbench.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

  /** 找到带 data-workbench-region-id 的那个 <section> 开标签——就是承载右键菜单的那一格。 */
  function regionSection(): ts.JsxOpeningElement | null {
    let found: ts.JsxOpeningElement | null = null
    const walk = (node: ts.Node): void => {
      if (
        ts.isJsxOpeningElement(node) &&
        ts.isIdentifier(node.tagName) &&
        node.tagName.text === 'section'
      ) {
        const hasRegionId = node.attributes.properties.some(
          (property) =>
            ts.isJsxAttribute(property) &&
            property.name.getText(file) === 'data-workbench-region-id'
        )
        if (hasRegionId) found = node
      }
      ts.forEachChild(node, walk)
    }
    walk(file)
    return found
  }

  function attribute(element: ts.JsxOpeningElement, name: string): { kind: ts.SyntaxKind; text: string } | null {
    for (const property of element.attributes.properties) {
      if (!ts.isJsxAttribute(property) || property.name.getText(file) !== name) continue
      const initializer = property.initializer
      const expression =
        initializer && ts.isJsxExpression(initializer) && initializer.expression
          ? initializer.expression
          : (initializer ?? property)
      return { kind: expression.kind, text: expression.getText(file) }
    }
    return null
  }

  it('自检：找得到承载右键菜单的那个 <section>', () => {
    // 找不到（组件重构、属性改名）时，下面几条断言会以最难发现的方式恒绿。
    const section = regionSection()
    expect(section, '找不到带 data-workbench-region-id 的 <section>——接线守卫会变成恒绿').not.toBeNull()
  })

  it('section 带 tabIndex={-1}：可编程聚焦但不进 Tab 序', () => {
    // 键盘流是「Cmd+Alt+方向移到某格，再 Shift+F10」，所以只需可编程聚焦、不必进 Tab 序。
    // 进 Tab 序（tabIndex={0}）会把整页每个分屏都变成 Tab 停靠点，撑爆 Tab 序。
    const tabIndex = attribute(regionSection()!, 'tabIndex')
    expect(tabIndex, 'section 没有 tabIndex——element.focus() 之后收不到 keydown').not.toBeNull()
    // 恰好是 -1（不是 0）：0 会把它塞进 Tab 序。
    expect(tabIndex!.text.replace(/\s/g, ''), 'tabIndex 不是 -1（进了 Tab 序）').toBe('-1')
  })

  it('section 的 onKeyDown 接的就是 openRegionMenuFromKeyboard', () => {
    const onKeyDown = attribute(regionSection()!, 'onKeyDown')
    expect(onKeyDown, 'section 没有 onKeyDown——键盘完全进不去').not.toBeNull()
    expect(onKeyDown!.text, 'onKeyDown 接的不是那个键盘入口 handler').toContain('openRegionMenuFromKeyboard')
  })

  it('handler 用共用谓词做门，并合成 contextmenu 去开菜单', () => {
    // 掐掉整段 handler（见下面的变异断言）会让 onKeyDown 那条属性一起消失，故上一条也会红；
    // 这一条钉的是 handler 体本身的三件事：谓词门、命中就 preventDefault、合成 contextmenu。
    const start = source.indexOf('function openRegionMenuFromKeyboard')
    expect(start, '找不到键盘入口 handler').toBeGreaterThan(-1)
    // 截到函数体（到下一个顶层 `return (` 之前，即组件的 JSX return）。
    const body = source.slice(start, source.indexOf('\n  return (', start))
    expect(body, 'handler 没有用共用谓词做门——会对每个键都开菜单或都不开').toContain('opensContextMenuFromKeyboard(')
    // 门不命中就早退：谓词返回 false 时不能开菜单。
    expect(body, 'handler 没有在谓词不命中时早退').toMatch(/if\s*\(\s*!opensContextMenuFromKeyboard\([\s\S]*?\)\s*\)\s*return/)
    // 命中就 preventDefault（否则 F10 可能触发别的默认行为）。
    expect(body).toContain('event.preventDefault()')
    // 合成一个 contextmenu 事件——这是让 Radix 的 Trigger 定位并打开同一个菜单的唯一路径
    // （open=true 会警告并把菜单钉在视口左上角，不能用）。
    expect(body, 'handler 没有合成 contextmenu 事件').toContain("new MouseEvent('contextmenu'")
    // 事件必须冒泡到 Trigger（asChild 挂在 section 上，contextmenu 从 section 发出并冒泡）。
    expect(body).toContain('bubbles: true')
  })
})
