import { describe, expect, it } from 'vitest'
import type { GitFileChange } from '../src/shared/contracts.js'
import {
  FILE_TREE_GIT_STATUS_CLASS,
  FILE_TREE_GIT_STATUS_LABEL,
  FILE_TREE_GIT_STATUS_MARK,
  FILE_TREE_GIT_STATUS_PRIORITY,
  buildFileTreeGitStatusIndex,
  fileTreeGitStatusOfChange,
  type FileTreeGitStatus
} from '../src/renderer/src/lib/file-tree-git-status.js'

/**
 * 文件树 git 状态投影的守卫。
 *
 * 这是本任务唯一能被断言到达的一层：本仓没有 DOM 测试环境，`renderToStaticMarkup` 不跑 effect、
 * zustand 在 SSR 下只渲染初始 state（记忆 render-to-static-markup-blind-to-effects /
 * zustand-ssr-renders-initial-state），所以「组件挂载后从 git:status 读到了什么」在这个包里不可观测。
 * 判定因此全部抽进纯函数，这里把它逐条钉死。
 */

function change(path: string, overrides: Partial<GitFileChange> = {}): GitFileChange {
  return {
    path,
    origPath: null,
    index: ' ',
    worktree: ' ',
    staged: false,
    unstaged: false,
    untracked: false,
    ...overrides
  }
}

const ALL_STATUSES: FileTreeGitStatus[] = [
  'modified',
  'added',
  'untracked',
  'deleted',
  'renamed',
  'conflicted'
]

describe('fileTreeGitStatusOfChange', () => {
  it('把 git 的两列状态码折成一个树状态，暂存看 index、未暂存看 worktree', () => {
    // 每一行 index 与 worktree 刻意不同：读错那一列就落进 default(modified) 而不是恰好也对。
    expect(fileTreeGitStatusOfChange(change('a', { index: 'A', worktree: ' ', staged: true })))
      .toBe('added')
    expect(fileTreeGitStatusOfChange(change('b', { index: 'D', worktree: ' ', staged: true })))
      .toBe('deleted')
    expect(fileTreeGitStatusOfChange(change('c', { index: 'R', worktree: ' ', staged: true })))
      .toBe('renamed')
    expect(fileTreeGitStatusOfChange(change('d', { index: ' ', worktree: 'M', unstaged: true })))
      .toBe('modified')
    // 冲突用 `AU`（added by us）——git 真会吐的七个 unmerged 码之一。此前这里写的是 ` U`，那不是
    // 一个 git 会发出的码：porcelain 的 unmerged 只有 DD/AU/UD/UA/DU/AA/UU 七种（由真 git 生成的前提
    // 见 git-unmerged-classification.test.ts）。合成出来的形状让这条断言只能证明「读 worktree 那列并
    // 恰好把 U 当冲突」，而 `AU` 同时否掉两种单列读法：只读 index 得 added，只读 worktree 得 default。
    expect(fileTreeGitStatusOfChange(change('e', { index: 'A', worktree: 'U', staged: true, unstaged: true })))
      .toBe('conflicted')
  })

  it('未跟踪先于两列状态码判定', () => {
    // 未跟踪文件两列是 '??'，删掉这条早退会落进 default(modified)。
    expect(fileTreeGitStatusOfChange(change('n', { index: '?', worktree: '?', untracked: true })))
      .toBe('untracked')
  })
})

describe('FILE_TREE_GIT_STATUS_PRIORITY（目录聚合的唯一优先级表）', () => {
  it('按注意力从高到低排序：conflicted > deleted > modified > renamed > added > untracked', () => {
    // 逐对钉住相邻档位的严格大小。改任意一个条目让某个相邻关系反转，这里就红——
    // 这就是「目录聚合优先级表改一个条目必须红」那个变异的靶子。
    expect(FILE_TREE_GIT_STATUS_PRIORITY.conflicted).toBeGreaterThan(FILE_TREE_GIT_STATUS_PRIORITY.deleted)
    expect(FILE_TREE_GIT_STATUS_PRIORITY.deleted).toBeGreaterThan(FILE_TREE_GIT_STATUS_PRIORITY.modified)
    expect(FILE_TREE_GIT_STATUS_PRIORITY.modified).toBeGreaterThan(FILE_TREE_GIT_STATUS_PRIORITY.renamed)
    expect(FILE_TREE_GIT_STATUS_PRIORITY.renamed).toBeGreaterThan(FILE_TREE_GIT_STATUS_PRIORITY.added)
    expect(FILE_TREE_GIT_STATUS_PRIORITY.added).toBeGreaterThan(FILE_TREE_GIT_STATUS_PRIORITY.untracked)
  })
})

