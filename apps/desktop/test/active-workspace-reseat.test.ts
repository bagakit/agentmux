import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { CONFIG_VERSION, SCRATCH_WORKSPACE_ID, type AppConfig } from '../src/shared/contracts.js'
import {
  adoptedConfig,
  reseatActiveWorkspaceId
} from '../src/renderer/src/lib/active-workspace-reseat.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { api } from '../src/renderer/src/lib/api.js'

/**
 * 「配置里少了一条 workspace，活动位怎么办」这一个判断。
 *
 * `activeWorkspaceId` 是**指进** `config.workspaces` 的一个引用，所以任何让某条记录消失的写入都必须
 * 在同一次 `set()` 里回答它。漏掉的后果不是"少一点状态"：`App.tsx` 按它找 Workspace 得到 undefined，
 * 于是在别的项目和 Scratch 都还在的情况下渲染出「Bring a workspace」欢迎页，屏幕上没有一句话解释
 * 刚才发生了什么，用户会以为自己的项目一起没了（#398）。
 *
 * 这个文件分两层，而两层必须各写一份：
 *
 * - **行为层**：兜底次序本身（下面第一族）。
 * - **接线层**：那些"让记录消失"的写入点真的走了这个判断（下面第二族）。搬进 lib 只解决一半——
 *   本仓 extracting-to-lib-only-fixes-half：内容变可测了，但"壳有没有被执行到"照旧无人守。
 *
 * 两层的变异实测（不是推想——推想过的那一版说错了一半，见下）：
 *
 * - 删掉 `reseatActiveWorkspaceId` 的 Scratch 兜底 → **4 条红，两族都红**。第二族并不"只问调了吗"：
 *   它断言的是落点（`toBe(SCRATCH_WORKSPACE_ID)`），所以共用函数坏了它一起红。这是好事，但不能
 *   写成"各只打红各自那层"——那句话此前就在这里，而它是错的。
 * - 把 `setConfig` 那次 `adoptedConfig` 换回裸 `config` → **2 条红**：第二族对应那条，加第三族的
 *   AST 守卫。第一族全绿（那个函数本身没坏）。这个方向才真的是单层。
 *
 * 换言之两层的关系是不对称的：接线坏了只红接线层，取值规则坏了两层一起红。写测试时不能靠
 * "结构上应该正交"来省掉那次测量。
 */

const STORE = new URL('../src/renderer/src/store.ts', import.meta.url)

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    version: CONFIG_VERSION,
    hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
    executors: {},
    workspaces: [
      { id: 'project-a', name: 'A', hostId: 'local', path: '/a', kind: 'folder' },
      { id: 'project-b', name: 'B', hostId: 'local', path: '/b', kind: 'folder' },
      // Scratch 在**末尾**，与 config-store 真实的追加位置一致（`[...config.workspaces, scratch]`）。
      // 放在头上会让下面「不落到 workspaces[0]」那条恒真——判据就没了。
      { id: SCRATCH_WORKSPACE_ID, name: 'Scratch', hostId: 'local', path: '/scratch', kind: 'folder' }
    ],
    appearance: { terminalTheme: 'graphite' },
    browser: {
      toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true }
    },
    ...overrides
  }
}

/** 去掉若干条记录之后的配置，模拟「删项目 / 删 host 连带删掉它上面全部 workspace」。 */
function without(...ids: readonly string[]): AppConfig {
  const base = config()
  return { ...base, workspaces: base.workspaces.filter((w) => !ids.includes(w.id)) }
}

