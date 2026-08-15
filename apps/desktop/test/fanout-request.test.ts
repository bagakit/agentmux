import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runFanOutRequest, type FanOutRequestPorts } from '../src/main/fanout-request.js'
import type {
  AppConfig,
  RunFanOutInput,
  WorkspaceBranchesSnapshot,
  WorkspaceRecord,
  WorktreeRetention
} from '../src/shared/contracts.js'

/**
 * 三档保留的全集，手抄在测试这边。
 *
 * 不从实现导出一张表：从被测对象派生期望值时，映射改窄期望值会跟着漂移，判据恒真。加第四档时这里会
 * 红，而那正是要它红的时候——「新那档 lane 该怎么说」是一次判断。
 */
const RETENTIONS: readonly WorktreeRetention[] = [
  'uncommitted-changes',
  'git-failed',
  'record-not-withdrawn'
]

// ---------------------------------------------------------------------------
// 一次扇出请求，从头跑到尾。
//
// 此前守这条链子的是 fanout-wiring.test.ts 一族 `readFileSync` + `toContain('runFanOut(')`。
// 文本断言看不见那段编排有没有被执行到：在 ipc.ts 的 handler 第一行插一句
// `return { kind: 'rejected', reason: ... }`，planFanOut / runFanOut / 整段编排全部变成死代码、
// 扇出对用户**永久返回 rejected**，而 5 条断言全绿（实测；死代码里那些标识符照旧存在）。
// handler 当时长在 registerIpc 的闭包里，本仓没有任何测试 import 得到它。
//
// 现在编排在 fanout-request 里、由注入的 ports 表达外界需求，所以这里真跑它。
// ---------------------------------------------------------------------------

const CONFIG: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [
    { id: 'repo', name: 'Main', hostId: 'local', path: '/repo', kind: 'folder' }
  ],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

function gitRepository(
  branches: WorkspaceBranchesSnapshot extends { kind: 'git-repository'; branches: infer T } ? T : never = []
): WorkspaceBranchesSnapshot {
  return { kind: 'git-repository', hostId: 'local', repoPath: '/repo', branches }
}

type Recorded = {
  created: Array<{ branch: string; path: string }>
  launched: Array<{ executorId: string; workspacePath: string; prompt: string }>
  removed: string[]
  committed: AppConfig[]
  /** 每次 lanes 工厂被调用时交下来的源 workspace——启动 Agent 要用它的 hostId。 */
  laneSources: WorkspaceRecord[]
}

/** 一套全部成功的 ports，外加它记下的每一次调用——断言直接看这些记录。 */
function ports(overrides: Partial<FanOutRequestPorts> = {}): FanOutRequestPorts & { recorded: Recorded } {
  const recorded: Recorded = { created: [], launched: [], removed: [], committed: [], laneSources: [] }
  let laneSeq = 0
  const base: FanOutRequestPorts = {
    config: () => CONFIG,
    listBranches: async () => gitRepository(),
    commitConfig: (next) => recorded.committed.push(next),
    lanes: (source) => {
      recorded.laneSources.push(source)
      return {
        createWorktree: async (input, config) => {
          recorded.created.push({ branch: input.branch, path: input.path })
          laneSeq += 1
          const workspace = { id: `lane-${laneSeq}`, path: input.path }
          return {
            // config 逐 lane 前进：这份 workspaces 会被下一条 lane 看到。
            config: { ...config, workspaces: [...config.workspaces, { ...workspace, name: input.branch, hostId: 'local', kind: 'worktree' as const, repoPath: '/repo', branch: input.branch }] },
            workspace
          }
        },
        launchAgent: async (input) => {
          recorded.launched.push({
            executorId: input.executorId,
            workspacePath: input.workspacePath,
            prompt: input.prompt
          })
          return { sessionId: `session-${recorded.launched.length}` }
        },
        removeWorktree: async (input, config) => {
          recorded.removed.push(input.workspaceId)
          return { config }
        }
      }
    }
  }
  return { ...base, ...overrides, recorded }
}

const REQUEST: RunFanOutInput = {
  workspaceId: 'repo',
  prompt: 'try three ways',
  count: 3,
  baseName: 'bake',
  executorIds: ['codex', 'claude']
}

