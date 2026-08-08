import { describe, expect, it, vi } from 'vitest'
import {
  contentSourceText,
  gatesAbove,
  inlineConditions,
  jsxContentElement,
  jsxContentElementIn,
  memberCallsIn
} from './helpers/jsx-menu-content.js'

// WorkbenchTabContextMenu 经 clipboard-copy 引到 api，api 在模块加载时判断宿主。先立起这个全局。
vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

// api.ui.writeClipboardText 是路径复制真正落地的地方；给它一个可断言的桩。
const clipboard = vi.hoisted(() => ({
  writeClipboardText: vi.fn(async (_text: string): Promise<void> => {})
}))
vi.mock('../src/renderer/src/lib/api.js', () => ({ api: { ui: clipboard } }))

import { createWorkbenchTabCopyModel } from '../src/renderer/src/components/WorkbenchTabContextMenu.js'
import { formatPathsForCopy } from '../src/renderer/src/lib/clipboard-copy.js'

// 文件 Tab 与 Agent Tab 共用一份 items 定义，按类型切。这组测试守两侧：
//   - 文件 Tab 才有路径复制 / 相对路径 / 「在文件管理器中显示」；agent Tab、无 file 时这三项必须缺席；
//   - 每一项点下去真的做对应的事（复制走共用出口、reveal 调传进来的回调），不是画个壳。
// 「该出现时出现」不够，还要守「不该出现时不出现」——本仓有过菜单项静默失效（不渲染而全绿）的先例。

const FILE = {
  path: 'src/app/main.ts',
  workspaceRoot: '/w/repo',
  revealLabel: 'Reveal in Finder',
  onReveal: async () => {}
}

function fileEntries(agentSessionId: string | null = null) {
  return createWorkbenchTabCopyModel({
    tabId: 'view:x',
    agentSessionId,
    file: FILE,
    writeClipboardText: vi.fn(async () => {})
  }).entries
}

function labelsOf(entries: ReturnType<typeof fileEntries>): string[] {
  return entries.flatMap((entry) => (entry.kind === 'action' ? [entry.action.label] : []))
}