describe('活动位的兜底次序', () => {
  it('活动的那个还在就一动不动——删的不是它', () => {
    // 挪走会让用户以为自己点错了：他删的是 B，屏幕却从 A 跳走。
    expect(reseatActiveWorkspaceId(without('project-b'), 'project-a')).toBe('project-a')
  })

  it('活动的那个被删了就落到 Scratch，而不是碰巧排第一的那个项目', () => {
    const next = without('project-a')
    expect(reseatActiveWorkspaceId(next, 'project-a')).toBe(SCRATCH_WORKSPACE_ID)
    // 反面写死：落到 `workspaces[0]` 会把用户丢进一个他没选的项目，而那个项目排第一纯属偶然。
    // 这一条是「同样删掉活动项目，从这里删和从那里删落到不同地方」那次漂移的靶子。
    expect(
      reseatActiveWorkspaceId(next, 'project-a'),
      '落到了第一条记录：用户被丢进一个他没选的项目'
    ).not.toBe(next.workspaces[0]!.id)
    // 自检：这两条只在 Scratch 不排第一时才互相排斥，否则上一句恒真。
    expect(next.workspaces[0]!.id, 'fixture 里 Scratch 排在第一，上面那条判据是恒真的').not.toBe(
      SCRATCH_WORKSPACE_ID
    )
  })

  it('调用方的偏好排在兜底之前，但排在「还在的活动位」之后', () => {
    // 扇出收尾：胜者就是答案——用户就是在看那几条 lane 才按下 Keep 的。
    expect(reseatActiveWorkspaceId(without('project-a'), 'project-a', 'project-b')).toBe('project-b')
    // 但活动位没被删时，偏好不许把它挪走。次序反了的症状是「删掉输家，屏幕却从我正在看的那个跳走」。
    expect(
      reseatActiveWorkspaceId(without('project-a'), 'project-b', 'project-a'),
      '偏好盖过了还在的活动位'
    ).toBe('project-b')
  })

  it('没有 Scratch 的配置（老配置、测试 fixture）仍给出一个落点', () => {
    const legacy = without(SCRATCH_WORKSPACE_ID, 'project-a')
    expect(reseatActiveWorkspaceId(legacy, 'project-a')).toBe('project-b')
  })

  it('一条记录都不剩就是 null，不假装有一个', () => {
    // 空配置下编一个活动位会把「空」这个事实藏起来，而那正是用户需要看到的。
    expect(reseatActiveWorkspaceId(without(...config().workspaces.map((w) => w.id)), 'project-a')).toBeNull()
  })

  it('adoptedConfig 在同一份补丁里同时给出 config 与活动位', () => {
    const next = without('project-a')
    const patch = adoptedConfig('project-a', next)
    // 两个字段必须一起出现。分两处写（先 set config、回头再挪活动位）时中间那一瞬 store 自相矛盾，
    // 任何在其间跑的 selector 都会读到一个指向不存在记录的活动位。
    expect(patch.config).toBe(next)
    expect(patch.activeWorkspaceId).toBe(SCRATCH_WORKSPACE_ID)
  })
})

const initialState = useAppStore.getState()

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

