import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  createFileExplorerDirLoadScope,
  createFileExplorerDirLoadTracker
} from '../src/renderer/src/components/file-tree/file-explorer-dir-load-tracker.js'
import { resolveFileExplorerNavigationTarget } from '../src/renderer/src/components/file-tree/file-explorer-keyboard-navigation.js'
import {
  getRevealAncestorPaths,
  isPathWithinSubtree,
  joinWorkspacePath,
  remapPathWithinSubtree
} from '../src/renderer/src/lib/workspace-paths.js'
import { createFileExplorerRowProjection } from '../src/renderer/src/components/file-tree/file-explorer-row-projection.js'
import {
  createEmptyFileExplorerSelection,
  createSingleFileExplorerSelection,
  getFileExplorerSelectionMode,
  revealFileExplorerPath,
  updateFileExplorerSelection,
  updateFileExplorerSelectionPaths
} from '../src/renderer/src/lib/file-explorer-selection.js'
import {
  collectStaleDirCachePaths,
  decideExpandedDirLoad,
  presentExpandedDir
} from '../src/renderer/src/components/file-tree/file-explorer-stale-dir-cache.js'
import type { DirCache, TreeNode } from '../src/renderer/src/components/file-tree/file-explorer-types.js'
import {
  fileExplorerDropDirectory,
  fileExplorerMoveTargets,
  isFileExplorerMenuKey,
  planFileExplorerMove,
  runFileExplorerMove,
  FILE_EXPLORER_DELETE_KEY,
  FILE_EXPLORER_RENAME_KEY
} from '../src/renderer/src/lib/file-explorer-move.js'

function node(path: string, depth: number, isDirectory = false): TreeNode {
  return {
    name: path.split('/').at(-1) ?? path,
    path,
    relativePath: path,
    isDirectory,
    isSymlink: false,
    depth
  }
}

const rows = [
  node('src', 0, true),
  node('src/a.ts', 1),
  node('src/nested', 1, true),
  node('src/nested/b.ts', 2),
  node('README.md', 0)
]

describe('file explorer context paths', () => {
  it('builds host-native absolute paths for context-menu actions', () => {
    expect(joinWorkspacePath('/srv/project/', 'src/index.ts')).toBe('/srv/project/src/index.ts')
    expect(joinWorkspacePath('C:\\work\\project\\', 'src/index.ts')).toBe('C:\\work\\project\\src\\index.ts')
  })
})

