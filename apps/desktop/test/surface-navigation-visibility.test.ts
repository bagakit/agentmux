import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// 冷泊车协调器 import 了 store（它导出的 hook 要读 store），而 store 在测试环境里会撞上
// `__AGENTMUX_WEB_PREVIEW__` 这个只在打包时注入的全局。本文件只用它的纯函数
// `collectTerminalColdParkCandidates`，所以按同族测试（terminal-cold-parking-coordinator.test.ts）
// 的既有做法把 store 挡在外面。
vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: () => undefined
}))

import { surfaceNavigationVisibility } from '../src/renderer/src/lib/surface-navigation-visibility.js'
import { activeTopicIdFromLayout } from '../src/renderer/src/lib/scratch-topic-layout.js'
import { collectSurfaceMemoryCandidates } from '../src/renderer/src/lib/surface-memory-budget-candidates.js'
import { collectTerminalColdParkCandidates } from '../src/renderer/src/lib/terminal-cold-parking-coordinator.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/contracts.js'

const RENDERER_ROOT = new URL('../src/renderer/src/', import.meta.url).pathname
const IMPLEMENTATION = 'lib/surface-navigation-visibility.ts'

function sourceFiles(): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry)) found.push(path.slice(RENDERER_ROOT.length))
    }
  }
  walk(RENDERER_ROOT)
  return found
}

function read(relative: string): string {
  return readFileSync(join(RENDERER_ROOT, relative), 'utf8')
}

function fileTab(id: string, workspaceId = 'workspace-1') {
  return createWorkbenchTab(id, {
    regionId: `region:${id}`,
    kind: 'file',
    workspaceId,
    path: `src/${id}.ts`
  })
}

function terminalTab(id: string, workspaceId = 'workspace-1') {
  return createWorkbenchTab(id, {
    regionId: `region:${id}`,
    kind: 'terminal',
    phase: 'attached',
    workspaceId,
    sessionId: `session:${id}`
  })
}

// ---------------------------------------------------------------------------
// 行为层：这一处判定本身答得对不对。
// ---------------------------------------------------------------------------

