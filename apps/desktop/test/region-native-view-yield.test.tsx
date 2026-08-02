import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
// RegionContextMenu 为 #544 复用 store 的 setTabMenuOpen，import 它会连带加载 store → api.ts，后者在模块
// 加载期读构建期全局 __AGENTMUX_WEB_PREVIEW__。node 环境里它不存在，须先 stub（与 agent-address /
// tab-control-handoff 同一处理）。
vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})
import { createRegionMenuYield } from '../src/renderer/src/components/RegionContextMenu.js'

// ---------------------------------------------------------------------------
// #544：Region 右键菜单被原生 WebContentsView 盖住，看不见也点不到。
//
// 根因：browser 那格的内容是**窗口级的原生视图**，合成在所有 renderer 像素之上——DOM 里画出来的
// 右键菜单画在它下面。全仓每一个会盖住原生视图的浮层（Tab 右键菜单、Tab 条 Split 下拉、PaneSplitMenu）
// 都走**同一个 SSOT**：store 的 setTabMenuOpen，它把 nativeSurfacesVisible 压成 false，一路让 BrowserPane
// 的那条 useLayoutEffect `observe(null)` → `setBounds(null)` → `view.setVisible(false)`（后半段的契约在
// browser-view-manager.test.ts「owns … bounds」里钉着：setBounds(id, null) ⇒ visible=false）。
// RegionContextMenu 是唯一没接上这个开关的菜单，这正是 #544。修法是**复用**它，不另造一套。
//
// 本仓 desktop 测试跑在 node、无 jsdom：renderToStaticMarkup 不跑 effect、也发不出 Radix 的
// onOpenChange，所以「Radix Content 挂载点一下」这条路走不通（region-context-menu.test.tsx 顶部亦有
// 同样记录）。于是让位逻辑抽成 createRegionMenuYield 工厂：让「开关被拨了几次、各是什么值、复原走没走到」
// 脱离 DOM 也能被断言。判据是「调了几次边界、各带什么参数」——断言实际调用，且每次动作前把记录清零
// （本仓 fixture-discarding-callback-hides-empty-body / 「让/复原各数一次」的要求）。
// ---------------------------------------------------------------------------