describe('buildFileTreeGitStatusIndex', () => {
  it('文件拿自己的状态；祖先目录只能按目录查得到（isDirectory 这一维真的被读）', () => {
    const index = buildFileTreeGitStatusIndex([
      change('src/a.ts', { worktree: 'M', unstaged: true })
    ])
    expect(index.get('src/a.ts', false)).toBe('modified')
    // src 作为祖先目录被标记（下一个用例细验聚合）。
    expect(index.get('src', true)).toBe('modified')
    // 判据落在**祖先**上：聚合出来的目录状态只进目录表，所以拿它当文件查必须落空。
    // 这是「isDirectory 这一维真的被读」现在唯一的靶子——把 get 改成无视入参的并集查询
    // （`dirStatus.get(p) ?? fileStatus.get(p)`），只有这一行会红。
    expect(index.get('src', false), '聚合出来的目录状态不该能按文件查到').toBeNull()
    // 这里**故意不再**断言 `index.get('src/a.ts', true)` 为 null。原先那条断言与 #749 逻辑上
    // 不相容，不是实现取舍：脏 gitlink（` M sub`）和普通改动文件（` M src/a.ts`）到达这个
    // 函数时形状完全一样——一条只写路径的 porcelain 记录，不说类型，也没有后代条目。所以
    // 任何能让 `sub` 按目录查到的规则，都必然让 `src/a.ts` 也按目录查得到。两者只能留一个，
    // 而 #749 是用户真看得见的缺陷（脏 submodule 在树里显示为 clean），另一个是树永远不会
    // 发出的查询（树的每个节点的 kind 都是 readdir 给的，不会拿文件去问目录）。
    // 详见 file-tree-git-status-gitlink.test.ts 里由真 git 生成的前提自检。
  })

  it('目录聚合取后代里最紧迫的那个状态，折叠时仍看得见', () => {
    const index = buildFileTreeGitStatusIndex([
      change('src/added.ts', { index: 'A', staged: true }),
      change('src/broken.ts', { index: 'A', worktree: 'A', staged: true, unstaged: true }),
      change('src/edited.ts', { index: ' ', worktree: 'M', unstaged: true })
    ])
    // 目录里同时有 added / conflicted / modified —— 聚合必须显示最紧迫的 conflicted。
    // 把优先级表里 conflicted 调到最低，这条就红（与上面 PRIORITY 那条是两个不同的靶子）。
    expect(index.get('src', true)).toBe('conflicted')
    // 每个后代文件仍保有自己的状态，不被聚合覆盖。
    expect(index.get('src/added.ts', false)).toBe('added')
    expect(index.get('src/edited.ts', false)).toBe('modified')
  })

  it('多级祖先目录都被标记', () => {
    const index = buildFileTreeGitStatusIndex([
      change('a/b/c/deep.ts', { worktree: 'M', unstaged: true })
    ])
    expect(index.get('a', true)).toBe('modified')
    expect(index.get('a/b', true)).toBe('modified')
    expect(index.get('a/b/c', true)).toBe('modified')
    expect(index.get('a/b/c/deep.ts', false)).toBe('modified')
  })

  it('干净的节点返回 null', () => {
    const index = buildFileTreeGitStatusIndex([
      change('src/a.ts', { worktree: 'M', unstaged: true })
    ])
    expect(index.get('src/other.ts', false)).toBeNull()
    expect(index.get('lib', true)).toBeNull()
    expect(buildFileTreeGitStatusIndex([]).get('anything', false)).toBeNull()
  })

  it('用 repo 相对前缀把 porcelain 路径落到工作区相对的树节点上', () => {
    // 工作区是 repo 的子目录 app/desktop：porcelain 报 app/desktop/src/a.ts，树看到的是 src/a.ts。
    const index = buildFileTreeGitStatusIndex(
      [change('app/desktop/src/a.ts', { worktree: 'M', unstaged: true })],
      'app/desktop'
    )
    expect(index.get('src/a.ts', false)).toBe('modified')
    expect(index.get('src', true)).toBe('modified')
    // 前缀之外的改动属于树看不到的另一部分仓库，丢弃。
    const outside = buildFileTreeGitStatusIndex(
      [change('other/x.ts', { worktree: 'M', unstaged: true })],
      'app/desktop'
    )
    expect(outside.get('other/x.ts', false)).toBeNull()
    // 关键：删掉「前缀之外就跳过」这道闸时，一条 z/y/src/leak.ts 会被无条件按前缀长度切片，
    // 恰好落成 src/leak.ts 这个像模像样的树节点——把不属于本树的改动误挂到一个真节点上。
    // 前缀 'a/b'（切 4 字符）+ 'z/y/src/leak.ts' → 'src/leak.ts'，必须仍是 null。
    const leak = buildFileTreeGitStatusIndex(
      [change('z/y/src/leak.ts', { worktree: 'M', unstaged: true })],
      'a/b'
    )
    expect(leak.get('src/leak.ts', false), '前缀外的改动被误切成了树内节点').toBeNull()
    expect(leak.get('src', true), '前缀外的改动让 src 目录假亮').toBeNull()
  })
})