describe('surfaceNavigationVisibility 的取值', () => {
  it('只有所在分组的活动 Tab 算在屏上，同组其他 Tab 不算', () => {
    const first = fileTab('first')
    const second = fileTab('second')
    const tabs = { [first.id]: first, [second.id]: second }
    const layout = createWorkspaceLayout('group', [first.id, second.id])
    const input = { activeWorkspaceId: 'workspace-1', workbenchVisible: true }

    expect(surfaceNavigationVisibility(first, layout, tabs, input)).toEqual({
      navigationContextActive: true,
      tabVisible: true
    })
    expect(surfaceNavigationVisibility(second, layout, tabs, input)).toEqual({
      navigationContextActive: true,
      tabVisible: false
    })
  })

  it('非活动 Workspace 的 Tab 两个取值同时为假', () => {
    const tab = fileTab('other-project')
    const layout = createWorkspaceLayout('group', [tab.id])

    expect(
      surfaceNavigationVisibility(tab, layout, { [tab.id]: tab }, {
        activeWorkspaceId: 'another-workspace',
        workbenchVisible: true
      })
    ).toEqual({ navigationContextActive: false, tabVisible: false })
  })

  it('workbench 整体不可见时两个取值同时为假（设置页盖住主区）', () => {
    const tab = fileTab('behind-settings')
    const layout = createWorkspaceLayout('group', [tab.id])

    expect(
      surfaceNavigationVisibility(tab, layout, { [tab.id]: tab }, {
        activeWorkspaceId: 'workspace-1',
        workbenchVisible: false
      })
    ).toEqual({ navigationContextActive: false, tabVisible: false })
  })

  it('切 Scratch Topic 时被隐藏的那份保持温热：不在屏上，但导航上下文算已离开', () => {
    // Scratch 的所有 Topic 共用一份 layout，所以「不是当前 Topic」必须像「不是当前项目」一样，
    // 让 navigationContextActive 落到 false——否则 30 秒泊车计时器会把它 detach 掉。
    const shown = { ...terminalTab('topic-a', SCRATCH_WORKSPACE_ID), topicId: 'view:topic-a' }
    const hidden = { ...terminalTab('topic-b', SCRATCH_WORKSPACE_ID), topicId: 'view:topic-b' }
    const tabs = { [shown.id]: shown, [hidden.id]: hidden }
    const layout = createWorkspaceLayout('group', [shown.id, hidden.id])
    const input = { activeWorkspaceId: SCRATCH_WORKSPACE_ID, workbenchVisible: true }

    expect(surfaceNavigationVisibility(shown, layout, tabs, input)).toEqual({
      navigationContextActive: true,
      tabVisible: true
    })
    expect(surfaceNavigationVisibility(hidden, layout, tabs, input)).toEqual({
      navigationContextActive: false,
      tabVisible: false
    })
  })

  it('分屏时另一组的活动项被投影重定向到当前 Topic，那张要算在屏上', () => {
    // 为什么必须是**两个分组**：上面那条只有一个分组，而单分组下投影与否对
    // `group?.activeTabId === tab.id` 得到相同答案（隐藏的 Tab 要么被投影滤掉、group 变
    // undefined，要么留在原组里但活动项不是它，两条路都是 false）。于是「整段砍掉
    // `layoutForActiveTopic`」这个变异在单分组 fixture 下**完全不可观测**——实测该变异让
    // 这个文件里其余 7 条全绿。
    //
    // 真正让投影可观测的形状是：某个分组**存着**的活动项属于另一个 Topic，而该组里同时有一张
    // 属于当前 Topic 的 Tab。投影会把活动项重定向到后者（layoutForActiveTopic 的 `stays`
    // 判据不是"它还看得见"而是"它属于这个 Topic"），所以那张 Tab 真的画在屏上；不投影则活动项
    // 仍是另一个 Topic 那张，这张就被误判成隐藏而进回收候选。
    const leftShown = { ...terminalTab('left-a', SCRATCH_WORKSPACE_ID), topicId: 'view:topic-a' }
    const rightStored = { ...terminalTab('right-b', SCRATCH_WORKSPACE_ID), topicId: 'view:topic-b' }
    const rightProjected = { ...terminalTab('right-a', SCRATCH_WORKSPACE_ID), topicId: 'view:topic-a' }
    const tabs = {
      [leftShown.id]: leftShown,
      [rightStored.id]: rightStored,
      [rightProjected.id]: rightProjected
    }
    // createWorkspaceLayout 只造单分组，这里必须手写：分屏本身就是这条用例的主角。
    const layout = {
      root: {
        type: 'split' as const,
        direction: 'horizontal' as const,
        first: { type: 'leaf' as const, groupId: 'left' },
        second: { type: 'leaf' as const, groupId: 'right' },
        ratio: 0.5
      },
      groups: [
        {
          id: 'left',
          tabOrder: [leftShown.id],
          activeTabId: leftShown.id,
          recentTabIds: [leftShown.id]
        },
        {
          // 存着的活动项属于 topic-B，同组里还有一张 topic-A 的。
          id: 'right',
          tabOrder: [rightStored.id, rightProjected.id],
          activeTabId: rightStored.id,
          recentTabIds: [rightStored.id]
        }
      ],
      activeGroupId: 'left'
    }
    const input = { activeWorkspaceId: SCRATCH_WORKSPACE_ID, workbenchVisible: true }

    // 前提自检：当前 Topic 必须真的解析成 topic-A，否则投影根本不会启动，下面三条断言在
    // 「投影是死代码」的世界里也成立。activeTopicIdFromLayout 按分组顺序取第一个带 topicId 的
    // 活动项，所以它取的是 left 组的 leftShown。
    expect(
      activeTopicIdFromLayout(layout, tabs),
      '当前 Topic 没解析成 topic-A，这批输入观察不到投影'
    ).toBe('view:topic-a')

    expect(surfaceNavigationVisibility(leftShown, layout, tabs, input)).toEqual({
      navigationContextActive: true,
      tabVisible: true
    })
    // 主角：存着的活动项是别的 Topic，投影把 right 组的活动项改成这一张，所以它在屏上。
    expect(
      surfaceNavigationVisibility(rightProjected, layout, tabs, input),
      'Topic 投影没有把另一组的活动项重定向到当前 Topic——在屏的 Tab 被判成隐藏，会被回收'
    ).toEqual({ navigationContextActive: true, tabVisible: true })
    // 对照：它是 right 组存着的活动项，但属于另一个 Topic，投影后不再是活动项。
    expect(surfaceNavigationVisibility(rightStored, layout, tabs, input)).toEqual({
      navigationContextActive: false,
      tabVisible: false
    })
  })

  it('未绑定 Topic 的 Scratch Tab 在任何 Topic 下都算上下文活着', () => {
    // `tab.topicId === undefined` 那条析取项此前零覆盖：删掉它，这个文件其余 7 条全绿（实测）。
    // 生产里这种 Tab 确实存在——store / control / file-workbench-state 三处都是「有才带
    // topicId、没有就不带」。删掉那条后它在任何 Topic 活动时都被判成「上下文不活」，于是 TTL
    // 永远被挡：终端永不冷泊、Monaco 永不 release，是个泄漏而不是报错。
    const anchored = { ...terminalTab('anchored', SCRATCH_WORKSPACE_ID), topicId: 'view:topic-a' }
    const unbound = terminalTab('unbound', SCRATCH_WORKSPACE_ID)
    const tabs = { [anchored.id]: anchored, [unbound.id]: unbound }
    const layout = createWorkspaceLayout('group', [anchored.id, unbound.id])
    const input = { activeWorkspaceId: SCRATCH_WORKSPACE_ID, workbenchVisible: true }

    // 前提自检之一：这张 Tab 真的没带 topicId。createWorkbenchTab 将来若开始补默认值，
    // 这条用例会变成在测另一件事。
    expect(unbound.topicId, '这张 Tab 带了 topicId，这条用例观察不到未绑定的那条析取项').toBeUndefined()
    // 前提自检之二：必须真的有一个 Topic 在活动，否则 `activeTopicId === null` 那条析取项先
    // 短路，被测的那条永远不参与判定。
    expect(
      activeTopicIdFromLayout(layout, tabs),
      '没有 Topic 在活动，activeTopicId === null 会先短路'
    ).toBe('view:topic-a')

    expect(
      surfaceNavigationVisibility(unbound, layout, tabs, input),
      '未绑定 Topic 的 Tab 被判成上下文已离开——它的面永远等不到 TTL，是泄漏'
    ).toEqual({ navigationContextActive: true, tabVisible: false })
  })

  it('Scratch 里停在未绑 Topic 的一张 Tab 上时，绑了 Topic 的隐藏 Tab 仍算上下文活着', () => {
    // `activeTopicId === null` 那条析取项此前零覆盖：删掉它，这个文件其余 8 条**加上**三个消费者
    // 侧的 terminal-cold-parking / surface-memory-budget / scratch-topic-layout 共 24 条全绿（实测）。
    //
    // 为什么 true 才是对的：activeTopicId 为 null 时下面那次投影不发生（`projected = layout`），
    // 于是这些绑了 Topic 的 Tab **就在同一份未投影的 layout 里**，只是被别的 Tab 盖住——而
    // navigationContextActive 的定义恰恰是「即使被别的 Tab 盖住也算上下文活着」（见实现的文件头）。
    // 没有任何 Topic 在活动，就没有「切走了」这件事发生过。
    //
    // 症状与旁边那条（未绑定 Topic 的 Tab）同形，只是方向相反：在 Scratch 里只要此刻停在一张普通
    // launcher 页上，所有隐藏的、绑了 Topic 的终端 / 编辑器会被判成「导航上下文已离开」，于是
    // TTL 永远被挡——xterm / Monaco / BrowserView 永不冷泊、永不 release。是泄漏，不是报错。
    const launcher = fileTab('launcher', SCRATCH_WORKSPACE_ID)
    const bound = { ...terminalTab('bound', SCRATCH_WORKSPACE_ID), topicId: 'view:topic-a' }
    const tabs = { [launcher.id]: launcher, [bound.id]: bound }
    // launcher 在前，所以它是分组的活动项——activeTopicIdFromLayout 只看每个分组的活动项。
    const layout = createWorkspaceLayout('group', [launcher.id, bound.id])
    const input = { activeWorkspaceId: SCRATCH_WORKSPACE_ID, workbenchVisible: true }

    // 前提自检之一：当前必须真的不在任何 Topic 里，否则被测的那条析取项为假，这条用例在测别的项。
    expect(
      activeTopicIdFromLayout(layout, tabs),
      '有 Topic 在活动，activeTopicId === null 那条析取项为假，这条用例观察不到它'
    ).toBeNull()
    // 前提自检之二：被测的 Tab 必须**带着** topicId，否则 `tab.topicId === undefined` 那条先为真，
    // 上一条用例已经守的那项会把这一条掩盖掉——两条用例就变成在测同一件事。
    expect(
      bound.topicId,
      '被测 Tab 没带 topicId，tab.topicId === undefined 会先短路，这条与上一条重复'
    ).toBe('view:topic-a')

    expect(
      surfaceNavigationVisibility(bound, layout, tabs, input),
      '停在未绑 Topic 的页上时，绑了 Topic 的隐藏面被判成上下文已离开——它们永不冷泊，是泄漏'
    ).toEqual({ navigationContextActive: true, tabVisible: false })
  })
})