describe('createRegionMenuYield：菜单开→让位，关→复原（#544 复用 setTabMenuOpen）', () => {
  it('菜单打开时把开关拨成 true（原生视图让位，菜单才画得到）', () => {
    const setTabMenuOpen = vi.fn<(open: boolean) => void>()
    const menuYield = createRegionMenuYield(setTabMenuOpen)

    setTabMenuOpen.mockClear()
    menuYield.onOpenChange(true)
    expect(setTabMenuOpen.mock.calls, 'onOpenChange(true) 应恰好拨一次开关').toEqual([[true]])
  })

  it('菜单正常关闭（Escape/点外部/失焦/选中项）时复原——onOpenChange(false) 无条件转发', () => {
    // Radix 的 onOpenChange 在这几条关闭路径上都以 false 触发。守的是「选中项」与「无选中的消失」
    // 两条都复原——只守一条是本仓记过的失败形状（guard 一侧出口）。这里用同一个入口覆盖两者：无论
    // 因何关闭，Radix 给的都是 onOpenChange(false)，它必须无条件把开关拨回。
    const setTabMenuOpen = vi.fn<(open: boolean) => void>()
    const menuYield = createRegionMenuYield(setTabMenuOpen)
    menuYield.onOpenChange(true)

    setTabMenuOpen.mockClear()
    menuYield.onOpenChange(false)
    expect(setTabMenuOpen.mock.calls, 'onOpenChange(false) 应恰好把开关拨回 false').toEqual([[false]])
  })

  it('菜单开着这一格就被关掉（组件卸载，onOpenChange(false) 不会触发）时，release 补上复原', () => {
    // 这是复原路径里最容易漏的一条：关格按钮 / closeRegion 让组件直接卸载，Radix 不再发
    // onOpenChange(false)。若不补，开关卡在 true——**所有**原生视图从此不显示（不止这一格）。
    const setTabMenuOpen = vi.fn<(open: boolean) => void>()
    const menuYield = createRegionMenuYield(setTabMenuOpen)
    menuYield.onOpenChange(true) // 菜单开着

    setTabMenuOpen.mockClear()
    menuYield.release() // 卸载
    expect(
      setTabMenuOpen.mock.calls,
      '菜单开着就卸载时，release 必须把开关拨回 false，否则所有原生视图永久不显示'
    ).toEqual([[false]])
  })

  it('菜单没开过就卸载时，release 不去踩开关（别复原一个自己没让过的位）', () => {
    // release 是无条件复原会踩坏别的菜单：一格 browser 上右键点开了 Tab 菜单（它自己拨了 true），
    // 与此同时这一格因别的原因卸载——若 release 无脑拨 false，会把 Tab 菜单那次让位提前复原，原生视图
    // 盖回 Tab 菜单。所以 release 只在**自己真欠着**一次复原时才动手。
    const setTabMenuOpen = vi.fn<(open: boolean) => void>()
    const menuYield = createRegionMenuYield(setTabMenuOpen)

    setTabMenuOpen.mockClear()
    menuYield.release()
    expect(setTabMenuOpen, '没让过位却复原了——会踩掉别的菜单的让位').not.toHaveBeenCalled()
  })

  it('已经正常关过之后再卸载，release 不再第二次拨——复原恰好一次', () => {
    // onOpenChange(false) 走过之后欠账已清，卸载时的 release 不该再拨一次（双重复原本身无害，但
    // 「恰好一次」是这条状态机的判据：欠账被 onOpenChange 清了，release 就该沉默）。
    const setTabMenuOpen = vi.fn<(open: boolean) => void>()
    const menuYield = createRegionMenuYield(setTabMenuOpen)
    menuYield.onOpenChange(true)
    menuYield.onOpenChange(false) // 正常关闭，欠账已清

    setTabMenuOpen.mockClear()
    menuYield.release()
    expect(setTabMenuOpen, '正常关过之后 release 不该再拨一次').not.toHaveBeenCalled()
  })

  it('开→关→再开之后卸载，release 仍要复原（欠账随最后一次开重新记上）', () => {
    // 状态机不能是「一次性」的：第二次打开又欠下一次复原，此时卸载必须补。写成布尔一次性闩会漏这条。
    const setTabMenuOpen = vi.fn<(open: boolean) => void>()
    const menuYield = createRegionMenuYield(setTabMenuOpen)
    menuYield.onOpenChange(true)
    menuYield.onOpenChange(false)
    menuYield.onOpenChange(true) // 再次打开，重新欠一次复原

    setTabMenuOpen.mockClear()
    menuYield.release()
    expect(setTabMenuOpen.mock.calls, '第二次打开后卸载，release 仍必须复原').toEqual([[false]])
  })
})

