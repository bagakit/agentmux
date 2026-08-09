import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { api } from '../src/renderer/src/lib/api.js'
import { bumpWorkspaceFileRevision } from '../src/renderer/src/lib/file-workbench-state.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics.js'
import type { AppConfig } from '../src/shared/contracts.js'
import { useAppStore } from '../src/renderer/src/store.js'

// ---------------------------------------------------------------------------
// 文件树的失效计数器：每个「往 Workspace 里写文件」的面都必须让它前进。
//
// 这个派生原先在 store.ts 里逐字手抄了 5 份（保存 scratch 文档 / 建 topic / 改 topic 标题 /
// 建笔记 / 启动 scratch topic 的 agent），横跨 documents、scratch、sessions 三个关注组。
// 抄得多不是问题本身——问题是漏抄**完全静默**：文件在盘上、树自信地是旧的，新文件要等别的
// 写入面碰巧 bump 才出现。同一形状已经在 #266 复审里被抓到过一次（当时是把自增写成常量 1）。
// ---------------------------------------------------------------------------
describe('bumpWorkspaceFileRevision', () => {
  it('没有记录时从 1 起步，而不是留在 undefined', () => {
    // 缺省必须落到一个**具体数字**：留 undefined 或 NaN 会让下游的相等比较永远为假，
    // 树于是每帧都认为自己过期——与漏 bump 相反的方向，但同样是坏的。
    expect(bumpWorkspaceFileRevision({}, 'workspace')).toEqual({ workspace: 1 })
  })

  it('已有记录时前进一格（不是重置成 1，也不是恒等于 1）', () => {
    // 写成常量 1 与正确实现在**第一次**调用上完全无法区分，所以这里从 7 起判。
    expect(bumpWorkspaceFileRevision({ workspace: 7 }, 'workspace')).toEqual({ workspace: 8 })
  })

  it('只动目标 Workspace，别人的计数原样保留', () => {
    // 顺带把别人的清掉，症状是另一个项目的文件树无端全量刷新（性能问题，且看起来像闪烁）。
    const before = { a: 3, b: 5 }
    expect(bumpWorkspaceFileRevision(before, 'b')).toEqual({ a: 3, b: 6 })
  })

  it('不就地改传入的对象——zustand 靠引用变化判重渲染', () => {
    // 就地改会让 set() 拿到同一个引用：值对了，订阅者却收不到通知，于是树还是不刷新。
    // 这一条与上面三条判的是不同的事，不能靠它们蕴含。
    const before = { workspace: 2 }
    const after = bumpWorkspaceFileRevision(before, 'workspace')
    expect(before).toEqual({ workspace: 2 })
    expect(after).not.toBe(before)
  })
})