// ---------------------------------------------------------------------------
// 接线层：两个回收器真的都走这一处，而不是各自再写一遍。
//
// 这一层必须与行为层分开，因为它们各自能单独失败，且失败形状完全不同：行为层挡「这一处判错了」，
// 接线层挡「有人绕过了这一处」。此前正是接线层缺失——两个协调器把同一段逻辑逐字抄了两遍且互不
// import，于是只改一处会让另一处静默保留旧行为并全绿（本仓 duplicated-rule-defeats-the-fix 那族）。
// ---------------------------------------------------------------------------

describe('两个回收器共用同一处判定', () => {
  it('两个候选收集器对同一批 Tab 判出一致的在屏状态', () => {
    // 这一条是**行为侧**的接线证明：不查源码文本，而是让两个收集器各自跑一遍同一批输入，
    // 断言它们对每个 Region 的 `visible` / `navigationContextActive` 都与那处唯一实现一致。
    // 任何一侧重新手抄一份判定并漂移，这里就红——不需要那份手抄长成什么特定样子。
    //
    // 输入刻意用 **Scratch 的两个 Topic**，而不是普通 workspace：Topic 投影是这段逻辑里最容易在
    // 手抄时被整段漏掉的部分（普通 workspace 下它根本不参与），用普通 workspace 做 fixture 时，
    // 一份「只保留 workspace + activeTab 两项」的手抄仍然处处一致，这条就恒绿。实测：M3 那次把
    // 冷泊车侧换成不含 Topic 的手抄，普通 workspace 的 fixture 下这条通过，只有结构判据红。
    const shownTerminal = { ...terminalTab('shown-shell', SCRATCH_WORKSPACE_ID), topicId: 'view:a' }
    const shownFile = { ...fileTab('shown-doc', SCRATCH_WORKSPACE_ID), topicId: 'view:a' }
    const hiddenTerminal = { ...terminalTab('hidden-shell', SCRATCH_WORKSPACE_ID), topicId: 'view:b' }
    const hiddenFile = { ...fileTab('hidden-doc', SCRATCH_WORKSPACE_ID), topicId: 'view:b' }
    const tabs = {
      [shownTerminal.id]: shownTerminal,
      [shownFile.id]: shownFile,
      [hiddenTerminal.id]: hiddenTerminal,
      [hiddenFile.id]: hiddenFile
    }
    const layout = createWorkspaceLayout('group', [
      shownTerminal.id,
      shownFile.id,
      hiddenTerminal.id,
      hiddenFile.id
    ])
    const shared = {
      tabs,
      layouts: { [SCRATCH_WORKSPACE_ID]: layout },
      sessions: [],
      activeWorkspaceId: SCRATCH_WORKSPACE_ID,
      workbenchVisible: true
    }

    const memory = collectSurfaceMemoryCandidates({
      ...shared,
      documents: {},
      dirtyDocuments: {},
      savingDocuments: {}
    })
    const parking = collectTerminalColdParkCandidates(shared)

    // 两个收集器筛的 Region 种类不同（一个只要 file/browser，一个只要 agent/terminal），所以
    // 取值要按它们各自认领的那个 Region 对齐，而不是按数组下标。
    const expected = new Map(
      Object.values(tabs).map((tab) => {
        const { navigationContextActive, tabVisible } = surfaceNavigationVisibility(
          tab,
          layout,
          tabs,
          shared
        )
        return [Object.values(tab.regions)[0]!.regionId, {
          visible: tabVisible,
          navigationContextActive
        }]
      })
    )

    // 前提自检：两个收集器都必须真的产出了候选，且**隐藏 Topic 那一侧也在里面**——否则下面的
    // 循环只比对了看得见的那些，Topic 投影是否被手抄漏掉根本不可观测。
    expect(memory.map((candidate) => candidate.id).sort(), '内存预算侧的候选不是预期那两个').toEqual([
      'region:hidden-doc',
      'region:shown-doc'
    ])
    expect(parking.map((candidate) => candidate.id).sort(), '冷泊车侧的候选不是预期那两个').toEqual([
      'region:hidden-shell',
      'region:shown-shell'
    ])
    // 前提自检之二：这批输入必须真的能区分对错——隐藏 Topic 的取值与显示中的不同。两者相同时
    // 整条断言退化成恒真（本仓 property-unobservable-in-default-env 那族）。
    expect(
      expected.get('region:hidden-shell'),
      '隐藏 Topic 与显示中的取值相同，这批输入区分不出手抄漏掉 Topic 投影'
    ).not.toEqual(expected.get('region:shown-shell'))

    for (const candidate of [...memory, ...parking]) {
      expect(
        { visible: candidate.visible, navigationContextActive: candidate.navigationContextActive },
        `${candidate.id} 的在屏判定与那处唯一实现不一致——有人又自己判了一遍`
      ).toEqual(expected.get(candidate.id))
    }
  })

  it('每个生产这两个字段的文件都必须真的调用那处唯一实现', () => {
    // 判据是「有没有调那个实现」，**不是**「有没有 import 它」，也不是「有没有出现某个字符串」。
    //
    // 这个方向是实测选出来的：先写成 import 关系时，把候选收集器里那一句调用换成内联手抄（import
    // 语句留在原地不动）——这条恒绿，只有下面那条数拼法的补充判据红。而 import 语句是死的，
    // 「import 了却不调」正是原缺陷的一种。所以问题要问成「有没有走那个唯一实现」：产出这两个字段
    // 的文件是可枚举的，它们有一个共同标记，就是产出本身。
    //
    // `[,:}]` 里的 `}` 是补的：原判据只认 `,` 和 `:`，于是**末位 shorthand**（`{ visible,
    // navigationContextActive }`、`{ ...rest, navigationContextActive }`）后面跟的是空格加 `}`，
    // 整个文件探测不到 → 不进 producers → 下面那个循环根本不对它跑。实测这条路能让一个「装了
    // import、却自己内联判一遍」的新消费者对三条接线守卫全隐形——正是本判据要防的缺陷本身。
    const produces = /(^|[^.\w])navigationContextActive\s*[,:}](?!\s*boolean)/
    // 判据自检：这三种产出写法都必须被认出来。少了任何一种，绕过的方式就是换成那种写法，而这个
    // 自检会比「等到有人真那么写」先红。反例那条钉住 `boolean` 排除项仍然生效（类型声明不是产出）。
    for (const [shape, source] of [
      ['显式取值', 'return { navigationContextActive: x, tabVisible: y }'],
      ['中间 shorthand', 'return { navigationContextActive, tabVisible }'],
      ['末位 shorthand', 'return { visible, navigationContextActive }'],
      ['展开后末位', 'return { ...rest, navigationContextActive }']
    ] as const) {
      expect(produces.test(source), `产出探测认不出「${shape}」这种写法，换成它就能绕过`).toBe(true)
    }
    expect(
      produces.test('type X = { navigationContextActive: boolean }'),
      '产出探测把类型声明也算成产出，那不是产出'
    ).toBe(false)
    const producers = sourceFiles().filter((relative) => produces.test(read(relative)))

    // 前提自检：扫描必须真的抓到实现自己 + 两个协调器。抓到 0 个（写错扫描根、正则失配）时下面的
    // 循环恒绿，那是本仓 guard 假绿里最常见的一种。
    //
    // 判「至少包含这三个」而不是「恰好是这三个」：第四个消费者出现时，红出来的原因应该是「你没有
    // 走那处实现」，而不是「这张清单该更新了」。在场性归这条自检，是否调用全交给下面的循环。
    expect(
      producers.filter((relative) => [
        IMPLEMENTATION,
        'lib/surface-memory-budget-candidates.ts',
        'lib/terminal-cold-parking-coordinator.tsx'
      ].includes(relative)).sort(),
      '产出这两个字段的文件没有全被抓到，判据对漏掉的那些失效'
    ).toEqual([
      'lib/surface-memory-budget-candidates.ts',
      IMPLEMENTATION,
      'lib/terminal-cold-parking-coordinator.tsx'
    ])

    for (const relative of producers) {
      if (relative === IMPLEMENTATION) continue
      const source = read(relative)
      expect(
        source.match(/surfaceNavigationVisibility\(/g) ?? [],
        `${relative} 产出了在屏判定却没有恰好一次调用 surfaceNavigationVisibility——它在自己判一遍`
      ).toHaveLength(1)
      // import 也要在场：上面那条只证明这个名字被当函数调了，而同名的本地函数同样满足它。
      expect(
        source,
        `${relative} 调的 surfaceNavigationVisibility 不是从那处实现 import 来的`
      ).toMatch(/from '\.\/surface-navigation-visibility'/)
    }
  })

  it('补充判据：实现之外没有第二处重新推导「活动 Workspace 且 workbench 可见」', () => {
    // 只是补充。它数的是拼法，因此对「换个写法再手抄一遍」失明；留着是因为它能抓到
    // 「走了那处实现、又在旁边顺手多判一次」——那种情况上一条恰好一次的断言会红，但如果多判的那次
    // 写在别的文件里（没有产出这两个字段，因此不在 producers 里），只有这一条看得见。
    //
    // 两个方向都要判：原判据只认 `workbenchVisible && … activeWorkspaceId ===`，于是把合取写成
    // 反序（`activeWorkspaceId === x && workbenchVisible`）就整条失配。实测一个反序手抄且不产出
    // `navigationContextActive` 的文件对**全部**判据隐形——上一条按产出枚举抓不到它，这一条按顺序
    // 抓不到它。合取的顺序不改变语义，判据不该挂在顺序上。
    const rewriteShapes = [
      /workbenchVisible\s*&&[\s\S]{0,80}activeWorkspaceId\s*===/,
      /activeWorkspaceId\s*===[\s\S]{0,80}&&\s*[\s\S]{0,20}workbenchVisible/
    ]
    // 判据自检：两种顺序都必须被认出来。少一个方向，绕过方式就是换成那个方向。
    for (const [order, source] of [
      ['可见在左', 'const v = input.workbenchVisible && input.activeWorkspaceId === tab.workspaceId'],
      ['可见在右', 'const v = input.activeWorkspaceId === tab.workspaceId && input.workbenchVisible']
    ] as const) {
      expect(
        rewriteShapes.some((shape) => shape.test(source)),
        `重推导探测认不出「${order}」这种顺序，换成它就能绕过`
      ).toBe(true)
    }
    const rewrites = sourceFiles().filter((relative) => {
      if (relative === IMPLEMENTATION) return false
      const source = read(relative)
      return rewriteShapes.some((shape) => shape.test(source))
    })
    expect(
      rewrites,
      '这些文件重新推导了「活动 Workspace 且 workbench 可见」，应改为调用那处唯一实现'
    ).toEqual([])
  })
})