describe('file explorer move interaction', () => {
  it('resolves directory, file-row parent, root, and segment-aware menu targets', () => {
    expect(fileExplorerDropDirectory(node('src/lib', 0, true))).toBe('src/lib')
    expect(fileExplorerDropDirectory(node('src/lib/file.ts', 0))).toBe('src/lib')
    expect(fileExplorerMoveTargets([
      node('src', 0, true),
      node('src/app', 1, true),
      node('src/application', 1, true),
      node('lib', 0, true)
    ], 'src/app')).toEqual([
      { path: '', label: 'Workspace Root' },
      { path: 'src/application', label: 'src/application' },
      { path: 'lib', label: 'lib' }
    ])
  })

  it('plans one loaded-tree move and blocks invalid drop and menu destinations', () => {
    const nodes = [
      node('src', 0, true),
      node('src/app', 1, true),
      node('src/app/index.ts', 2),
      node('lib', 0, true),
      node('lib/app', 1, true)
    ]
    expect(planFileExplorerMove(nodes, 'src/app/index.ts', 'lib')).toEqual({
      status: 'ready',
      sourcePath: 'src/app/index.ts',
      directoryPath: 'lib',
      destinationPath: 'lib/index.ts'
    })
    expect(planFileExplorerMove(nodes, 'src/app/index.ts', 'src/app')).toEqual({
      status: 'blocked', reason: 'same-parent'
    })
    expect(planFileExplorerMove(nodes, 'src/app', 'src/app')).toEqual({
      status: 'blocked', reason: 'into-self'
    })
    expect(planFileExplorerMove(nodes, 'src/app', 'src/app/nested')).toEqual({
      status: 'blocked', reason: 'into-self'
    })
    expect(planFileExplorerMove(nodes, 'src/app', 'lib')).toEqual({
      status: 'blocked', reason: 'destination-exists'
    })
    expect(fileExplorerMoveTargets(nodes, 'src/app').map((target) => target.path)).not.toContain('lib')
  })

  it('refreshes exactly both move parents on success and after an unknown receipt', async () => {
    const refresh = vi.fn(async () => {})
    const move = vi.fn(async () => {})
    await runFileExplorerMove({
      sourcePath: 'src/app/index.ts',
      destinationPath: 'lib/index.ts',
      move,
      refreshDirectory: refresh
    })
    expect(move).toHaveBeenCalledWith('src/app/index.ts', 'lib/index.ts')
    expect(refresh.mock.calls.map(([path]) => path)).toEqual(['src/app', 'lib'])

    refresh.mockClear()
    const unknown = Object.assign(new Error('unknown'), { finalLocation: 'unknown' })
    await expect(runFileExplorerMove({
      sourcePath: 'src/app',
      destinationPath: 'src/renamed',
      move: async () => { throw unknown },
      refreshDirectory: refresh
    })).rejects.toBe(unknown)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith('src')
  })

  it('keeps confirmed failures unchanged and exposes the menu from keyboard conventions', async () => {
    const refresh = vi.fn(async () => {})
    const collision = Object.assign(new Error('collision'), { finalLocation: 'source' })
    await expect(runFileExplorerMove({
      sourcePath: 'src/app',
      destinationPath: 'lib/app',
      move: async () => { throw collision },
      refreshDirectory: refresh
    })).rejects.toBe(collision)
    expect(refresh).not.toHaveBeenCalled()
    expect(isFileExplorerMenuKey({ key: 'ContextMenu', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false })).toBe(true)
    expect(isFileExplorerMenuKey({ key: 'F10', shiftKey: true, altKey: false, ctrlKey: false, metaKey: false })).toBe(true)
    expect(isFileExplorerMenuKey({ key: 'F10', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false })).toBe(false)
  })
})

/**
 * 菜单标的键必须就是 handler 认的键。
 *
 * 这条守的是一次真事故：右键菜单把 Rename 标成 Enter（mac 上 ↩）、把 Delete 标成 ⌘⌫，而 handler 认的
 * 是 F2 和**裸** Delete/Backspace。于是标出来的键按了没反应，真键一处都没告诉用户。这两个键不在
 * SHORTCUT_BINDINGS 注册表里，所以 cheat-sheet 的投影抓不到它们——没有任何东西会因为标错而红。
 *
 * 判据刻意不是「label 等于某个字面量」：那种断言只是把同一份手抄再抄一遍，两边一起改就一起绿。这里
 * 断言的是 label 与 matches 的**一致性**——标出来的那个键，喂给 matches 必须为真；而被明确排除的键
 * （mac 的 Enter、带 Cmd 的 Backspace）必须为假。
 */
