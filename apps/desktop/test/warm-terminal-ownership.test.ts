import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// store.ts 经 api.ts 读一个 build-time define；在 vitest 下没有 electron，所以按邻居测试的做法
// 先把它钉成 web preview（mock api），否则 import 期就 ReferenceError。
vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AppConfig, SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts.js'
import { warmLauncherId, warmTerminalPreview } from '../src/renderer/src/lib/warm-terminal-preview.js'
import { useAppStore, warmTerminalKey } from '../src/renderer/src/store.js'

// ---------------------------------------------------------------------------
// 热终端槽的归属（#308）。
//
// 槽是**全局单个**而 launcher 是**每个挂载点一个**。分屏能在同一个 Tab 里开出好几个，空分组占位又能
// 在每个 group 里各有一个，它们的 warmKey 逐字相同（同 host 同 cwd），所以「这个槽是不是我的」只判
// key 是判不出来的。
//
// 只判 key 时每个 launcher 都会把一个 TerminalView 挂到同一个 run 上，而 attach 那一侧**不报错**：
// 同一个 session 快照算出同一个 control identity，第二次 attach 走 readRunReplay 而不是「owner 已存在」
// 那条抛出。所以整条路径零信号——但两个 view 各有自己的 FitAddon 与 ResizeObserver，尺寸不同就对着
// 同一个 PTY 轮流 resize，网格来回跳，两边的 xterm 都在错的行列上重排。
//
// 归属键必须**永远在场**。此前取的是 regionId，而空分组占位没有 region——「没有 regionId 就不显示
// 预览」把新建 workspace 的第一眼（最主要那条路径）永久降级成冷卡片，new-tab-resource-contract 当场
// 打红。现在由 warmLauncherId 从 props 算：有 region 用 region，没有就退到所属 group。
//
// （useId() 在本仓不可用：renderToStaticMarkup 不跑 effect，SSR 下没有任何 launcher 拿到归属，邻居
// 那条 live-preview 断言会变成不可达的死覆盖——净损失。所以键必须能从 props 推出来。）
//
// 这个文件守三层，缺一层就有一族回归无人守：
//   1. 纯函数层：warmTerminalPreview 的取值（归属命中 / 不命中 / 预热中 / 换 key / 无 workspace）
//   2. store 层：同 key 再请求要**转移归属**而不是 no-op
//   3. 接线层：组件里那三个取值真的来自同一次判定，且预热 effect 的依赖与归属无关
// ---------------------------------------------------------------------------

function terminalSession(id: string): SessionSnapshot {
  return {
    id,
    kind: 'terminal',
    providerId: null,
    executorId: null,
    hostId: 'local',
    workspacePath: '/repo',
    label: 'Terminal',
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'terminal', hostId: 'local', terminalSessionId: id }
  }
}

const KEY = warmTerminalKey('local', '/repo')