describe('一次扇出请求真的跑到底', () => {
  it('三条 lane 各建 worktree 各启 Agent，结果如实回报', async () => {
    const p = ports()
    const result = await runFanOutRequest(REQUEST, p)

    expect(result.kind).toBe('fanout')
    if (result.kind !== 'fanout') return
    // 这是整条链子最要紧的一条：早退变异之下这里会是 rejected 且下面每一条都拿不到东西。
    expect(result.lanes).toHaveLength(3)
    expect(result.lanes.map((lane) => lane.status)).toEqual(['launched', 'launched', 'launched'])

    // 三条 worktree 真的被要求创建，且分支名互不相同（命名唯一来源是 planFanOut）。
    expect(p.recorded.created).toHaveLength(3)
    expect(new Set(p.recorded.created.map((item) => item.branch)).size).toBe(3)
    // 三个 Agent 真的被要求启动，prompt 原样送到每一条 lane。
    expect(p.recorded.launched.map((item) => item.prompt)).toEqual([
      'try three ways',
      'try three ways',
      'try three ways'
    ])
    // 启动发生在这条 lane 自己的 worktree 目录里，而不是仓库根目录——搞错了三个 Agent 会挤在一起。
    expect(p.recorded.launched.map((item) => item.workspacePath)).toEqual(
      p.recorded.created.map((item) => item.path)
    )
    // executor 少于 lane 数时循环复用。
    expect(p.recorded.launched.map((item) => item.executorId)).toEqual(['codex', 'claude', 'codex'])
    // 成功的 lane 注册了 worktree，config 因此必须回写——不回写，重启后那几个 worktree 无人认领。
    expect(p.recorded.committed).toHaveLength(1)
    expect(p.recorded.committed[0]!.workspaces.map((item) => item.id)).toEqual([
      'repo',
      'lane-1',
      'lane-2',
      'lane-3'
    ])
  })

  it('worktree 根目录来自仓库根，不是 workspace 自己的 path', async () => {
    const p = ports()
    await runFanOutRequest(REQUEST, p)
    for (const created of p.recorded.created) {
      expect(created.path.startsWith(join('/repo', '.worktrees'))).toBe(true)
    }
  })

  /**
   * 子目录 workspace：`workspace.path` 与 `repoPath` 头一回不是同一个字符串。
   *
   * 上面那条用的夹具里两者都是 `/repo`，于是它对「根到底取的哪一个」完全失明——取错了照样全绿。
   * 这条是唯一能分辨的那个形状，而它不是假想：文件树的「Open as Project」正是把仓库里的一个子目录
   * 注册成 workspace（open-directory-as-project.ts 用 `joinWorkspacePath` 往下拼）。
   *
   * 判据落在**根**上而不是落在「路径里有没有 .worktrees」上：后者对 `/repo/sub/.worktrees` 同样成立，
   * 而那恰恰是错的那一个。
   */
  it('workspace 是仓库的子目录时，lane 仍落在仓库根下——否则 exclude 那条锚定的规则盖不住它', async () => {
    const p = ports({
      config: () => ({
        ...CONFIG,
        workspaces: [{ id: 'repo', name: 'Sub', hostId: 'local', path: '/repo/sub', kind: 'folder' }]
      })
    })
    await runFanOutRequest(REQUEST, p)

    expect(p.recorded.created).toHaveLength(3)
    for (const created of p.recorded.created) {
      expect(created.path.startsWith(join('/repo', '.worktrees'))).toBe(true)
      // 取 workspace.path 的那颗变异体落在这里：`/repo/sub/.worktrees/bake-1` 同样「含 .worktrees」，
      // 但仓根的 `/.worktrees/` 是锚定的，盖不住 `sub/` 下面那一层（真 git 验过：`?? sub/.worktrees/`）。
      expect(created.path.startsWith(join('/repo', 'sub'))).toBe(false)
    }
  })

  it('lane 的 ports 拿到的是已解析的源 workspace——启动 Agent 的 host 由它决定', async () => {
    const p = ports()
    await runFanOutRequest(REQUEST, p)
    // 只解析一次并交下来。handler 若自己再查一遍，那次查找有它自己的失败文案，
    // 同一个概念就有了两处判定。
    expect(p.recorded.laneSources.map((item) => item.id)).toEqual(['repo'])
    expect(p.recorded.laneSources[0]!.hostId).toBe('local')
  })

  it('不是 git 仓库就如实拒绝，一条 lane 都不许起', async () => {
    const p = ports({
      listBranches: async () => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: '/repo' })
    })
    const result = await runFanOutRequest(REQUEST, p)
    expect(result).toEqual({ kind: 'rejected', reason: 'A fan-out needs a git repository.' })
    // 拒绝之后不许有任何副作用留在盘上。
    expect(p.recorded.created).toEqual([])
    expect(p.recorded.launched).toEqual([])
    expect(p.recorded.committed).toEqual([])
  })

  it('计划被拒时原样交还理由，不吞掉也不改写', async () => {
    const p = ports()
    // count 为 0：planFanOut 自己会拒，理由必须是它的话。
    const result = await runFanOutRequest({ ...REQUEST, count: 0 }, p)
    expect(result.kind).toBe('rejected')
    if (result.kind !== 'rejected') return
    expect(result.reason).toBeTruthy()
    expect(p.recorded.created).toEqual([])
  })

  it('单 lane 原样交还 single——一条 lane 不是 bake-off', async () => {
    const p = ports()
    const result = await runFanOutRequest({ ...REQUEST, count: 1 }, p)
    expect(result).toEqual({ kind: 'single', executorId: 'codex' })
    // 不许悄悄按扇出跑掉：那会为"和空无一物比较"付出编排代价。
    expect(p.recorded.created).toEqual([])
    expect(p.recorded.launched).toEqual([])
  })

  it('workspace 不存在时响亮失败，不静默返回空扇出', async () => {
    const p = ports()
    await expect(runFanOutRequest({ ...REQUEST, workspaceId: 'ghost' }, p)).rejects.toThrow(
      'Fan-out needs an existing workspace'
    )
    expect(p.recorded.created).toEqual([])
  })

  it('已存在的分支不被撞名——命名躲开它们', async () => {
    const p = ports({
      listBranches: async () =>
        gitRepository([
          { name: 'bake-1', worktreePath: join('/repo', '.worktrees', 'bake-1') } as never
        ])
    })
    const result = await runFanOutRequest(REQUEST, p)
    expect(result.kind).toBe('fanout')
    for (const created of p.recorded.created) {
      expect(created.branch).not.toBe('bake-1')
      expect(created.path).not.toBe(join('/repo', '.worktrees', 'bake-1'))
    }
  })

  it('一条 lane 建 worktree 失败，其余照跑——bake-off 的意义在成的那几条', async () => {
    const p = ports()
    let attempt = 0
    const failing = ports({
      lanes: (source) => {
        const lanes = p.lanes(source)
        return {
          ...lanes,
          createWorktree: async (input, config) => {
            attempt += 1
            if (attempt === 2) throw new Error('worktree add refused')
            return await lanes.createWorktree(input, config)
          }
        }
      }
    })
    const result = await runFanOutRequest(REQUEST, failing)
    expect(result.kind).toBe('fanout')
    if (result.kind !== 'fanout') return
    // 失败的那条如实标记，成的两条照旧 launched——不是整体抛出，也不是整体成功。
    expect(result.lanes.map((lane) => lane.status)).toEqual([
      'launched',
      'worktree-failed',
      'launched'
    ])
  })

  it('启动失败时说清 worktree 还在不在盘上', async () => {
    const p = ports()
    const failing = ports({
      lanes: (source) => ({
        ...p.lanes(source),
        launchAgent: async () => {
          throw new Error('executor missing')
        }
      })
    })
    const result = await runFanOutRequest(REQUEST, failing)
    expect(result.kind).toBe('fanout')
    if (result.kind !== 'fanout') return
    for (const lane of result.lanes) {
      expect(lane.status).toBe('launch-failed')
      // 不说清就会变成没人认领的孤儿目录。`cleanup` 是三档保留之一或 `null`（交回去了），而不是一个
      // 布尔——布尔答不出「git 删掉了目录、只是记录没撤下」那一档。
      if (lane.status === 'launch-failed') {
        expect(
          lane.cleanup === null || RETENTIONS.includes(lane.cleanup.retention),
          `cleanup 不是三档保留之一也不是 null：${JSON.stringify(lane.cleanup)}`
        ).toBe(true)
      }
    }
  })
})