describe('文件树行内动作键：标签与判据同源', () => {
  const bare = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }

  it('重命名标 F2 且两个平台一致——mac 的 Enter 绝不重命名', () => {
    expect(FILE_EXPLORER_RENAME_KEY.label(true)).toBe('F2')
    expect(FILE_EXPLORER_RENAME_KEY.label(false)).toBe('F2')
    // 标出来的键真的被认。
    expect(FILE_EXPLORER_RENAME_KEY.matches({ key: 'F2', ...bare })).toBe(true)
    // 那次事故标错的两个键必须为假：Enter 在树里是「打开/展开」，抢它会吃掉最常用的操作。
    expect(FILE_EXPLORER_RENAME_KEY.matches({ key: 'Enter', ...bare })).toBe(false)
    expect(FILE_EXPLORER_RENAME_KEY.matches({ key: 'F2', ...bare, metaKey: true })).toBe(false)
  })

  it('删除标单键——标 ⌘⌫ 会让人以为需要按住 Cmd 才会删', () => {
    expect(FILE_EXPLORER_DELETE_KEY.label(true)).toBe('⌫')
    expect(FILE_EXPLORER_DELETE_KEY.label(false)).toBe('Del')
    expect(FILE_EXPLORER_DELETE_KEY.matches({ key: 'Delete', ...bare })).toBe(true)
    expect(FILE_EXPLORER_DELETE_KEY.matches({ key: 'Backspace', ...bare })).toBe(true)
    // 带修饰键的不认。标签若写成 ⌘⌫ 就与这条矛盾——用户按 Cmd+⌫ 什么也不会发生。
    expect(FILE_EXPLORER_DELETE_KEY.matches({ key: 'Backspace', ...bare, metaKey: true })).toBe(false)
  })

  it('标签里出现的键，喂回 matches 必须为真（这条抓的是任何一侧单独漂移）', () => {
    // 把 label 与 matches 绑在一起判：改了标签而没改判据（或反之）就红。mac 侧的 ⌫ 与 Backspace 是
    // 同一个物理键的两种写法，所以标签到键名要过一次显式映射——映射表本身也在这条断言的范围内。
    const keyForLabel: Record<string, string> = { F2: 'F2', '⌫': 'Backspace', Del: 'Delete' }
    for (const action of [FILE_EXPLORER_RENAME_KEY, FILE_EXPLORER_DELETE_KEY]) {
      for (const isMac of [true, false]) {
        const label = action.label(isMac)
        const key = keyForLabel[label]
        // 标签必须是我们认得的写法——出现一个映射表里没有的新标签时这条会红，而不是被静默跳过。
        expect(key, `未知标签 ${label}：新增标签必须同时更新映射与判据`).toBeDefined()
        expect(action.matches({ key: key!, ...bare })).toBe(true)
      }
    }
  })
})

describe('file explorer row projection and navigation', () => {
  const projection = createFileExplorerRowProjection(rows)

  it('moves, jumps, enters children, returns to parents, and toggles directories', () => {
    const collapsed = () => false
    const expanded = (path: string) => path === 'src'
    expect(resolveFileExplorerNavigationTarget({ key: 'ArrowDown', currentIndex: 0, rowProjection: projection, total: 5, isExpanded: collapsed })).toEqual({ type: 'move', targetIndex: 1 })
    expect(resolveFileExplorerNavigationTarget({ key: 'Home', currentIndex: 4, rowProjection: projection, total: 5, isExpanded: collapsed })).toEqual({ type: 'move', targetIndex: 0 })
    expect(resolveFileExplorerNavigationTarget({ key: 'End', currentIndex: 0, rowProjection: projection, total: 5, isExpanded: collapsed })).toEqual({ type: 'move', targetIndex: 4 })
    expect(resolveFileExplorerNavigationTarget({ key: 'ArrowRight', currentIndex: 0, rowProjection: projection, total: 5, isExpanded: collapsed })).toEqual({ type: 'toggle-expand', currentIndex: 0, dirPath: 'src' })
    expect(resolveFileExplorerNavigationTarget({ key: 'ArrowRight', currentIndex: 0, rowProjection: projection, total: 5, isExpanded: expanded })).toEqual({ type: 'move', targetIndex: 1 })
    expect(resolveFileExplorerNavigationTarget({ key: 'ArrowLeft', currentIndex: 3, rowProjection: projection, total: 5, isExpanded: collapsed })).toEqual({ type: 'move', targetIndex: 2 })
  })

  it('projects selected paths in visible tree order', () => {
    expect(projection.getRowsByPaths(new Set(['README.md', 'src/a.ts'])).map((item) => item.path)).toEqual(['src/a.ts', 'README.md'])
    expect(projection.getParentIndex(3)).toBe(2)
    expect(projection.getFirstChildIndex(2)).toBe(3)
  })
})