describe('warmTerminalPreview：预览只属于槽的 owner', () => {
  const session = terminalSession('warm-1')

  it('归属命中时给出 session', () => {
    expect(
      warmTerminalPreview({
        warmTerminal: { key: KEY, ownerLauncherId: 'launcher-a', session },
        warmKey: KEY,
        launcherId: 'launcher-a'
      })
    ).toEqual({ session, pending: false, slotHeld: true })
  })

  it('同 key 但归属是别人时不给 session —— 这就是两个 view 抢一个 PTY 的那一刻', () => {
    // 分屏里的同胞 launcher：warmKey 逐字相同，只判 key 的旧写法在这里也会返回 session，
    // 于是两个 TerminalView 挂到同一个 run 上，各自 fit 同一个 PTY。
    const preview = warmTerminalPreview({
      warmTerminal: { key: KEY, ownerLauncherId: 'launcher-a', session },
      warmKey: KEY,
      launcherId: 'launcher-b'
    })
    expect(preview.session, '同胞 launcher 也拿到了 session——两个 view 会抢同一个 PTY').toBeNull()
    // 但它不该显示「正在预热」：shell 已经起好了，只是不归它。
    expect(preview.pending).toBe(false)
    // 槽仍然在场，只是不归它——预热 effect 不该因此再起一个 PTY。
    expect(preview.slotHeld, '同胞把「槽在不在」读成了假，会重复预热').toBe(true)
  })

  it('槽是本 workspace 的但 shell 还没起好 → pending，不论归属给谁', () => {
    // 点下去 promote 会等 ready，所以显示「正在预热」而不是冷卡片。归属在这一刻还没意义。
    for (const owner of ['launcher-a', 'launcher-b']) {
      expect(
        warmTerminalPreview({
          warmTerminal: { key: KEY, ownerLauncherId: owner, session: null },
          warmKey: KEY,
          launcherId: 'launcher-b'
        }),
        `owner=${owner}`
      ).toEqual({ session: null, pending: true, slotHeld: true })
    }
  })

  it('key 不同（另一个 host 或另一个 cwd）时三个取值都是空', () => {
    expect(
      warmTerminalPreview({
        warmTerminal: { key: warmTerminalKey('local', '/other'), ownerLauncherId: 'launcher-a', session },
        warmKey: KEY,
        launcherId: 'launcher-a'
      })
    ).toEqual({ session: null, pending: false, slotHeld: false })
  })

  it('没有 workspace（warmKey 为 null）时不能靠「两个都没有键」凑成相等', () => {
    expect(
      warmTerminalPreview({
        warmTerminal: { key: KEY, ownerLauncherId: 'launcher-a', session },
        warmKey: null,
        launcherId: 'launcher-a'
      })
    ).toEqual({ session: null, pending: false, slotHeld: false })
  })

  it('槽为空时 slotHeld 为假 —— promote 之后靠这个值重新预热', () => {
    expect(
      warmTerminalPreview({ warmTerminal: null, warmKey: KEY, launcherId: 'launcher-a' })
    ).toEqual({ session: null, pending: false, slotHeld: false })
  })

  it('slotHeld 与归属无关 —— 否则同胞之间会无限 ping-pong 重新预热', () => {
    // 这是 effect 依赖唯一允许读的量。若它跟着归属翻动：A 失去归属 → 依赖变化 → A 重新预热夺回
    // → B 失去归属 → B 夺回……两个同时在场的 launcher 永远互相打断，整个界面持续重渲染。
    const held = { key: KEY, ownerLauncherId: 'launcher-a', session }
    const owner = warmTerminalPreview({ warmTerminal: held, warmKey: KEY, launcherId: 'launcher-a' })
    const sibling = warmTerminalPreview({ warmTerminal: held, warmKey: KEY, launcherId: 'launcher-b' })
    expect(
      owner.slotHeld,
      'owner 与同胞对「槽在不在」判得不一样——这个量被归属污染了'
    ).toBe(sibling.slotHeld)
    // 前提自检：这一对必须真的在归属上分开，否则上面这条可以靠「两个都是 owner」而恒真。
    expect(owner.session, '前提落空：owner 侧没拿到 session').not.toBeNull()
    expect(sibling.session, '前提落空：同胞侧也拿到了 session，这一对没有分开').toBeNull()
  })
})

describe('store：同 key 再请求转移归属，不重开 PTY', () => {
  const initialState = useAppStore.getState()
  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  const workspace: WorkspaceRecord = {
    id: 'workspace', name: 'repo', hostId: 'local', path: '/repo', kind: 'folder'
  }
  const config: AppConfig = {
    version: 7,
    hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
    executors: {},
    workspaces: [workspace],
    appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
  }

  it('归属转给后来的 launcher，且 ready / session 原样保留', () => {
    // 若这里直接 return（旧写法），槽的 owner 永远停在第一个挂载的那个 launcher 上，用户刚点出来、
    // 正在看的那个只能显示冷卡片。转移归属让「最后一个请求预热的 launcher 拥有预览」，同时仍然
    // 只有一个 PTY、只有一个 view 挂在上面。
    const session = terminalSession('warm-1')
    const ready = Promise.resolve(session)
    useAppStore.setState({
      config,
      warmTerminal: { key: KEY, ownerLauncherId: 'launcher-a', ready, session }
    })

    useAppStore.getState().prewarmTerminal(workspace.id, 'launcher-b')

    const held = useAppStore.getState().warmTerminal
    expect(held?.ownerLauncherId, '归属没有转移——后挂载的 launcher 永远只能看冷卡片').toBe('launcher-b')
    expect(held?.ready, '转移归属时把 ready 换掉了——等于重开了一个 PTY').toBe(ready)
    expect(held?.session, '转移归属时丢了已经起好的 session').toBe(session)
  })

  it('归属已经是自己时不动任何东西（对象身份不变）', () => {
    const session = terminalSession('warm-1')
    const before = { key: KEY, ownerLauncherId: 'launcher-a', ready: Promise.resolve(session), session }
    useAppStore.setState({ config, warmTerminal: before })

    useAppStore.getState().prewarmTerminal(workspace.id, 'launcher-a')

    expect(useAppStore.getState().warmTerminal, '无变化的请求也写了一次 state').toBe(before)
  })
})