// ---------------------------------------------------------------------------
// 接线层：RegionContextMenu 真的把工厂接到了 Radix 的 Root 与卸载 effect 上。
//
// 上面几条钉的是工厂**自己**的状态机；但工厂算得对不代表组件真用上了它（extracting-to-lib-only-fixes-half）。
// 渲染 / effect 在本仓证不了（node 无 jsdom；renderToStaticMarkup 不跑 effect；Radix Portal 渲成空），
// 所以这一层读源码用 AST 判：ContextMenu.Root 的 onOpenChange 接的是工厂的 onOpenChange，且有一条以
// 工厂为依赖的卸载 effect 调 release。判据落在 AST 结构上而不是「文件里出现过这个名字」。
// ---------------------------------------------------------------------------
describe('RegionContextMenu 把让位工厂接到了 Root 与卸载 effect', () => {
  const source = readFileSync(
    new URL('../src/renderer/src/components/RegionContextMenu.tsx', import.meta.url),
    'utf8'
  )
  const ast = ts.createSourceFile('RegionContextMenu.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

  /** 那个持有工厂的变量名（`const X = createRegionMenuYield(...)` 或 `X = yieldRef.current`）。 */
  function yieldCarrierNames(): Set<string> {
    const names = new Set<string>()
    const walk = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer
      ) {
        const init = node.initializer.getText(ast)
        if (init.includes('createRegionMenuYield(') || init.includes('yieldRef.current')) {
          names.add(node.name.text)
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(ast)
    return names
  }

  it('自检：找得到持有让位工厂的那个变量', () => {
    // 找不到（重构/改名）时，下面的接线断言会以最难发现的方式恒绿。
    expect(
      [...yieldCarrierNames()],
      '找不到接住 createRegionMenuYield(...) 的变量——接线守卫会变成恒真'
    ).not.toHaveLength(0)
  })

  it('ContextMenu.Root 的 onOpenChange 接的就是工厂的 onOpenChange（不是缺席、不是别的东西）', () => {
    const carriers = yieldCarrierNames()
    let attribute: string | null = null
    const walk = (node: ts.Node): void => {
      const opening = ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) ? node : null
      if (opening && opening.tagName.getText(ast) === 'ContextMenu.Root') {
        for (const property of opening.attributes.properties) {
          if (ts.isJsxAttribute(property) && property.name.getText(ast) === 'onOpenChange') {
            const initializer = property.initializer
            attribute =
              initializer && ts.isJsxExpression(initializer) && initializer.expression
                ? initializer.expression.getText(ast)
                : (initializer?.getText(ast) ?? '<无值>')
          }
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(ast)

    expect(
      attribute,
      'ContextMenu.Root 没有 onOpenChange——菜单开合不再拨让位开关，原生视图盖住菜单（#544 原样）'
    ).not.toBeNull()
    // 值必须是「某个工厂载体」的 .onOpenChange，而不是别的函数或内联空壳。
    const matchesCarrier = [...carriers].some((name) => attribute === `${name}.onOpenChange`)
    expect(
      matchesCarrier,
      `onOpenChange 接的是 \`${attribute}\`，不是让位工厂的 onOpenChange（载体：${JSON.stringify([...carriers])}）`
    ).toBe(true)
  })

  it('有一条卸载 effect 调工厂的 release（兜住菜单开着就卸载那条路径）', () => {
    // 判据：某个 useEffect/useLayoutEffect 的**清理函数**里调了 `<载体>.release()`。清理函数按
    // 「effect 体返回的那个箭头/函数」找——release 必须在 return 的那个函数体里，而不是 effect 顶层
    // （那样会在挂载时就复原）。
    const carriers = yieldCarrierNames()
    let found = false
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'release' &&
        carriers.has(node.expression.expression.getText(ast))
      ) {
        // 它必须落在某个 effect 的返回函数里（清理阶段），而不是 effect 顶层。
        // 简化判据：release 调用的最内层箭头/函数不是 effect 的第一个实参本身，而是被 return 出去的。
        found = true
      }
      ts.forEachChild(node, walk)
    }
    walk(ast)
    expect(
      found,
      '没有任何地方调用让位工厂的 release()——菜单开着这一格被关掉时开关卡在 true，所有原生视图永久不显示'
    ).toBe(true)

    // 而且它得在一条**以工厂载体为依赖**的 effect 里，且是清理函数（源码上表现为 `() => carrier.release()`
    // 这种返回一个调 release 的函数的形状）。用文本判这一步足够：effect 体是 `() => () => menuYield.release()`。
    const cleanupReturnsRelease = [...carriers].some((name) =>
      new RegExp(`\\(\\)\\s*=>\\s*\\(\\)\\s*=>\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.release\\(\\)`).test(source)
    )
    expect(
      cleanupReturnsRelease,
      'release 不在清理函数里（写成 effect 顶层会在挂载时就复原，等于没接）——应形如 `() => () => menuYield.release()`'
    ).toBe(true)
  })

  it('工厂拿到的是 store 的 setTabMenuOpen（复用全仓唯一的让位 SSOT，不自造第二套）', () => {
    // 复用性是这次修复的核心（见 RegionContextMenu 顶部注释）：让位必须走 setTabMenuOpen，那是
    // WorkbenchTabContextMenu / Split 下拉 / PaneSplitMenu 都在拨的同一个开关。若这里改调别的
    // store action、或自己 setBounds，就是另造了一套让位机制，两套迟早漂移。
    const call = /createRegionMenuYield\(([^)]*)\)/.exec(source)?.[1] ?? ''
    expect(
      call.includes('setTabMenuOpen'),
      `createRegionMenuYield 拿到的不是 setTabMenuOpen 而是 \`${call}\`——没有复用全仓的让位 SSOT`
    ).toBe(true)
    // 且 setTabMenuOpen 确实来自 store 的 selector，不是本地新造的同名函数。
    expect(
      /useAppStore\(\s*\(state\)\s*=>\s*state\.setTabMenuOpen\s*\)/.test(source),
      'setTabMenuOpen 不是从 useAppStore 选出来的——没有接到真正驱动 nativeSurfacesVisible 的那个开关'
    ).toBe(true)
  })
})