describe('file explorer selection and mutation reconciliation', () => {
  const ordered = rows.map((item) => item.path)

  it('supports platform toggle and range selection', () => {
    expect(getFileExplorerSelectionMode({ ctrlKey: false, metaKey: true, shiftKey: false }, true)).toBe('toggle')
    const first = updateFileExplorerSelection(createEmptyFileExplorerSelection(), ordered, 'src/a.ts', 'replace')
    const range = updateFileExplorerSelection(first, ordered, 'src/nested/b.ts', 'range')
    expect([...range.selectedPaths]).toEqual(['src/a.ts', 'src/nested', 'src/nested/b.ts'])
  })

  // 四个模式里只有 replace 与 range 被断言过（上一条）。toggle 与 additive-range 在整个仓里零断言，
  // 而它们是活的：FileExplorer.tsx 的行点击把 getFileExplorerSelectionMode(event, isMac) 直接喂给
  // updateFileExplorerSelection，Cmd 点击（mac）/ Ctrl 点击就走 toggle 这一支。实测过：把 toggle 分支里
  // 的 add/delete 取反（已选中的再加一遍、未选中的去删），三个相关 suite 49 条全绿。
  //
  // 取反之后用户点未选中的行没反应、点已选中的行取消不掉——Cmd/Ctrl 点文件行拼多选彻底失效，而这
  // 正是「一次拖多个文件进 agent」这类操作的唯一入口。纯函数，判据用单元断言就够，不必挂载。
  it('Cmd/Ctrl 点击逐个加减选中项，最后一个被去掉后不留悬空的 activePath', () => {
    const one = updateFileExplorerSelection(createEmptyFileExplorerSelection(), ordered, 'src/a.ts', 'replace')

    // 加：未选中的目标进集合，并成为活动行。
    const two = updateFileExplorerSelection(one, ordered, 'README.md', 'toggle')
    expect([...two.selectedPaths]).toEqual(['src/a.ts', 'README.md'])
    expect(two.activePath).toBe('README.md')

    // 减：已选中的目标出集合。活动行不能停在刚被去掉的那一行，要落到仍选中的行上。
    const back = updateFileExplorerSelection(two, ordered, 'README.md', 'toggle')
    expect([...back.selectedPaths]).toEqual(['src/a.ts'])
    expect(back.activePath).toBe('src/a.ts')

    // 减到空：activePath 必须诚实地变成 null，而不是指着一个已不在选中集里的路径。
    const none = updateFileExplorerSelection(back, ordered, 'src/a.ts', 'toggle')
    expect([...none.selectedPaths]).toEqual([])
    expect(none.activePath).toBeNull()
    expect(none.anchorPath).toBeNull()
  })

  // additive-range 与 range 的差别只有一处：起始集合是「保留已选」还是「从空开始」。判据必须让**区间
  // 之外**已经选中的路径参与，否则两个模式给出同一个结果，断言分不出走的是哪一支。
  it('Shift+Cmd 拉的区间并进已选中的行，纯 Shift 则从头开始', () => {
    // 直接构造一个「区间外还选着 src」的起点，不经 toggle——否则本条会跟着上一条的变异一起红，
    // 就证不出这一支自己有人守了。
    const base = {
      ...createSingleFileExplorerSelection('src/nested/b.ts'),
      selectedPaths: new Set(['src', 'src/nested/b.ts'])
    }

    const additive = updateFileExplorerSelection(base, ordered, 'README.md', 'additive-range')
    // 'src' 在区间（b.ts…README.md）之外，加法模式下必须留着。
    expect([...additive.selectedPaths]).toEqual(['src', 'src/nested/b.ts', 'README.md'])
    expect(additive.activePath).toBe('README.md')
    expect(additive.anchorPath).toBe('src/nested/b.ts')

    // 反向对照：同一个起点走纯 range，'src' 必须被丢掉。少了这条，把三元的两侧都写成「保留已选」
    // 也能让上面全绿。
    const replaced = updateFileExplorerSelection(base, ordered, 'README.md', 'range')
    expect([...replaced.selectedPaths]).toEqual(['src/nested/b.ts', 'README.md'])
  })

  it('remaps rename descendants and removes deleted subtrees without losing unrelated selection', () => {
    const selected = {
      ...createSingleFileExplorerSelection('src/nested/b.ts'),
      selectedPaths: new Set(['src/nested/b.ts', 'README.md'])
    }
    const renamed = updateFileExplorerSelectionPaths(selected, (path) =>
      remapPathWithinSubtree(path, 'src/nested', 'src/moved')
    )
    expect([...renamed.selectedPaths]).toEqual(['src/moved/b.ts', 'README.md'])
    const afterDelete = updateFileExplorerSelectionPaths(renamed, (path) =>
      isPathWithinSubtree(path, 'src/moved') ? null : path
    )
    expect([...afterDelete.selectedPaths]).toEqual(['README.md'])
    expect(afterDelete.activePath).toBe('README.md')
  })

  it('does not treat a string-prefix neighbor as part of the same path subtree', () => {
    expect(isPathWithinSubtree('src/app', 'src/app')).toBe(true)
    expect(isPathWithinSubtree('src/app/index.ts', 'src/app')).toBe(true)
    expect(isPathWithinSubtree('src/application.ts', 'src/app')).toBe(false)
    expect(remapPathWithinSubtree('src/application.ts', 'src/app', 'src/moved')).toBe('src/application.ts')
  })

  it('reveals an active path without replacing an existing multi-selection', () => {
    const selection = {
      activePath: 'src/moved/index.ts',
      anchorPath: 'src/moved/index.ts',
      selectedPaths: new Set(['src/moved/index.ts', 'src/application.ts'])
    }
    const current = {
      selection,
      expandedPaths: new Set(['src'])
    }

    const revealed = revealFileExplorerPath(current, 'src/moved/index.ts')

    expect(revealed.selection).toBe(selection)
    expect(revealed.selection.selectedPaths).toEqual(
      new Set(['src/moved/index.ts', 'src/application.ts'])
    )
    expect(revealed.expandedPaths).toEqual(new Set(['src', 'src/moved']))
    expect(revealFileExplorerPath(revealed, 'src/moved/index.ts')).toBe(revealed)
  })
})

