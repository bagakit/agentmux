import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 切回一个已经打开过的终端，不该再看到 "Restoring terminal…"。
 *
 * 用户的说法是："现在切换是都会 restoring terminal, 但是 orca 就不会, 可以看看差距在哪儿"。
 * 差距是一个决定：把"不可见"实现为"不渲染"，还是实现为"渲染但隐藏"。前者切走即卸载整棵
 * 子树，xterm 实例随之销毁，切回时只能从头重放全部 scrollback——恢复态不是慢，是必然发生。
 *
 * 所以这里断言的是那个决定本身，而不是恢复态出现得快不快：实例活着，就没有东西需要恢复。
 * 这类结构约束一旦回退，任何行为测试都不会变红（画面仍然正确，只是每次都重放一遍），
 * 必须显式钉住。
 */
const workbench = readFileSync(
  new URL('../src/renderer/src/components/WorkspaceWorkbench.tsx', import.meta.url),
  'utf8'
)
const styles = readFileSync(
  new URL('../src/renderer/src/styles.css', import.meta.url),
  'utf8'
)
const terminalView = readFileSync(
  new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url),
  'utf8'
)

/** pane-body 那段 JSX——所有 Tab 的内容都在这里决定要不要进 DOM。 */
function paneBody(): string {
  const open = workbench.indexOf('<div className="pane-body">')
  expect(open).toBeGreaterThan(-1)
  return workbench.slice(open, workbench.indexOf('<ConfirmationDialog', open))
}

describe('隐藏的 Tab 保住终端实例', () => {
  it('每个 Tab 都渲染进 DOM，而不是只挂活动的那个', () => {
    const body = paneBody()
    expect(body).toContain('tabs.map(')
    // 这是回退的确切形状：只把 activeTab 挂进去。
    expect(body).not.toContain('{activeTab ? (')
    expect(body).not.toContain('tab={activeTab}')
  })

  it('活动与否只改一个属性，不改渲染与否', () => {
    const body = paneBody()
    expect(body).toContain("data-active={tab.id === group.activeTabId ? 'true' : 'false'}")
  })

  it('隐藏格退出可交互树：不该被 Tab 键走到', () => {
    expect(paneBody()).toContain('inert={tab.id !== group.activeTabId}')
  })

  it('隐藏用 visibility 而不是 display:none——后者量不到尺寸，切回要多 fit 一帧', () => {
    const hidden = styles.match(/\.pane-body__region\[data-active="false"\]\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(hidden).toContain('visibility: hidden')
    expect(hidden).not.toContain('display: none')
  })

  it('隐藏格叠放在活动格之上，不参与布局——留在流里会把活动格挤变形', () => {
    const region = styles.match(/\.pane-body__region\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(region).toContain('position: absolute')
    expect(region).toContain('inset: 0')
    expect(styles.match(/\.pane-body\s*\{([^}]*)\}/)?.[1] ?? '').toContain('position: relative')
  })
})

describe('保住实例的代价必须为零', () => {
  it('看不见的格子里，终端与原生表面一并停工', () => {
    expect(paneBody()).toContain(
      'nativeSurfacesVisible={nativeSurfacesVisible && tab.id === group.activeTabId}'
    )
  })

  it('可见性一路传到终端，而不是半路断掉', () => {
    expect(workbench).toContain('visible={nativeSurfacesVisible}')
    const sessionPane = readFileSync(
      new URL('../src/renderer/src/components/SessionPane.tsx', import.meta.url),
      'utf8'
    )
    expect(sessionPane).toContain('visible={visible}')
    expect(terminalView).toContain('viewportRef.current?.setVisible(visible)')
  })

  it('终端建起来时就带着当前可见性，而不是先按可见跑一帧再纠正', () => {
    expect(terminalView).toContain('viewport.setVisible(visibleRef.current)')
  })
})

/**
 * 消掉的是"每次切换都重放"，不是恢复态本身。
 *
 * 真的没有内容可显示时——首次 attach、断连重连、replay 有缺口——仍然要如实说正在恢复。
 * 把恢复态一并删掉会更"干净"，但那是拿谎报换安静：用户会盯着一个空白终端不知道在等什么。
 */
describe('真正需要重放时，恢复态仍然出现', () => {
  it('恢复态的判据没有被可见性污染——它不需要知道隐藏这回事', () => {
    const startup = readFileSync(
      new URL('../src/renderer/src/lib/terminal-startup.ts', import.meta.url),
      'utf8'
    )
    expect(startup).toContain('if (input.hydrating) return \'restoring\'')
    expect(startup).not.toContain('visible')
  })

  it('首次 attach 仍从 hydrating 起步', () => {
    expect(terminalView).toContain('useState(true)')
    // attach effect 一开头重新置真：这条保证重连与换 Run 都重新走恢复态。
    expect(terminalView).toContain('setHydrating(true)')
  })

  it('replay 缺口仍有它自己的补救路径，没有被顺手删掉', () => {
    expect(terminalView).toContain('requestContentRedraw')
  })
})

describe('实例的存活边界等于 Region 的存活边界', () => {
  it('关掉 Region 就销毁实例，不进任何缓存池', () => {
    // 缓存池会造出第二套终端生命周期：谁回收、何时回收都无人负责，且与 Region 是 SSOT
    // 这件事直接冲突。实例只跟着它所在的 Region 活，关了就没了。
    expect(terminalView).toContain('terminal.dispose()')
    const source = workbench + terminalView
    for (const smell of ['instancePool', 'terminalPool', 'keepAlive', 'parkedTerminals']) {
      expect(source).not.toContain(smell)
    }
  })

  it('隐藏不新增常驻定时器或监听', () => {
    // 隐藏只翻一个属性；任何 setInterval/新 observer 都是持续开销，开十个 Tab 就是十份。
    const body = paneBody()
    expect(body).not.toContain('setInterval')
    expect(body).not.toContain('new ResizeObserver')
    expect(body).not.toContain('IntersectionObserver')
  })
})
