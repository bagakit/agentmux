// @vitest-environment happy-dom
import { act } from 'react'
import type { Editor } from '@tiptap/core'
import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerDOM } from './helpers/composer-dom-fixture'
import { allStyleRules } from './helpers/styles.js'

// 启动页 message tool 的三处布局缺陷（用户报告）：
//   D1 偏左——它没跟随 .launch-surface 的居中列。
//   D2 无法输入——可见框比可编辑区高，下沿是一片死区（CSS，不是 JS 只读）。
// 两处都锁在 `.launcher-composer` 这一条规则上，所以判据也从它反推，不维护手写清单。

const dom = composerDOM()

async function mountLauncher() {
  useAppStore.setState({
    tabs: { launcher: createWorkbenchTab('launcher', { regionId: 'region', kind: 'launcher', workspaceId: 'workspace' }) },
    activeWorkspaceId: 'workspace', agentComposerDrafts: { region: '' }
  })
  await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible={false} />)
}

function editor(): Editor {
  const element = dom.container.querySelector<HTMLElement & { editor: Editor }>('.tiptap')
  expect(element, '启动页没有渲染出可编辑的 .tiptap').not.toBeNull()
  expect(element!.editor).toBeDefined()
  return element!.editor
}

describe('D1: 启动页 message tool 与页面其余块同列居中', () => {
  const rules = [...allStyleRules().matchAll(/([^{}]*)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector!.trim(), body: body!
  }))

  it('.launcher-composer 显式 margin-inline:auto，把 .composer 侧向 margin 顶掉的居中还回来', () => {
    // .launch-surface > * 靠 margin-inline:auto 居中每个直接子元素；.composer 的 `margin:6px 8px`
    // 同特异度后加载，把它顶成左缘 8px。这条把居中夺回来，且只作用于启动页那一处。
    const launcher = rules.filter(({ selector }) => selector === '.launcher-composer')
    expect(launcher, '.launcher-composer 这条规则不在样式表里，下面的断言等于没跑').toHaveLength(1)
    expect(
      launcher[0]!.body,
      '.launcher-composer 没有 margin-inline:auto——.composer 的侧向 margin 会把 640px 框钉到左缘（偏左）'
    ).toContain('margin-inline: auto')
  })

  it('自检：这条居中规则确实排在 .composer 侧向 margin 之后，级联才轮得到它赢', () => {
    // 同特异度按层叠顺序后来者胜。.launcher-composer 与 .composer 都在 composer.css 里，
    // 前者必须出现在后者之后，否则即使写了 margin-inline:auto 也被 .composer 覆盖。
    const css = allStyleRules()
    const composerMargin = css.indexOf('.composer { position: relative; margin:')
    const launcherRule = css.indexOf('.launcher-composer {')
    expect(composerMargin, '.composer 的 margin 基础规则锚点没找到').toBeGreaterThan(-1)
    expect(launcherRule, '.launcher-composer 规则锚点没找到').toBeGreaterThan(-1)
    expect(launcherRule, '.launcher-composer 排在 .composer margin 之前，级联轮不到它').toBeGreaterThan(composerMargin)
  })

  it('这条规则真的挂在启动页那个元素上，且它是 .launch-surface 的直接子元素', async () => {
    // 上面两条只读样式表：类名从 JSX 上消失、或元素被挪进某层包裹 div，规则就整条失效，
    // 而它们照样全绿（本仓「零调用者检查」的 CSS 面）。这条从渲染出的 DOM 反着核。
    await mountLauncher()
    const node = dom.container.querySelector('.launcher-composer')
    expect(node, '渲染出的启动页里没有 .launcher-composer——样式表那条规则没有落点').not.toBeNull()
    expect(node!.classList.contains('composer'), '启动页这块没复用 .composer 表面样式').toBe(true)
    // margin-inline:auto 只对「靠 .launch-surface > * 拿到 width:min(640px,100%)」的那一层有效；
    // 多包一层 div 就会让宽度约束落在包裹层上，这条居中随之作废。
    expect(node!.parentElement?.classList.contains('launch-surface'),
      '.launcher-composer 不是 .launch-surface 的直接子元素——640px 列宽与居中都落不到它头上').toBe(true)
  })
})

describe('D2: 启动页 message tool 整个可见框都可编辑', () => {
  const rules = [...allStyleRules().matchAll(/([^{}]*)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector!.trim(), body: body!
  }))

  it('启动页的高度加在可编辑的 .tiptap 上（经 --composer-input-height），不撑高不可编辑的包裹层', () => {
    // 死区的来源：曾经 `.launcher-composer .composer__editor { min-height: 6em }` 撑高的是
    // .tiptap 外层那个不可编辑的包裹 div，而 .tiptap 只有一行高、不填满它——下沿一片点了没反应。
    // 修复：把高度给可编辑元素自己读的变量（.tiptap 在 `.composer__editor .tiptap` 里读 height:
    // var(--composer-input-height)），于是可见框就是可编辑区。
    const launcher = rules.filter(({ selector }) => selector === '.launcher-composer')
    expect(launcher, '.launcher-composer 规则不在样式表里').toHaveLength(1)
    expect(
      launcher[0]!.body,
      '.launcher-composer 没有设 --composer-input-height——可编辑区不会长到可见框的高度'
    ).toMatch(/--composer-input-height:\s*6rem/)
    // 单位必须在根字号上结算。这个变量在 .launcher-composer 上声明、却在 .tiptap 上消费，而
    // .tiptap 自己把字号压到 --fs-meta(11px)：em 在消费处结算会变成 66px，把 96px 的框改矮。
    expect(
      launcher[0]!.body,
      '--composer-input-height 用了 em——它在 font-size:11px 的 .tiptap 上结算，框会缩水'
    ).not.toMatch(/--composer-input-height:[^;]*\d(?<!r)em/)

    // 反面：不许有任何规则去撑高不可编辑的包裹层 .composer__editor（那正是死区）。
    // 按选择器落在 .composer__editor（而非其后代 .tiptap）上、且声明了 height/min-height 判。
    const wrapperInflaters = rules
      .filter(({ selector }) => /\.composer__editor\s*$/.test(selector))
      .filter(({ body }) => /(?:^|;)\s*(?:min-)?height:/.test(body))
      .map(({ selector, body }) => `${selector} { ${body.trim()} }`)
    expect(
      wrapperInflaters,
      '有规则撑高了不可编辑的 .composer__editor 包裹层——它下沿会留出点不动的死区'
    ).toEqual([])

    // 而基础规则确实让可编辑元素消费这个变量——否则上面设的变量没有落点，形同没设。
    const tiptap = rules.find(({ selector }) => selector === '.composer__editor .tiptap')
    expect(tiptap?.body, '.tiptap 没有读 --composer-input-height：启动页设了它也不会长高').toContain(
      'height: var(--composer-input-height, auto)'
    )
  })

  it('打字能落进草稿——输入不是死的（JS 侧回归护栏）', async () => {
    await mountLauncher()
    expect(dom.draft('region')).toBe('')
    // 经真实 TipTap 编辑器写入内容，走 onUpdate → onValueChange → launcherPromptBinding.set。
    await act(async () => { editor().commands.insertContent('查一下登录为什么 500') })
    expect(dom.draft('region'), '打进启动页 composer 的字没有回到草稿——输入是死的').toBe('查一下登录为什么 500')
    // 追加也要继续生效，证明不是一次性写入。
    await act(async () => {
      editor().commands.setTextSelection(editor().state.doc.content.size - 1)
      editor().commands.insertContent(' 现在')
    })
    expect(dom.draft('region')).toBe('查一下登录为什么 500 现在')
  })
})