describe('file explorer reveal, refresh, and stale-response primitives', () => {
  it('builds reveal ancestors for a relative Workspace path', () => {
    expect(getRevealAncestorPaths('src/components/App.tsx')).toEqual(['src', 'src/components'])
  })

  it('rejects stale same-directory completions and prior-Workspace late starts', () => {
    const tracker = createFileExplorerDirLoadTracker()
    const firstWorkspaceA = createFileExplorerDirLoadScope('workspace-a')
    const workspaceB = createFileExplorerDirLoadScope('workspace-b')
    const secondWorkspaceA = createFileExplorerDirLoadScope('workspace-a')
    tracker.activate(firstWorkspaceA)
    const first = tracker.begin(firstWorkspaceA, 'src')!
    const second = tracker.begin(firstWorkspaceA, 'src')!
    expect(tracker.isCurrent(first)).toBe(false)
    expect(tracker.isCurrent(second)).toBe(true)
    tracker.activate(workspaceB)
    expect(tracker.isCurrent(second)).toBe(false)
    expect(tracker.begin(firstWorkspaceA, 'src')).toBeNull()
    const staleDirs = new Set<string>()
    expect(tracker.runIfActive(firstWorkspaceA, () => staleDirs.add('src'))).toBe(false)
    expect(staleDirs).toEqual(new Set())
    tracker.activate(secondWorkspaceA)
    expect(tracker.begin(firstWorkspaceA, 'src')).toBeNull()
    expect(tracker.begin(secondWorkspaceA, 'src')).not.toBeNull()
  })

  it('marks collapsed caches stale and forces their next expansion to reload', () => {
    const cache: Record<string, DirCache> = {
      '': { children: rows, loading: false, error: null },
      src: { children: rows.slice(1, 4), loading: false, error: null },
      'src/nested': { children: [rows[3]!], loading: false, error: null }
    }
    expect(collectStaleDirCachePaths(cache, '', new Set(['src']))).toEqual(['src/nested'])
    expect(decideExpandedDirLoad(cache['src/nested'], true)).toBe('reload')
    expect(decideExpandedDirLoad(cache.src, false)).toBe('skip')
  })
})

