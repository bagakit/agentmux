import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { surfaceNavigationVisibility } from '../src/renderer/src/lib/surface-navigation-visibility.js'
import { activeTopicIdFromLayout } from '../src/renderer/src/lib/scratch-topic-layout.js'
import { collectSurfaceMemoryCandidates } from '../src/renderer/src/lib/surface-memory-budget-candidates.js'
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

it('resource owners skip covered layouts and keep exact visible projections', () => {
  const scratch = Array.from({ length: 48 }, (_, index) => ({
    ...(index % 2 === 0 ? fileTab(`file-${index}`, SCRATCH_WORKSPACE_ID)
      : terminalTab(`shell-${index}`, SCRATCH_WORKSPACE_ID)),
    topicId: index < 24 ? 'topic-a' : 'topic-b'
  }))
  const other = terminalTab('other-shell')
  const tabs = Object.fromEntries([...scratch, other].map(tab => [tab.id, tab]))
  const groupReads = { scratch: 0, other: 0 }
  const countGroupReads = (layout: ReturnType<typeof createWorkspaceLayout>, key: keyof typeof groupReads) =>
    new Proxy(layout, {
      get(target, property, receiver) {
        if (property === 'groups') groupReads[key]++
        return Reflect.get(target, property, receiver)
      }
    })
  const layouts = {
    [SCRATCH_WORKSPACE_ID]: countGroupReads(createWorkspaceLayout('scratch-group', scratch.map(tab => tab.id)), 'scratch'),
    [other.workspaceId]: countGroupReads(createWorkspaceLayout('other-group', [other.id]), 'other')
  }
  const input = {
    tabs, layouts, sessions: [],
    activeWorkspaceId: SCRATCH_WORKSPACE_ID,
    workbenchVisible: false,
    projectedVisibleRegionIds: new Set(['region:file-0']),
    projectedVisibleTabIds: new Set(['shell-1']),
    documents: {}, dirtyDocuments: {}, savingDocuments: {}
  }

  const memory = collectSurfaceMemoryCandidates(input)
  expect(memory).toHaveLength(24)
  expect(memory.filter(candidate => candidate.navigationContextActive).map(candidate => candidate.id)).toEqual(['region:file-0'])
  expect(memory.filter(candidate => candidate.visible).map(candidate => candidate.id)).toEqual(['region:file-0'])
  expect(groupReads).toEqual({ scratch: 0, other: 0 })

  const reopened = surfaceNavigationVisibility(tabs['shell-3']!, layouts[SCRATCH_WORKSPACE_ID], tabs, { ...input, workbenchVisible: true })
  expect(groupReads.scratch).toBeGreaterThan(0)
  expect(groupReads.other).toBe(0)
  expect(reopened.navigationContextActive).toBe(true)
  expect(surfaceNavigationVisibility(tabs['shell-25']!, layouts[SCRATCH_WORKSPACE_ID], tabs, { ...input, workbenchVisible: true }).navigationContextActive).toBe(false)
})

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
    // 原 surface-memory-budget / scratch-topic-layout 消费者不应掩盖这个分支。
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

// 原可回收的 file/browser 仍按统一导航事实区分当前 Topic 与隐藏 Topic。
describe('内存预算沿用统一在屏判定', () => {
  it('file/browser 候选与同批 Tab 的原在屏判定一致', () => {
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

    // 用准确 Region 对齐实际 file/browser 候选。
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

    // 前提自检：实际候选必须同时含显示和隐藏 Topic，否则下面的
    // 循环只比对了看得见的那些，Topic 投影是否被手抄漏掉根本不可观测。
    expect(memory.map((candidate) => candidate.id).sort(), '内存预算侧的候选不是预期那两个').toEqual([
      'region:hidden-doc',
      'region:shown-doc'
    ])
    // 前提自检之二：这批输入必须真的能区分对错——隐藏 Topic 的取值与显示中的不同。两者相同时
    // 整条断言退化成恒真（本仓 property-unobservable-in-default-env 那族）。
    expect(
      expected.get('region:hidden-shell'),
      '隐藏 Topic 与显示中的取值相同，这批输入区分不出手抄漏掉 Topic 投影'
    ).not.toEqual(expected.get('region:shown-shell'))

    for (const candidate of memory) {
      expect(
        { visible: candidate.visible, navigationContextActive: candidate.navigationContextActive },
        `${candidate.id} 的在屏判定与那处唯一实现不一致——有人又自己判了一遍`
      ).toEqual(expected.get(candidate.id))
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