// ---------------------------------------------------------------------------
// 上面测的是「这个函数算得对」。下面这条测的是「store 里没人绕过它自己手写一遍」——
// 清理本身不是交付物，能挡住下一份手抄的检测器才是。没有这条，第六个写入面照旧会
// 复制粘贴出第六份，而那时上面四条仍然全绿。
// ---------------------------------------------------------------------------
describe('store 只经由这个函数改失效计数', () => {
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')

  /**
   * 手抄那份长这样（空白可任意）：
   *   [workspace.id]: (current.workspaceFileRevisions[workspace.id] ?? 0) + 1
   * 判据落在**取下标再自增**这个动作上，而不是某个具体的变量名——换个变量名照样是手抄。
   *
   * 缺省拼法要列全：对抗 review 实测把 `?? 0` 换成 `|| 0` 就能绕过只认前者的正则，
   * 而两者在这里等价（缺席与 0 都该从 1 起步）。所以判的是「取下标 → 补缺省 → +1」这个
   * 形状，缺省那一步接受任意一种写法。
   */
  const DEFAULTING = String.raw`(?:\?\?|\|\|)\s*0`
  const handWrittenBump = new RegExp(
    String.raw`workspaceFileRevisions\s*\[[^\]]+\]\s*${DEFAULTING}\s*\)?\s*\+\s*1`
  )

  it('前提自检：这个正则认得每一种缺省拼法，不是一个只认 ?? 的窄判据', () => {
    // 没有这条，把正则写错（比如多一个字符）会让整条守卫静默变成恒绿。
    // 逐拼法各给一个样本：漏掉任何一种都会让那种写法的手抄免检——`|| 0` 那一种是实测survive的。
    for (const defaulting of ['?? 0', '|| 0', '??0', '||  0']) {
      const sample = `[workspace.id]: (current.workspaceFileRevisions[workspace.id] ${defaulting}) + 1`
      expect(handWrittenBump.test(sample), `缺省写成 ${defaulting} 的手抄逃过了判据`).toBe(true)
    }
  })

  it('store.ts 里没有手写的自增', () => {
    expect(store).not.toMatch(handWrittenBump)
  })

  it('前提自检：store 确实是从这个 lib 导入的，判据没有挂在空处', () => {
    // 判 import 关系而不是判裸标识符出现过：一个同名的本地函数能骗过后者
    // （store.ts 有 4000 行，本地重定义一个同名 helper 完全不显眼），
    // 而那样一来「唯一入口」就又变成两个了。
    expect(store).toMatch(
      /import\s*\{[^}]*\bbumpWorkspaceFileRevision\b[^}]*\}\s*from\s*'\.\/lib\/file-workbench-state'/s
    )
  })

  it('八个写入面都还在调它', () => {
    // 数调用次数是刻意的：上面那条 not.toMatch 只证明「没有手抄」，
    // 把某个面的 bump 整行删掉同样能满足它——那正是漏 bump 的原样子。
    // 八个面 = 保存 scratch 文档 / 建 topic / 改 topic 标题 / 建笔记 / 启动 scratch agent
    //        + 建路径 / 改名 / 删路径（后三个是 FileExplorer 的写入面）。
    // 这条守不住「新增第九个面却忘了 bump」（没有任何文本判据能守住那个），
    // 但守得住「已有的八个被悄悄拆掉一个」。
    expect(store.split('bumpWorkspaceFileRevision(').length - 1).toBe(8)
  })
})

// ---------------------------------------------------------------------------
// 上面两族**都是文本判据**，而文本看不见实参。对抗 review 用五个单点变异证明了这个盲区：
// 调了却丢弃返回值、传错 workspace id、把第一个实参换成 `{}`（清掉别人的计数）、
// 用 `|| 0` 另抄一份、把两个实参对调——每一个都让 8 条全绿。
//
// 换句话说：「这个函数算得对」和「store 里有这行字」加在一起，仍然不等于「调用点算得对」。
// 所以下面这族真的把动作跑起来，判**计数器的取值**：目标 +1 且他人分毫不动。
// 这一条判据同时杀掉上述四种（第五种是实参对调，tsc 本就能挡，除非有人加 as unknown as）。
// 参考记忆 extracting-to-lib-only-fixes-half：抽进 lib 只解决一半。
// ---------------------------------------------------------------------------
const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [
    { id: SCRATCH_WORKSPACE_ID, name: 'Scratch', hostId: 'local', path: '/scratch', kind: 'folder' },
    { id: 'bystander', name: 'Other', hostId: 'local', path: '/other', kind: 'folder' }
  ],
  appearance: { terminalTheme: 'graphite' },
  browser: {
    toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true }
  }
}