describe('接线层：组件的两个取值来自同一次判定', () => {
  // 上面两组是行为断言，但「组件真的调了这个函数」它们看不见——本仓没有 DOM 环境，
  // renderToStaticMarkup 不跑 effect，而且 zustand 在 SSR 下渲染 initial state，所以测试的
  // setState 对 markup 不可见。所以接线只能守形状，判据取 AST 而不是文本。
  const SOURCE = readFileSync(
    new URL('../src/renderer/src/components/NewTabSurface.tsx', import.meta.url).pathname,
    'utf8'
  )
  const ast = ts.createSourceFile(
    'NewTabSurface.tsx', SOURCE, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX
  )

  function callsNamed(name: string): ts.CallExpression[] {
    const found: ts.CallExpression[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
        found.push(node)
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    return found
  }

  it('warmTerminalPreview 恰好被调用一次', () => {
    // 两处调用意味着两个取值各算了一遍——那正是要消除的双重判定。零处意味着组件绕过了这个函数。
    const calls = callsNamed('warmTerminalPreview')
    expect(calls, `实测调用点 ${calls.length} 处，应为 1 处`).toHaveLength(1)
  })

  it('从 lib/warm-terminal-preview import，不是本地同名函数', () => {
    // 判 import 关系而不是标识符在场：组件里另写一个同名局部函数会让上一条照旧通过。
    expect(SOURCE).toMatch(/from '\.\.\/lib\/warm-terminal-preview'/u)
  })

  it('组件里不许再自己拿 warmTerminal 的 key / 归属判一次', () => {
    // 判定只在纯函数里做一次。组件若再读这两个字段，就是同一个概念的第二处判定，两处必然漂移。
    const offenders: string[] = []
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        (node.name.text === 'ownerLauncherId' || node.name.text === 'key') &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'warmTerminal'
      ) {
        offenders.push(
          `${node.name.text} @ 行 ${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`
        )
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    expect(offenders, [
      '组件直接读了 warmTerminal 的归属字段。归属判定只许在 lib/warm-terminal-preview.ts 里做一次，',
      '组件读一遍就是第二处判定——两处会漂移，症状是「转圈提示归 A、终端画面归 B」。'
    ].join('\n')).toEqual([])

    // 前提自检：分析器认得出这一族属性访问。用一段一定命中的样本质询它，否则上面可能恒绿。
    const probe = ts.createSourceFile(
      'probe.tsx',
      'const x = warmTerminal.ownerLauncherId === launcherId && warmTerminal.key === k',
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TSX
    )
    const probeHits: string[] = []
    const probeVisit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        (node.name.text === 'ownerLauncherId' || node.name.text === 'key') &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'warmTerminal'
      ) probeHits.push(node.name.text)
      ts.forEachChild(node, probeVisit)
    }
    probeVisit(probe)
    expect(probeHits, '分析器认不出它要禁的形状——主断言恒绿').toEqual(['ownerLauncherId', 'key'])
  })

  it('归属键由 warmLauncherId 判一次，不直接用可缺席的 regionId', () => {
    // 空分组占位没有 regionId，而那恰是新建 workspace 的第一眼。用可缺席的字段当归属键会把最主要
    // 那条路径永久降级成冷卡片（实测：new-tab-resource-contract 当场打红）。
    const calls = callsNamed('warmTerminalPreview')
    expect(calls, '调用点不是一处——上一条会先红').toHaveLength(1)
    const argument = calls[0]!.arguments[0]
    expect(argument && ts.isObjectLiteralExpression(argument), '实参不是对象字面量').toBe(true)
    const keys = (argument as ts.ObjectLiteralExpression).properties.map((property) => (
      property.name && ts.isIdentifier(property.name) ? property.name.text : ''
    ))
    expect(keys, `实参键是 [${keys.join(', ')}]，归属键必须是 launcherId`).toContain('launcherId')
    expect(keys, 'regionId 又被当成归属键了——空分组占位没有 region').not.toContain('regionId')
    // 键的取值规则只许在 lib 里做一次：组件若自己写 `regionId ?? tabGroupId` 之类，「缺 region 时
    // 退到什么」就有了第二处判断，两处必然漂移。
    const launcherIdCalls = callsNamed('warmLauncherId')
    expect(
      launcherIdCalls,
      `warmLauncherId 调用点 ${launcherIdCalls.length} 处，应为 1 处——归属键的取值规则只许判一次`
    ).toHaveLength(1)
    expect(SOURCE, 'warmLauncherId 不是从 lib/warm-terminal-preview import 的')
      .toMatch(/import \{[^}]*\bwarmLauncherId\b[^}]*\} from '\.\.\/lib\/warm-terminal-preview'/u)
  })

  it('warmLauncherId 缺 region 时退到 group，且两个命名空间不会撞', () => {
    // 这是「归属键永远在场」的行为面。空分组占位（WorkspaceWorkbench 里 bodyTabs 为空那条）没有
    // region，此时必须仍然给出一个键；同时它不能与任何 region 键相等，否则空占位会冒充某个 region
    // 的 owner，把那个 region 的预览抢走。
    expect(warmLauncherId({ tabGroupId: 'group-1', regionId: undefined })).toBe('group:group-1')
    expect(warmLauncherId({ tabGroupId: 'group-1', regionId: 'region:abc' })).toBe('region:region:abc')
    // 同一个 group 里的两个 region 互不相同（分屏那条路径）。
    expect(
      warmLauncherId({ tabGroupId: 'g', regionId: 'r1' })
    ).not.toBe(warmLauncherId({ tabGroupId: 'g', regionId: 'r2' }))
    // 跨命名空间不撞：一个 group 叫 `x`、一个 region 也叫 `x` 时两个键必须分开。
    expect(
      warmLauncherId({ tabGroupId: 'x', regionId: undefined })
    ).not.toBe(warmLauncherId({ tabGroupId: 'other', regionId: 'x' }))
  })

  it('预热 effect 的依赖带上「槽在不在」，且那个量与归属无关', () => {
    // promote 会把槽清空。依赖里只有 workspace 与 visible 时，仍然在场的同胞 launcher 此后永远
    // 看不到热 shell——它的 Terminal 卡片静默退化成冷路径，本次会话再不恢复。
    //
    // 而这个量**不能**带归属：归属在同胞之间转移，若依赖跟着归属翻动，失去归属的那个立刻重新预热
    // 夺回来，对方随即再夺回——无限 ping-pong。所以依赖必须是 slotHeld 这个与归属无关的量。
    const calls = callsNamed('prewarmTerminal')
    expect(calls, 'prewarmTerminal 调用点不是一处——new-tab-prewarm-visible-only 会先红').toHaveLength(1)

    // 找到包住这次调用的 useEffect，读它的依赖数组。
    let effect: ts.CallExpression | undefined
    let node: ts.Node | undefined = calls[0]
    while (node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'useEffect'
      ) { effect = node; break }
      node = node.parent
    }
    expect(effect, '那次调用不在 useEffect 里——判据落空').toBeDefined()

    const deps = effect!.arguments[1]
    expect(deps && ts.isArrayLiteralExpression(deps), 'useEffect 第二个实参不是数组字面量').toBe(true)
    const names = (deps as ts.ArrayLiteralExpression).elements.map((element) => element.getText(ast))
    expect(names, [
      `预热 effect 的依赖是 [${names.join(', ')}]，其中没有表达「槽在不在」的项。`,
      'promote 清空槽之后没有任何依赖变化，同胞 launcher 因此永远停在冷路径。'
    ].join('\n')).toContain('warmSlotHeld')
    // `visible` 也必须在依赖里：泊车的 launcher 挂载时不可见故不预热，变可见时若依赖不含 visible
    // 就没有任何东西触发预热，它永远停在冷卡片。（极性——只在 visible 为真时预热——由
    // new-tab-prewarm-visible-only.test.ts 用 AST 数出口守。）
    expect(names, `依赖是 [${names.join(', ')}]，缺 visible：泊车 launcher 变可见时不会预热`)
      .toContain('visible')
    // 带归属的那两个量绝不许进依赖：进了就是同胞之间无限互相夺回归属。
    for (const forbidden of ['warmSession', 'warmPending']) {
      expect(names, [
        `依赖里出现了 ${forbidden}——它带归属，会在同胞之间震荡：`,
        'A 失去归属→依赖变化→A 重新预热夺回→B 失去归属→B 夺回……界面持续重渲染。'
      ].join('\n')).not.toContain(forbidden)
    }
  })
})