describe('文件 Tab 菜单：路径复制与在文件管理器中显示', () => {
  it('文件 Tab 有三项文件动作，且顺序在地址之后', () => {
    const labels = labelsOf(fileEntries())
    expect(labels).toEqual([
      'Copy View Address',
      'Copy Path',
      'Copy Relative Path',
      'Reveal in Finder'
    ])
  })

  it('非文件 Tab（无 file）三项文件动作全部缺席——不该出现时不出现', () => {
    const model = createWorkbenchTabCopyModel({
      tabId: 'view:x',
      agentSessionId: 'agent-7',
      writeClipboardText: vi.fn(async () => {})
    })
    const labels = model.entries.flatMap((entry) => (entry.kind === 'action' ? [entry.action.label] : []))
    expect(labels).not.toContain('Copy Path')
    expect(labels).not.toContain('Copy Relative Path')
    // 按 id 判，不按文案：reveal 的文案跟平台走，拿任一平台的说法当判据会在别的平台上恒真。
    const ids = model.entries.flatMap((entry) => (entry.kind === 'action' ? [entry.action.id] : []))
    expect(ids).not.toContain('reveal')
    // 直接读字段也不许在场——不是只在清单里缺席，模型里根本没有。
    expect(model.copyPath).toBeUndefined()
    expect(model.copyRelativePath).toBeUndefined()
    expect(model.reveal).toBeUndefined()
  })

  it('复制绝对路径：把 path 接到 workspaceRoot 上，走共用出口', async () => {
    const writeClipboardText = vi.fn(async (_text: string) => {})
    const model = createWorkbenchTabCopyModel({
      tabId: 'view:x',
      agentSessionId: null,
      file: FILE,
      writeClipboardText
    })
    await model.copyPath?.onSelect()
    // 期望值锚成写死字面量，不由被测函数自己算。
    expect(writeClipboardText).toHaveBeenCalledWith('/w/repo/src/app/main.ts')
    // 且与共用格式化出口逐字一致（改出口格式两处一起红）。
    expect(writeClipboardText).toHaveBeenCalledWith(
      formatPathsForCopy(['src/app/main.ts'], 'absolute', '/w/repo')
    )
  })

  it('复制相对路径：原样，绝不误用绝对分支', async () => {
    const writeClipboardText = vi.fn(async (_text: string) => {})
    const model = createWorkbenchTabCopyModel({
      tabId: 'view:x',
      agentSessionId: null,
      file: FILE,
      writeClipboardText
    })
    await model.copyRelativePath?.onSelect()
    expect(writeClipboardText).toHaveBeenCalledWith('src/app/main.ts')
    // 绝对/相对搞反会复制成 /w/repo/... ——钉死它不会。
    expect(writeClipboardText).not.toHaveBeenCalledWith('/w/repo/src/app/main.ts')
  })

  it('「在文件管理器中显示」点下去调传进来的 onReveal，而不是复制', async () => {
    const onReveal = vi.fn(async () => {})
    const writeClipboardText = vi.fn(async () => {})
    const model = createWorkbenchTabCopyModel({
      tabId: 'view:x',
      agentSessionId: null,
      file: { ...FILE, onReveal },
      writeClipboardText
    })
    await model.reveal?.onSelect()
    expect(onReveal).toHaveBeenCalledTimes(1)
    // reveal 不碰剪贴板——把 onSelect 接错成复制会让它写剪贴板。
    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it('reveal 的文案跟平台走：label 就是组件算出来的那句，没有第二个字段兜底', () => {
    const model = createWorkbenchTabCopyModel({
      tabId: 'view:x',
      agentSessionId: null,
      file: { ...FILE, revealLabel: 'Reveal in File Explorer' },
      writeClipboardText: vi.fn(async () => {})
    })
    // id 是稳定键，label 是画出来的字——两者不再兼任对方。
    //
    // 这里刻意用 Windows 的说法作 fixture：曾经的形状是「label 联合值恒为中性的
    // 'Reveal in File Manager'，displayLabel 可选覆盖」，于是漏传 displayLabel 在 mac 上看不出
    // 毛病（掉回的中性值恰好是 Linux 正确文案），只在 Windows 上说错话。拿 Windows 的说法当
    // 期望值，"文案没被传下去"这一类回归就一定红。
    expect(model.reveal?.id).toBe('reveal')
    expect(model.reveal?.label).toBe('Reveal in File Explorer')
  })

  it('文件 Tab 同时承载唯一 Agent 时，两类动作各自都在（按类型切，不是二选一）', () => {
    const labels = labelsOf(fileEntries('agent-7'))
    // agent 侧
    expect(labels).toContain('Message this Agent')
    expect(labels).toContain('Copy Session Address')
    // file 侧
    expect(labels).toContain('Copy Path')
    expect(labels).toContain('Reveal in Finder')
  })

  it('清单里每一项都真的点得动，且复制项复制到共用出口', async () => {
    // 派生出来的可能是个壳：label 对、onSelect 是别项的或空函数。逐项点一遍看落到哪。
    const writeClipboardText = vi.fn(async (_text: string) => {})
    const onReveal = vi.fn(async () => {})
    const model = createWorkbenchTabCopyModel({
      tabId: 'view:x',
      agentSessionId: null,
      file: { ...FILE, onReveal },
      writeClipboardText
    })
    const expectedCopy = new Map<string, string>([
      ['Copy View Address', 'AgentMux View view:x'],
      ['Copy Path', '/w/repo/src/app/main.ts'],
      ['Copy Relative Path', 'src/app/main.ts']
    ])
    let clicked = 0
    for (const entry of model.entries) {
      if (entry.kind !== 'action') continue
      writeClipboardText.mockClear()
      onReveal.mockClear()
      await entry.action.onSelect()
      if (entry.action.id === 'reveal') {
        expect(onReveal, 'reveal 点下去没调 onReveal').toHaveBeenCalledTimes(1)
      } else {
        const expected = expectedCopy.get(entry.action.label)
        // 缺 key 时用一个绝不可能出现在剪贴板文本里的值，让「上面那张表漏了一项」当场红，而不是
        // 拿 undefined 去 toContain（那会变成一句恒真的断言）。
        //
        // 不要用 NUL（`'\0never\0'`）：它确实不可能出现，但两个 NUL 字节会让 git 把整个文件判成
        // binary，`git grep` 从此对本文件完全失明——本仓有多道扫描（参考项目名泄漏、随平台变化的
        // 文案产地）走 git grep，一个被判成 binary 的测试文件是它们共同的盲点。
        expect(writeClipboardText.mock.calls[0]?.[0], `${entry.action.label} 点下去落点不对`).toContain(
          expected ?? '<no expectation registered for this label>'
        )
      }
      clicked += 1
    }
    // 扫描式断言自证扫到了东西：空清单的 for 永远绿。
    expect(clicked).toBe(model.entries.length)
  })
})

// ---------------------------------------------------------------------------
// 渲染层：这一组菜单项在不在场，只能由数据决定。
//
// 判据形状换过一次，换的理由记在这里。旧判据是
//
//     const content = withoutComments.slice(indexOf('<ContextMenu.Content'), indexOf('</ContextMenu.Content>'))
//     expect(content).toContain('copyModel.entries.map(')
//
// 「那行字面量在场」不等于「那次 map 画得出来」：`{false && copyModel.entries.map((entry) => {`
// 让整组复制 / 地址 / 「在文件管理器中显示」从 Tab 右键菜单上彻底消失，而这个文件 11 条全绿
// （实测过，不是推演）。同一族的旧账还有 `indexOf` 猜左右界——截错了与没违规在结果上同形。
//
// 兄弟文件 workbench-tab-actions.test.ts 守的是另外两个容器，那边的判据是「这段 Content 里
// **一个内联条件都没有**」。那条不能照搬过来：这个 Content 里有一处**合法**的条件——
// `{onRenameAgent ? (<ContextMenu.Item …>Rename Agent</ContextMenu.Item>) : null}`，因为
// 「这张 View 恰好承载唯一一个 Agent」时才给改 Agent 名。照搬会把诚实的代码判红，而一道会打
// 假红的守卫最终会被删掉，等于没有。
//
// 所以判据收窄成**这一次调用**头上没有门：`copyModel.entries.map(…)` 与 Content 之间不许有
// 任何条件、任何新包的函数壳。想让某一项消失只能改 entries——那份数组跑得到、断言得着，
// 上面那一族测试就在断言它。
// ---------------------------------------------------------------------------
describe('JSX 里没有可以取反的在场判断', () => {
  const CONTENT = { file: 'WorkbenchTabContextMenu.tsx', tag: 'ContextMenu', list: 'copyModel' } as const
  const jsx = jsxContentElement(CONTENT.file, CONTENT.tag)
  const content = contentSourceText(jsx)

  it('自检：真的取到了那段 JSX，且它确实在画菜单项', () => {
    expect(content).toContain(`${CONTENT.tag}.Item`)
  })

  it('复制/地址那组画的就是 copyModel.entries，且整段只画这一份', () => {
    const calls = memberCallsIn(jsx, `${CONTENT.list}.entries`, 'map')
    expect(calls.length, '找不到 copyModel.entries.map( ——这一组要么换了清单来源，要么自己列了一遍').toBe(1)
    // 标签取自清单元素，不能是写死的字面量（写死了就等于自绘项，改 entries 不再影响画出来的字）。
    expect(content, '项标签不是取自清单元素').toMatch(/\{entry[\w.]*\.label\}/)
  })

  it('那次 map 头上没有门——想让这一组消失只能改 entries，改不了 JSX', () => {
    const [call] = memberCallsIn(jsx, `${CONTENT.list}.entries`, 'map')
    expect(call, '前提自检：调用点都没找到，判据挂在空处').toBeDefined()
    expect(
      gatesAbove(call!, jsx),
      '这次 map 被一个渲染层条件挡着——整组复制/地址可以被它取反成永不出现'
    ).toEqual([])
  })

  it('那处合法的条件仍然合法：判据不禁止 Content 里有条件，只禁止那次 map 头上有', () => {
    // 兄弟文件那条「一个条件都没有」的判据搬过来会把这里判红。钉住这个差异本身：
    // 这个 Content 里**确实**有内联条件（Rename Agent 按可选回调在场与否决定画不画），
    // 而上一条仍然绿。哪天有人把判据「统一」成禁止一切条件，这条会当场提醒他代价是什么。
    expect(
      inlineConditions(jsx).length,
      '这个 Content 里的合法条件没有了——那上一条判据就该收紧成兄弟文件那种全禁式'
    ).toBeGreaterThan(0)
    expect(content, '合法条件不再是 Rename Agent 那处了，重新判一遍这条注释还成不成立').toContain(
      'onRenameAgent ?'
    )
  })

  it('自检：门检测器认得取反用的那几种形状，也不把合法取值误当门', () => {
    // 没有这条，检测器写坏会让整族静默变恒绿——「没找到门」与「认不出门」在结果上同形。
    const gatesInProbe = (body: string): string[] => {
      const probe = jsxContentElementIn(
        `const X = () => (<ContextMenu.Content>${body}</ContextMenu.Content>)`,
        'probe.tsx',
        'ContextMenu'
      )
      expect(probe, '探针源码里取不到 Content——自检本身是坏的').not.toBeNull()
      const [call] = memberCallsIn(probe!, 'm.entries', 'map')
      expect(call, '探针里找不到那次 map——自检本身是坏的').toBeDefined()
      return gatesAbove(call!, probe!)
    }
    // 该拒：这四种都能在「那行字面量原样在场」的前提下把整组抹掉。
    // React 把 false/null/undefined 渲染成什么都没有，所以调用落在门的哪一侧都不安全。
    expect(gatesInProbe('{false && m.entries.map((e) => <I />)}'), '认不出 && 门').not.toEqual([])
    expect(gatesInProbe('{ok ? m.entries.map((e) => <I />) : null}'), '认不出三元门').not.toEqual([])
    expect(gatesInProbe('{m.entries.map((e) => <I />) && false}'), '认不出「调用在左、门在右」').not.toEqual([])
    expect(gatesInProbe('{other ?? m.entries.map((e) => <I />)}'), '认不出 ?? 替换').not.toEqual([])
    expect(
      gatesInProbe('{(() => { if (hide) return null; return m.entries.map((e) => <I />) })()}'),
      '认不出新包的函数壳里那个 if'
    ).not.toEqual([])
    // 该放：无条件的那次 map，以及它自己回调里的取值与按数据分支。
    // 回调是这次调用的实参（在它下面），不是祖先——把回调里的东西当成门会打假红。
    expect(gatesInProbe('{m.entries.map((e) => <I />)}'), '把无条件的 map 判成有门').toEqual([])
    expect(
      gatesInProbe('{m.entries.map((e) => <I>{e.action?.label ?? e.label}</I>)}'),
      '把回调里的 ?. / ?? 取值误当成门'
    ).toEqual([])
    expect(
      gatesInProbe('{m.entries.map((e) => { if (e.kind === "sep") return null; return <I /> })}'),
      '把 map 回调里按数据分支的 if 误当成整组的门'
    ).toEqual([])
    // 该放：同一段里别处的条件不算这次调用的门（本文件真实形状：Rename Agent 那处）。
    expect(
      gatesInProbe('{cb ? <I /> : null}{m.entries.map((e) => <I />)}'),
      '把兄弟节点上的条件算成了这次调用的门——那会把合法代码判红'
    ).toEqual([])
    // receiver 逐字比对：换一份清单不能仍被认成同一次调用。
    expect(
      memberCallsIn(
        jsxContentElementIn(
          'const X = () => (<ContextMenu.Content>{m.entries.slice(0, 0).map((e) => <I />)}</ContextMenu.Content>)',
          'probe.tsx',
          'ContextMenu'
        )!,
        'm.entries',
        'map'
      ).length,
      '把 m.entries.slice(0,0).map( 认成了 m.entries.map('
    ).toBe(0)
  })

  it('渲染层碰不到那几个可选字段——没有字段可判，也就没有条件可取反', () => {
    // `{copyModel.sessionAddress ? (` 一旦回来，`{false && copyModel.sessionAddress ? (` 就又能
    // 在全绿之下把那一项从界面上抹掉。渲染只认 entries，在场与顺序在数据侧决定、上面几条真跑得到。
    for (const field of [
      'copyModel.handoff',
      'copyModel.sessionAddress',
      'copyModel.copyPath',
      'copyModel.copyRelativePath',
      'copyModel.reveal'
    ]) {
      expect(content, `${field} 又被渲染层直接读了`).not.toContain(field)
    }
  })
})