// ---------------------------------------------------------------------------
// 「读失败」与「真的空目录」必须分得开。
//
// 原缺陷：DirCache 只有 children + loading 两个字段，而 useWorkspaceFileTree 的 catch 里子目录的
// 错误被完全丢弃（只有根目录进一个独立的 rootError state），于是读失败落成
// `{ children: [], loading: false }`——与成功读到一个空目录逐字相同，树上都画成展开的空文件夹。
// ---------------------------------------------------------------------------

describe('目录读失败与空目录的区分', () => {
  const child = node('src/index.ts', 1)

  it('读失败与真的空目录判出不同的显示态', () => {
    // 这一对是本组的判别力自检：两个 cache 项的 children 都是空的，唯一的差别就是 error 在不在场。
    // 如果实现回到「按 children 是否为空判」，这两条会给出相同取值，下面的 not.toBe 就红。
    const failed = presentExpandedDir({ children: [], loading: false, error: 'EACCES: permission denied' })
    const genuinelyEmpty = presentExpandedDir({ children: [], loading: false, error: null })

    expect(failed).toBe('failed')
    expect(genuinelyEmpty).toBe('empty')
    expect(failed, '读失败与真的空目录判出了同一个显示态——用户分不出来').not.toBe(genuinelyEmpty)
  })

  it('刷新失败但留着旧内容的目录仍然算失败', () => {
    // loadDir 的 catch 会保留上一次读到的 children（否则树会在 SSH 应答期间塌掉）。所以
    // 「children 非空」不能推出「读成功」——按 children 分派会把这种目录画成完全正常。
    expect(
      presentExpandedDir({ children: [child], loading: false, error: 'ETIMEDOUT' }),
      '刷新失败但留着旧内容时被判成正常，失败对用户不可见'
    ).toBe('failed')
  })

  it('在读与还没有 cache 项都算 loading，不算空也不算失败', () => {
    expect(presentExpandedDir(undefined)).toBe('loading')
    expect(presentExpandedDir({ children: [], loading: true, error: null })).toBe('loading')
    // 上一次的错误在新的读开始时不该继续显示：loading 优先于 error。
    expect(presentExpandedDir({ children: [], loading: true, error: 'stale failure' })).toBe('loading')
  })

  it('有内容且读成功的目录判成 populated', () => {
    expect(presentExpandedDir({ children: [child], loading: false, error: null })).toBe('populated')
  })

  it('读失败留下的空 cache 项不能让下次展开跳过加载', () => {
    // 若这里判成 'skip'，那个目录会永久停在失败态：用户再展开一次也不会重试，除了切 Workspace
    // 之外没有任何出路。
    expect(
      decideExpandedDirLoad({ children: [], loading: false, error: 'EACCES' }, false),
      '失败过的目录再次展开时被跳过，用户没有重试路径'
    ).toBe('load')
    // 失败但留着旧内容的那种同样要重试——否则「有内容」会掩盖「这份内容是过期的」。
    expect(
      decideExpandedDirLoad({ children: [child], loading: false, error: 'ETIMEDOUT' }, false),
      '刷新失败但有旧内容时被跳过，那份内容会永久停在过期状态'
    ).toBe('load')
  })
})