describe('handler 那层壳没有可以插早退的地方', () => {
  const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
  const code = ipc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  it('自检：真的截到了那个 handler', () => {
    expect(code).toContain("handle('workspaces:runFanOut'")
  })

  it('编排不许回到 ipc.ts —— 那里没有任何测试够得着', () => {
    // 这才是真正的守卫。handler 里一旦重新出现语句体，`return { kind: 'rejected' }` 就又能在
    // 全绿之下让扇出对用户永久失效。判据是 handler 用的是表达式体箭头函数（`=>` 后面直接
    // 跟调用，没有 `{`），于是插不进任何语句。
    const at = code.indexOf("handle('workspaces:runFanOut'")
    const head = code.slice(at, at + 400)
    expect(
      head,
      'runFanOut handler 又有了语句体——插一句早退就能让整个扇出静默变 rejected'
    ).toMatch(/handle\('workspaces:runFanOut',\s*async\s*\([^)]*\)\s*:\s*Promise<RunFanOutResult>\s*=>\s*\n?\s*await runFanOutRequest\(/)
  })

  it('计划与编排两个模块都不许被 ipc.ts import 回去', () => {
    // 判据是 **import 关系**，不是调用点的字面形状。我第一版写的是
    // `not.toContain('planFanOut(')`，而把 `planFanOut` 作为裸标识符提回 ipc.ts（不带括号）
    // 就绕过去了——实测那颗变异 16 条全绿。能被 import 就能被调用，所以守 import。
    for (const module of ['./fanout-plan.js', './fanout-run.js']) {
      expect(
        code,
        `ipc.ts 又 import 了 ${module}——那意味着一段没人跑得到的编排落回了 registerIpc 的闭包里`
      ).not.toContain(module)
    }
    // 自检：它 import 的是那个转发出口，否则上面两条会因为"整个文件读空"而恒绿。
    expect(code).toContain('./fanout-request.js')
  })
})