describe('让记录消失的写入点都走这个判断', () => {
  it('setConfig：删掉活动 workspace 的那次写入自己把活动位挪走', () => {
    useAppStore.setState({ config: config(), activeWorkspaceId: 'project-a' })
    // 这就是删 host 的形状：HostSettingsPane 按 hostId 过滤掉一整组 workspace，再经 setConfig 落地。
    useAppStore.getState().setConfig(without('project-a'))
    expect(
      useAppStore.getState().activeWorkspaceId,
      '活动位还指着已经不存在的记录：App 会渲染空白欢迎页'
    ).toBe(SCRATCH_WORKSPACE_ID)
  })

  it('setConfig：删的不是活动的那个就不动它', () => {
    useAppStore.setState({ config: config(), activeWorkspaceId: 'project-a' })
    useAppStore.getState().setConfig(without('project-b'))
    expect(useAppStore.getState().activeWorkspaceId).toBe('project-a')
  })

  it('removeWorktree：`removed` 用 outcome 自己带的 config，并挪走活动位', async () => {
    const next = without('project-a')
    vi.spyOn(api.workspaces, 'removeWorktree').mockResolvedValue({
      status: 'removed',
      removedPath: '/a',
      config: next
    })
    // 一次多余的 `api.config.get()` 就是一个能与这次移除结果不一致的窗口。钉住它没被调用。
    const reread = vi.spyOn(api.config, 'get')

    useAppStore.setState({ config: config(), activeWorkspaceId: 'project-a' })
    const outcome = await useAppStore.getState().removeWorktree({
      workspaceId: 'project-a',
      discardChanges: false
    })

    expect(outcome.status).toBe('removed')
    expect(useAppStore.getState().config).toBe(next)
    expect(
      useAppStore.getState().activeWorkspaceId,
      '删掉的正是活动 workspace，活动位却没挪：这就是 #398 的那一屏空白欢迎页'
    ).toBe(SCRATCH_WORKSPACE_ID)
    expect(reread, '又去 get() 了一次配置：多一次往返就多一个能与移除结果不一致的窗口').not.toHaveBeenCalled()
  })

  it('removeWorktree：`retained` 什么都没删，所以什么都不写，且理由原样交回调用方', async () => {
    vi.spyOn(api.workspaces, 'removeWorktree').mockResolvedValue({
      status: 'retained',
      reason: 'ZZREASONZZ'
    })
    const before = config()
    useAppStore.setState({ config: before, activeWorkspaceId: 'project-a' })

    const outcome = await useAppStore.getState().removeWorktree({
      workspaceId: 'project-a',
      discardChanges: false
    })

    // 压成 null 或 throw 会把 git 的理由吃掉，而单条移除要靠那句话在对话框里重问一次。
    expect(outcome).toEqual({ status: 'retained', reason: 'ZZREASONZZ' })
    expect(useAppStore.getState().config, '保护生效了却写了配置').toBe(before)
    expect(useAppStore.getState().activeWorkspaceId, '什么都没删却挪了活动位').toBe('project-a')
  })

  it('keepOneOfFanOut：输家被撤掉后活动位落到胜者身上', async () => {
    // 用户正看着某条 lane 按下 Keep，而那条 lane 恰好是被撤掉的输家之一。
    const next = without('project-a')
    vi.spyOn(api.workspaces, 'keepOneOfFanOut').mockResolvedValue({
      keptWorkspaceId: 'project-b',
      outcomes: []
    })
    vi.spyOn(api.config, 'get').mockResolvedValue(next)

    useAppStore.setState({ config: config(), activeWorkspaceId: 'project-a' })
    await useAppStore.getState().keepOneOfFanOut({
      keepWorkspaceId: 'project-b',
      removeWorkspaceIds: ['project-a']
    })

    // 落到胜者而不是通用兜底（Scratch）：「留下这一个」这句话本身就说明了该看哪儿。
    expect(
      useAppStore.getState().activeWorkspaceId,
      '活动位没落到胜者身上——Keep 之后屏幕跳到了别处'
    ).toBe('project-b')
  })
})