/**
 * 曾经这里有一组 `fileTreeRepoRelativePrefix` 的用例（三条：顶层为空、子目录取相对段、不在 repo 内为空）。
 * 那个函数已经删掉了：它用 `repoPath` 与 `workspace.path` 两个字符串做词法比较来推前缀，而这两个字符串
 * 可以在任何一段祖先目录上分岔（git 会把 symlink 与磁盘大小写规范化，配置里的路径不会），比较落空时它
 * 返回 `''`——恰好是让下面的投影停止过滤、把一个文件的状态画到另一个干净文件上的那个值。前缀现在由 main
 * 侧问 git 自己（`rev-parse --show-prefix`）并随契约下发，判定只有一处。
 *
 * 那三条用例守的事现在分两层守：
 * - 行为层 `git-service.test.ts` 的真 git 用例（symlink 祖先下 `status()` 必须返回非空前缀）。它顺带也
 *   守住了 argv：把 `--show-prefix` 换成 `--show-toplevel` 实测打红两条，所以接线层**刻意不**再为
 *   argv 立一条判据（那会是两个预算守同一件事，短的只贡献假阴性）。
 * - 接线层 `file-tree-git-prefix-wiring.test.ts`：投影的前缀实参必须**就是**契约字段的读取，且这个自算
 *   函数不许在 renderer 里重新出现。
 */

describe('呈现表必须对每个状态穷举且彼此可辨', () => {
  it('class / mark / label 三张表覆盖全部状态且取值互不相同', () => {
    for (const status of ALL_STATUSES) {
      expect(FILE_TREE_GIT_STATUS_CLASS[status], `${status} 没有 class`).toBeTruthy()
      expect(FILE_TREE_GIT_STATUS_MARK[status], `${status} 没有 mark`).toBeTruthy()
      expect(FILE_TREE_GIT_STATUS_LABEL[status], `${status} 没有 label`).toBeTruthy()
    }
    // 三张表各自的取值互不重复：否则两个状态在界面上无从区分（class 对调那个变异的第一道靶）。
    expect(new Set(Object.values(FILE_TREE_GIT_STATUS_CLASS)).size).toBe(ALL_STATUSES.length)
    expect(new Set(Object.values(FILE_TREE_GIT_STATUS_MARK)).size).toBe(ALL_STATUSES.length)
    expect(new Set(Object.values(FILE_TREE_GIT_STATUS_LABEL)).size).toBe(ALL_STATUSES.length)
  })

  it('每个状态的 class 精确对应它自己，不与别的状态混用', () => {
    // 把表里两个状态的 class 对调 → 这里逐条钉死，必红（class 对调变异的主靶）。
    expect(FILE_TREE_GIT_STATUS_CLASS.modified).toBe('tree-row--git-modified')
    expect(FILE_TREE_GIT_STATUS_CLASS.added).toBe('tree-row--git-added')
    expect(FILE_TREE_GIT_STATUS_CLASS.untracked).toBe('tree-row--git-untracked')
    expect(FILE_TREE_GIT_STATUS_CLASS.deleted).toBe('tree-row--git-deleted')
    expect(FILE_TREE_GIT_STATUS_CLASS.renamed).toBe('tree-row--git-renamed')
    expect(FILE_TREE_GIT_STATUS_CLASS.conflicted).toBe('tree-row--git-conflicted')
  })

  it('mark 用 git porcelain 的字母，untracked 是 ?', () => {
    expect(FILE_TREE_GIT_STATUS_MARK.untracked).toBe('?')
    expect(FILE_TREE_GIT_STATUS_MARK.added).toBe('A')
    expect(FILE_TREE_GIT_STATUS_MARK.modified).toBe('M')
    expect(FILE_TREE_GIT_STATUS_MARK.deleted).toBe('D')
  })
})