// ---------------------------------------------------------------------------
// 接线层：那个判定真的被渲染侧用上了，而不是一个零消费者的纯函数。
//
// 这一层必须与上面分开：上面挡「判错了」，这里挡「判对了但没人看」。本仓有一族「抽进 lib 只解决
// 一半」的事故——内容变可测了，而「这层壳有没有被执行到」照旧无人守。
// ---------------------------------------------------------------------------

describe('读失败在树上真的被画出来', () => {
  const explorer = readFileSync(
    new URL('../src/renderer/src/components/FileExplorer.tsx', import.meta.url),
    'utf8'
  )
  const dock = readFileSync(
    new URL('../src/renderer/src/styles/dock.css', import.meta.url),
    'utf8'
  )

  it('行的失败判定来自那处纯函数，不是就地又读一遍 error', () => {
    expect(
      explorer,
      'FileExplorer 没有 import presentExpandedDir——失败态要么没画，要么自己判了一遍'
    ).toMatch(/import \{ presentExpandedDir \} from '\.\/file-tree\/file-explorer-stale-dir-cache'/)
    expect(
      explorer.match(/presentExpandedDir\(/g) ?? [],
      '调用次数不是恰好一次：0 次是没接线，多次是同一判定被摊在几个地方'
    ).toHaveLength(1)
    expect(
      explorer,
      "判定结果没有与 'failed' 比对——拿到取值却没用它区分"
    ).toMatch(/presentExpandedDir\([\s\S]{0,80}?\) === 'failed'/)
  })

  it('失败的行在 DOM 上可辨认，且样式真的改了颜色', () => {
    // data 属性是给守卫和将来的 E2E 探针用的锚点；className 是给 CSS 用的。两个都要在场：
    // 只有 data 属性则用户看不出区别，只有 class 则没人能质询它。
    expect(explorer).toMatch(/data-load-failed=\{loadFailure \? 'true' : 'false'\}/)
    expect(explorer).toMatch(/tree-row--load-failed/)
    // 图标必须换掉。留着 Folder/FolderOpen 就等于「展开的空文件夹」那个原始症状。
    expect(
      explorer,
      '失败时没有换图标——与真的空目录仍然逐像素相同'
    ).toMatch(/loadFailure[\s\S]{0,40}?<TriangleAlert/)
    expect(explorer, '失败原因没有给用户看').toMatch(/title=\{loadFailure \?\? undefined\}/)

    // CSS 侧要真的有声明体，不能只有一个空选择器（本仓「CSS 守卫只查选择器名存在」那族）。
    const rule = dock.match(/\.tree-row--load-failed \.tree-row__icon \{([^}]*)\}/)
    expect(rule, 'dock.css 里没有失败图标的规则').not.toBeNull()
    expect(rule![1], '规则在场但没有改颜色，那条规则是死的').toMatch(/color:\s*var\(--red-text\)/)
  })

  it('根目录的错误从 cache 派生，没有第二个写者', () => {
    const hook = readFileSync(
      new URL('../src/renderer/src/components/file-tree/useWorkspaceFileTree.ts', import.meta.url),
      'utf8'
    )
    // 原来 rootError 是独立的 useState，与子目录的 error 是同一件事的两个真相；两个写者必漂移。
    expect(
      hook,
      'rootError 又变回独立 state 了——它与子目录的 error 是同一件事，两个写者会漂移'
    ).not.toMatch(/setRootError/)
    expect(hook).toMatch(/rootError:\s*dirCache\[''\]\?\.error/)
    // catch 里必须真的把原因写进 cache，否则上面那条派生恒为 null。
    expect(
      hook,
      'catch 没有把失败原因写进 cache——那么派生出来的 rootError 恒为 null'
    ).toMatch(/loading: false, error: reason/)
  })
})