describe('这个判断只有一份', () => {
  /**
   * 兜底规则不许被第二处重新发明。
   *
   * 这条守的是**真发生过**的漂移：启动恢复那份挑 `workspaces[0]`，侧栏删项目那份挑 Scratch，而
   * 因为 config-store 把 Scratch 追加在末尾，两者**真的落到不同的 Workspace**。判据是「找 Scratch」
   * 这个动作在 renderer 里只出现在这个 lib 与已知的几个正当消费者里，而不是数某个字面量出现几次
   * ——后者换个拼法就绕过（本仓 counting-a-symbol-misses-other-spellings）。
   */
  it('renderer 里没有第二处「删完之后落到哪」的兜底', () => {
    const source = readFileSync(STORE.pathname, 'utf8')
    // store 里读活动位兜底的唯一出口就是这个 lib。出现 `workspaces[0]` 说明有人又手算了一次。
    expect(
      source.includes('workspaces[0]'),
      'store 里又出现了 workspaces[0] 兜底：与 lib 里的 Scratch 规则会落到不同的 Workspace'
    ).toBe(false)

    // 自检：这个 lib 真的被 store 引用着。少了它，上面那条会在"store 根本不管活动位"时也通过。
    expect(source).toContain("from './lib/active-workspace-reseat'")
  })

  /**
   * 每个**写进 store** 的 config 都必须在同一份补丁里带着活动位的答案。
   *
   * 判据落在「这个字面量是 `set()` 的实参吗」上，而不是「文件里有 `config:` 吗」：后者会把
   * `restorePersistedWorkbench({ config, sessions, ... })` 这种**入参**也算进来（实测它就是这么误报的），
   * 而入参根本不改 store。误报的代价不是烦人而是危险——为了消掉误报去放宽判据，最后放掉的就是真的。
   *
   * `...adoptedConfig(...)` / `...restoredUi` 这类展开也算答案：前者按定义把两个字段一起给出，后者
   * 的类型 `RestoredUiState` 把 `activeWorkspaceId` 列为必填，所以漏了它 tsc 会红。
   */
  it('每个写进 store 的 config 都带着活动位的答案', () => {
    const file = ts.createSourceFile(
      STORE.pathname,
      readFileSync(STORE.pathname, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    )

    // 收集所有对象字面量，判据是「它（或包着它的箭头函数）是某次 set() 的实参」。
    const patches: ts.ObjectLiteralExpression[] = []
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : null
        if (name === 'set' || name === 'setState') {
          for (const arg of node.arguments) {
            if (ts.isObjectLiteralExpression(arg)) patches.push(arg)
            // `set((state) => ({ ... }))`：取箭头函数的返回字面量。
            if (ts.isArrowFunction(arg)) {
              if (ts.isParenthesizedExpression(arg.body) && ts.isObjectLiteralExpression(arg.body.expression)) {
                patches.push(arg.body.expression)
              } else if (ts.isObjectLiteralExpression(arg.body)) {
                patches.push(arg.body)
              } else if (ts.isBlock(arg.body)) {
                arg.body.forEachChild((stmt) => {
                  if (ts.isReturnStatement(stmt) && stmt.expression !== undefined) {
                    const returned = ts.isParenthesizedExpression(stmt.expression)
                      ? stmt.expression.expression
                      : stmt.expression
                    if (ts.isObjectLiteralExpression(returned)) patches.push(returned)
                  }
                })
              }
            }
          }
        }
      }
      node.forEachChild(walk)
    }
    walk(file)

    // 自检：一个 set 补丁都没收集到说明遍历方式失效了，下面的循环会空转而恒绿。
    expect(patches.length, '收集不到任何 set() 补丁——判据落空了').toBeGreaterThan(5)

    const offenders: string[] = []
    let writesConfig = 0
    for (const patch of patches) {
      const names = patch.properties
        .map((p) => (p.name !== undefined && ts.isIdentifier(p.name) ? p.name.text : null))
        .filter((n): n is string => n !== null)
      if (!names.includes('config')) continue
      writesConfig += 1
      const text = patch.getText()
      const answered =
        names.includes('activeWorkspaceId') ||
        text.includes('adoptedConfig') ||
        text.includes('reseatActiveWorkspaceId') ||
        // `...restoredUi` 的类型把 activeWorkspaceId 列为必填，漏掉它 tsc 就红。
        text.includes('...restoredUi')
      if (!answered) {
        const { line } = file.getLineAndCharacterOfPosition(patch.getStart())
        offenders.push(`store.ts:${line + 1}`)
      }
    }

    // 第二条自检：一个写 config 的补丁都找不到时，上面的判据同样是恒真的。
    expect(writesConfig, '没有任何 set() 补丁写 config——判据落空了').toBeGreaterThan(0)
    expect(
      offenders,
      `这些地方把 config 写进 store 却没回答「活动位怎么办」：${offenders.join(', ')}。` +
        '删 host / 删项目都会让记录消失，漏一处就是一屏没有解释的空白欢迎页'
    ).toEqual([])
  })
})