describe('每个写入面真的让目标 Workspace 的计数前进，且只动它', () => {
  const initialState = useAppStore.getState()

  afterEach(() => {
    vi.restoreAllMocks()
    useAppStore.setState(initialState, true)
  })

  /**
   * 旁观者那格刻意给一个**非零且不相邻**的数：写成常量、写成 `+ 1` 作用到错的键、
   * 或者把整张表换成 `{}`，都会让它变成 undefined 或 1，与 41 一眼可分。
   */
  const BYSTANDER_REVISION = 41
  const TARGET_REVISION = 7

  function scratchFixture(): void {
    useAppStore.setState({
      config,
      activeWorkspaceId: SCRATCH_WORKSPACE_ID,
      layouts: {
        [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('scratch-pane'),
        bystander: createWorkspaceLayout('other-pane')
      },
      workspaceFileRevisions: {
        [SCRATCH_WORKSPACE_ID]: TARGET_REVISION,
        bystander: BYSTANDER_REVISION
      }
    })
  }

  function revisions(): Record<string, number> {
    return useAppStore.getState().workspaceFileRevisions
  }

  it('前提自检：fixture 真的把两格都摆上了，判据没有从零开始', () => {
    // 若初值是 undefined，「+1 之后是 8」这条会退化成「是 1」，而常量实现也给 1。
    scratchFixture()
    expect(revisions()).toEqual({
      [SCRATCH_WORKSPACE_ID]: TARGET_REVISION,
      bystander: BYSTANDER_REVISION
    })
  })

  it('建 Topic：目标 +1，旁观者不动', async () => {
    scratchFixture()
    await useAppStore.getState().createScratchTopic()
    expect(revisions()[SCRATCH_WORKSPACE_ID]).toBe(TARGET_REVISION + 1)
    expect(revisions().bystander).toBe(BYSTANDER_REVISION)
  })

  it('改 Topic 标题：目标 +1，旁观者不动', async () => {
    scratchFixture()
    const created = await useAppStore.getState().createScratchTopic()
    const afterCreate = revisions()[SCRATCH_WORKSPACE_ID]!
    await useAppStore.getState().renameScratchTopic(created.id, 'Renamed')
    expect(revisions()[SCRATCH_WORKSPACE_ID]).toBe(afterCreate + 1)
    expect(revisions().bystander).toBe(BYSTANDER_REVISION)
  })

  it('建笔记：目标 +1，旁观者不动', async () => {
    scratchFixture()
    await useAppStore.getState().createNote()
    expect(revisions()[SCRATCH_WORKSPACE_ID]).toBe(TARGET_REVISION + 1)
    expect(revisions().bystander).toBe(BYSTANDER_REVISION)
  })

  // -------------------------------------------------------------------------
  // 文件树自己刷新，不代表别的读者也刷新了。
  //
  // `createPath` / `renamePath` / `deletePath` 三个 action 原先都不 bump，理由是一条**没写下来**
  // 的不变量：FileExplorer 是它们唯一的调用方，而它在 `commitEdit` / `confirmDelete` / 移动之后
  // 各自直接 `tree.refreshDir(parent)`。这条推理对文件树成立，对别的读者不成立——
  // `SurfaceToolDock` 的 Topics 面板与 Board 的 `useScratchTopics` 都**只**认这个计数器
  // （各自 effect 的依赖就是 `[fileRevision, workspace.id]`），文件树刷新它们看不见。
  //
  // 用户可见症状：在 Scratch 里右键一个 Topic 文件夹 → 删除（或选中按 ⌫）。树里那行消失了，
  // 而 Topics 面板与 Board 上那个 Topic 一直在，直到某个无关写入面碰巧 bump 一次。而删文件夹
  // **就是**删 Topic 的唯一途径：没有 `scratch.deleteTopic` API，dock 也没有删除按钮，且删除
  // 入口对 Topic 目录刻意未设门槛（rename/move 都过 `canRenameFileExplorerNode`，删除不过）。
  //
  // 修法是让三个 action 都 bump，而不是给那条不变量补一段注释。理由是记忆
  // `expired-reason-for-not-mapping`：「今天只有 FileExplorer 调它」是会过期的理由，而下一个
  // 调用方（`git.discard` 已在 main 侧接好、renderer 侧还没有入口）不会回头读这段推理。
  // 让前提消失比给前提写文档稳。多 bump 一次的代价是文件树多扫一遍，与静默显示鬼影不对等。
  // -------------------------------------------------------------------------

  it('删路径：目标 +1，旁观者不动——Topics 面板与 Board 只认这个计数器', async () => {
    scratchFixture()
    await useAppStore.getState().createPath({ path: 'doomed', kind: 'directory' })
    const afterCreate = revisions()[SCRATCH_WORKSPACE_ID]!

    await useAppStore.getState().deletePath('doomed')

    expect(
      revisions()[SCRATCH_WORKSPACE_ID],
      '删除不 bump——Topics 面板与 Board 会一直显示已经删掉的 Topic'
    ).toBe(afterCreate + 1)
    expect(revisions().bystander).toBe(BYSTANDER_REVISION)
  })

  it('建路径：目标 +1，旁观者不动', async () => {
    // `createNote` 那条走的是它自己那行 `api.files.create`（刻意绕开 createPath，见其注释），
    // 所以它绿不能证明这一条。FileExplorer 的「新建文件/文件夹」走的才是这里。
    scratchFixture()
    await useAppStore.getState().createPath({ path: 'fresh.md', kind: 'file' })
    expect(revisions()[SCRATCH_WORKSPACE_ID], '新建不 bump').toBe(TARGET_REVISION + 1)
    expect(revisions().bystander).toBe(BYSTANDER_REVISION)
  })

  it('改名：目标 +1，旁观者不动——Topic 正文被移走就不再是 Topic 了', async () => {
    // `canRenameFileExplorerNode` 只挡顶层的 Topic **目录**；目录**里面**的文件（含 `topic.md`）
    // 照旧可改名/可移动。把 `topic.md` 移走就破坏了 Topic 身份（`isScratchTopicDocument` 要求
    // 文件名恰好是它），而面板不会重扫。
    scratchFixture()
    await useAppStore.getState().createPath({ path: 'before.md', kind: 'file' })
    const afterCreate = revisions()[SCRATCH_WORKSPACE_ID]!

    await useAppStore.getState().renamePath('before.md', 'after.md')

    expect(revisions()[SCRATCH_WORKSPACE_ID], '改名不 bump').toBe(afterCreate + 1)
    expect(revisions().bystander).toBe(BYSTANDER_REVISION)
  })

  // -------------------------------------------------------------------------
  // 上面每一条都只判「跑完之后计数对不对」，于是 bump 落在 `await api.files.create` 的**哪一侧**
  // 完全不可观测：把它挪到 await 之前，上面 46 条全绿（实测）。
  //
  // 两侧的差别是真的：文件树、Topics 面板、Board 都在 effect 里读这个计数，读到就去重扫。
  // 先 bump 则它们在文件还没落盘时扫一遍——扫到的是创建**之前**的目录内容，而此后不再有第二次
  // bump，于是面板永久停在旧状态，与漏 bump 同形。远端 create 可达 15s，这个窗口不是理论上的。
  //
  // 判据必须让「创建还没完成」这个中间状态可观测，所以这里把 create 卡在一个手动 resolve 的
  // promise 上：卡住期间计数必须**没动**，resolve 之后才 +1。删掉「卡住期间没动」那条断言，
  // 变异就又隐形了——这一条不能靠「跑完是 +1」蕴含。
  // -------------------------------------------------------------------------
  it('建路径：创建真的完成之后才 bump，不是发出请求就 bump', async () => {
    scratchFixture()
    let releaseCreate: (() => void) | undefined
    const created = new Promise<void>((resolve) => { releaseCreate = resolve })
    const create = vi.spyOn(api.files, 'create').mockReturnValue(created)

    const pending = useAppStore.getState().createPath({ path: 'slow.md', kind: 'file' })
    // 前提自检：请求真的发出去了、也真的还卡着。若 spy 没生效（比如 api 形状变了），
    // 下面那条「还没动」会在一个**已经跑完**的世界里成立，整条守卫退化成恒真。
    expect(create, 'createPath 没有调 api.files.create，这条用例观察不到那个窗口').toHaveBeenCalledTimes(1)
    expect(
      revisions()[SCRATCH_WORKSPACE_ID],
      '文件还没建好就 bump 了——面板会扫到创建前的内容，而之后不再有第二次 bump'
    ).toBe(TARGET_REVISION)

    releaseCreate!()
    await pending

    expect(revisions()[SCRATCH_WORKSPACE_ID], '创建完成后没有 bump').toBe(TARGET_REVISION + 1)
    expect(revisions().bystander).toBe(BYSTANDER_REVISION)
  })

  it('建路径失败时一次都不 bump——白扫一遍树，且掩盖了真正的失败', async () => {
    // 与上一条是同一个 await 边界的另一侧。失败路径上 bump 的代价不只是多扫一遍：
    // 用户看到树自己刷新了一下，会以为创建成功了。
    scratchFixture()
    vi.spyOn(api.files, 'create').mockRejectedValue(new Error('EACCES'))

    await expect(useAppStore.getState().createPath({ path: 'denied.md', kind: 'file' })).rejects.toThrow()

    expect(revisions()[SCRATCH_WORKSPACE_ID], '创建失败却 bump 了').toBe(TARGET_REVISION)
    expect(revisions().bystander).toBe(BYSTANDER_REVISION)
  })
})
