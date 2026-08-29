import { describe, expect, it, vi } from 'vitest'
import {
  callbackErasureGates,
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
import { applyCopyPathStyle } from '../src/renderer/src/lib/copy-path-display.js'

// 文件 Tab 与 Agent Tab 共用一份 items 定义，按类型切。这组测试守两侧：
//   - 文件 Tab 才有路径复制 / 相对路径 / 「在文件管理器中显示」；agent Tab、无 file 时这三项必须缺席；
//   - 每一项点下去真的做对应的事（复制走共用出口、reveal 调传进来的回调），不是画个壳。
// 「该出现时出现」不够，还要守「不该出现时不出现」——本仓有过菜单项静默失效（不渲染而全绿）的先例。

/**
 * 这份夹具此前缺 `home` 与 `copyPathsAsAbsolute` 两个字段，于是**整个家目录缩写档在这里从未被跑过**。
 *
 * 它不是「少写两个字段」那么无害：`WorkbenchTabFileActions` 在 d382e520 长出这两个字段后，Copy Path
 * 就会走 `applyCopyPathStyle`，而缺字段时 `home` 是 `undefined`、`abbreviateHomePath` 第一句
 * `if (!home) return path` 直接原样返回——**测试断言的正是那个未缩写的值，所以它因为字段缺失而绿**。
 * tsc 一直在报 TS2739 点名这两个字段，但 desktop 的 `tsc -p tsconfig.json` 只含 `src/**`，
 * 测试树的类型错误靠 type-tree-typecheck 的棘轮兜着，而它当时正红着。
 *
 * `workspaceRoot` 放进 home 之下，是为了让缩写档真的有东西可缩——两条判据（缩写生效、选了绝对路径
 * 时不缩写）在下面各有一个 `it`。
 */
const HOME = '/w'

const FILE = {
  path: 'src/app/main.ts',
  workspaceRoot: '/w/repo',
  revealLabel: 'Reveal in Finder',
  onReveal: async () => {},
  home: HOME,
  copyPathsAsAbsolute: undefined
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

  it('复制绝对路径：把 path 接到 workspaceRoot 上，再按默认档缩写家目录', async () => {
    const writeClipboardText = vi.fn(async (_text: string) => {})
    const model = createWorkbenchTabCopyModel({
      tabId: 'view:x',
      agentSessionId: null,
      file: FILE,
      writeClipboardText
    })
    await model.copyPath?.onSelect()
    // 期望值锚成写死字面量，不由被测函数自己算。`~/repo/...` 而不是 `/w/repo/...`：默认档
    // （`copyPathsAsAbsolute` 未选）要把本机 home 缩成 `~`。此前夹具缺 `home`，这一步被跳过，
    // 断言写的是未缩写的值——测试因为字段缺失而绿，缩写这一整档从来没被跑到过。
    expect(writeClipboardText).toHaveBeenCalledWith('~/repo/src/app/main.ts')
    // 且与两个共用出口逐字一致（改格式化或改缩写规则，两处一起红）。
    expect(writeClipboardText).toHaveBeenCalledWith(
      applyCopyPathStyle(formatPathsForCopy(['src/app/main.ts'], 'absolute', '/w/repo'), {
        home: HOME,
        copyPathsAsAbsolute: undefined
      })
    )
  })

  it('用户选了绝对路径时不缩写——这一档与上一条互为对照', async () => {
    const writeClipboardText = vi.fn(async (_text: string) => {})
    const model = createWorkbenchTabCopyModel({
      tabId: 'view:x',
      agentSessionId: null,
      file: { ...FILE, copyPathsAsAbsolute: true },
      writeClipboardText
    })
    await model.copyPath?.onSelect()
    expect(writeClipboardText).toHaveBeenCalledWith('/w/repo/src/app/main.ts')
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
      ['Copy Path', '~/repo/src/app/main.ts'],
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
// 判据形状换过两次，理由都记在这里。最初是
//
//     const content = withoutComments.slice(indexOf('<ContextMenu.Content'), indexOf('</ContextMenu.Content>'))
//     expect(content).toContain('copyModel.entries.map(')
//
// 「那行字面量在场」不等于「那次 map 画得出来」：`{false && copyModel.entries.map((entry) => {`
// 让整组复制 / 地址 / 「在文件管理器中显示」从 Tab 右键菜单上彻底消失，而这个文件全绿
// （实测过，不是推演）。同一族的旧账还有 `indexOf` 猜左右界——截错了与没违规在结果上同形。
//
// 第二版把判据落在 `gatesAbove`：「这一次调用与 Content 之间的祖先里，出现三元 / && / || / ?? / if /
// 函数边界就算门」。一次独立审计证明这个**黑名单**必漏（本仓反复踩到的老坑：禁止清单守卫必漏）。
// 四种把整组抹掉、却全绿的写法：
//   - `{void copyModel.entries.map(…)}`        —— 求值成 undefined（实测 14 绿）
//   - `{(copyModel.entries.map(…), null)}`     —— 逗号表达式取最后一个值 null（实测 14 绿）
//   - `{!copyModel.entries.map(…)}`            —— 数组取反成 false（实测 14 绿）
//   - 回调**内部**首行 `if (true) return null`  —— 每一项都成空，而 map 头上一道门都没有（实测 14 绿）
// 前三种祖先扫描的黑名单里没有；第四种祖先扫描根本够不着——回调是 map 的实参，住在调用节点之下。
//
// 所以判据翻了个面（helper 的 docstring 记着为什么）：
//   - `gatesAbove` 改成**白名单**——调用到 Content 之间只准出现「把表达式塞进 JSX」的那几层无害包装，
//     别的一律算门。不必再枚举坏拼法，`void` / `!` / 逗号 / 未来某种没见过的写法都一并挡住。
//   - `callbackErasureGates` 单独判回调体，把「按数据跳过某些项」（`if (entry.kind === …) return null`，
//     合法）与「无条件 / 按渲染层开关抹掉整组」（`if (true) return null`、`return null`，门）分开。
//
// 兄弟文件 workbench-tab-actions.test.ts 守的是另外两个容器，那边的判据是「这段 Content 里
// **一个内联条件都没有**」。那条不能照搬过来：这个 Content 里有一处**合法**的条件——
// `{onRenameAgent ? (<ContextMenu.Item …>Rename Agent</ContextMenu.Item>) : null}`，因为
// 「这张 View 恰好承载唯一一个 Agent」时才给改 Agent 名。照搬会把诚实的代码判红，而一道会打
// 假红的守卫最终会被删掉，等于没有。
//
// 所以判据收窄成**这一次调用**头上没有门、且回调也不会把整组抹掉：想让某一项消失只能改 entries——
// 那份数组跑得到、断言得着，上面那一族测试就在断言它。
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

  it('那次 map 的回调不会把整组抹掉——回调里只许按数据画，不许无条件 / 按渲染层开关吐 null', () => {
    // gatesAbove 看的是调用头上；这一条看的是调用底下的回调体。审计里最真实的绕法就在这里：
    // `{copyModel.entries.map((entry) => { if (true) return null; … })}` 头上一道门都没有、字面量
    // 原样在场、14 条全绿，而每一项都成空。回调恰恰是有人自然会加逐项逻辑的地方。
    const [call] = memberCallsIn(jsx, `${CONTENT.list}.entries`, 'map')
    expect(call, '前提自检：调用点都没找到，判据挂在空处').toBeDefined()
    expect(
      callbackErasureGates(call!, jsx),
      '这次 map 的回调会把整组渲染成空——整组复制/地址可以被它抹成永不出现'
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

  // 自检：门检测器自己也得受质询。没有这些，检测器写坏会让整族静默变恒绿——「没找到门」与
  // 「认不出门」在结果上同形。逐形状喂它，一行一个判据（挤进一个 it 里，第一条红了后面全成死代码）。
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
  const callbackGatesInProbe = (body: string): string[] => {
    const probe = jsxContentElementIn(
      `const X = () => (<ContextMenu.Content>${body}</ContextMenu.Content>)`,
      'probe.tsx',
      'ContextMenu'
    )
    expect(probe, '探针源码里取不到 Content——自检本身是坏的').not.toBeNull()
    const [call] = memberCallsIn(probe!, 'm.entries', 'map')
    expect(call, '探针里找不到那次 map——自检本身是坏的').toBeDefined()
    return callbackErasureGates(call!, probe!)
  }

  // 该拒（gatesAbove）：这些都能在「那行字面量原样在场」的前提下把整组抹掉。React 把
  // false/null/undefined 渲染成什么都没有，所以调用落在门的哪一侧、被什么算符裹着都不安全。
  // 白名单判据的好处：这四种审计新发现的绕法（void / ! / 逗号 / 落在 .filter 上）不必逐一枚举，
  // 「不是那几层无害的 JSX 包装」这一条把它们与将来没见过的写法一并挡住。
  it.each([
    ['&& 门（调用在右）', '{false && m.entries.map((e) => <I />)}'],
    ['三元门', '{ok ? m.entries.map((e) => <I />) : null}'],
    ['调用在左、门在右', '{m.entries.map((e) => <I />) && false}'],
    ['?? 替换', '{other ?? m.entries.map((e) => <I />)}'],
    ['|| 短路', '{true || m.entries.map((e) => <I />)}'],
    ['新包的函数壳里那个 if', '{(() => { if (hide) return null; return m.entries.map((e) => <I />) })()}'],
    ['void 求值成 undefined（审计 B-1）', '{void m.entries.map((e) => <I />)}'],
    ['逻辑取反成 false（审计 B-4）', '{!m.entries.map((e) => <I />)}'],
    ['逗号表达式取末值 null（审计 B-2）', '{(m.entries.map((e) => <I />), null)}'],
    ['渲染层再 .filter 一遍', '{m.entries.map((e) => <I />).filter(Boolean)}']
  ])('自检·gatesAbove 认得取反用的形状：%s', (_label, body) => {
    expect(gatesInProbe(body), '这种取反形状没被认成门').not.toEqual([])
  })

  // 该放（gatesAbove）：无条件的那次 map、它自己回调里的取值、以及兄弟节点上的条件。白名单一收窄
  // 就会误伤这些诚实写法，而一道打假红的守卫最终会被删掉——所以每一处放宽都配一个 ALLOW 侧探针。
  it.each([
    ['无条件的 map', '{m.entries.map((e) => <I />)}'],
    ['回调里的 ?. / ?? 取值', '{m.entries.map((e) => <I>{e.action?.label ?? e.label}</I>)}'],
    ['回调里按数据分支的 if', '{m.entries.map((e) => { if (e.kind === "sep") return null; return <I /> })}'],
    ['裹进一层 Fragment', '<>{m.entries.map((e) => <I />)}</>'],
    ['纯分组括号', '{(m.entries.map((e) => <I />))}'],
    ['兄弟节点上的条件（本文件真实形状：Rename Agent）', '{cb ? <I /> : null}{m.entries.map((e) => <I />)}']
  ])('自检·gatesAbove 不把合法写法误当门：%s', (_label, body) => {
    expect(gatesInProbe(body), '合法写法被判成了门——这会把诚实代码判红').toEqual([])
  })

  // 该拒（callbackErasureGates）：回调无条件、或按渲染层开关（不是按当前项）把整组吐成空。
  it.each([
    ['首行 if(true) return null（审计 B-3）', '{m.entries.map((e) => { if (true) return null; return <I /> })}'],
    ['按外部开关 if(hide) return null', '{m.entries.map((e) => { if (hide) return null; return <I /> })}'],
    ['无条件 return null', '{m.entries.map((e) => { return null })}'],
    ['简写体直接 null', '{m.entries.map((e) => null)}'],
    ['简写体按外部开关三元吐 null', '{m.entries.map((e) => hide ? null : <I />)}'],
    ['外层非数据 if 包着数据 if', '{m.entries.map((e) => { if (hide) { if (e.kind) return null } return <I /> })}']
  ])('自检·callbackErasureGates 认得回调里抹除整组的形状：%s', (_label, body) => {
    expect(callbackGatesInProbe(body), '这种回调抹除形状没被认成门').not.toEqual([])
  })

  // 该放（callbackErasureGates）：按当前项数据跳过某些项、或只是决定某一项长什么样，都合法。
  it.each([
    ['按 entry.kind 跳过分隔项', '{m.entries.map((e) => { if (e.kind === "sep") return null; return <I /> })}'],
    ['按当前项简写三元', '{m.entries.map((e) => e.hidden ? null : <I />)}'],
    ['两个分支都渲染（不抹除）', '{m.entries.map((e) => cond ? <A /> : <B />)}'],
    ['按 index 跳过首项', '{m.entries.map((e, i) => { if (i === 0) return null; return <I /> })}'],
    ['嵌套数据 if 都引用当前项', '{m.entries.map((e) => { if (e.a) { if (e.b) return null } return <I /> })}'],
    ['某一项的 onSelect 里 return null 不算', '{m.entries.map((e) => <I onSelect={() => { return null }} />)}']
  ])('自检·callbackErasureGates 不把按数据分支误当门：%s', (_label, body) => {
    expect(callbackGatesInProbe(body), '按数据分支被判成了门——这会把诚实代码判红').toEqual([])
  })

  it('自检：receiver 逐字比对——换一份清单不能仍被认成同一次调用', () => {
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
