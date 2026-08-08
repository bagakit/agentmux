import { describe, expect, it } from 'vitest'
import type { GitFileChange } from '../src/shared/contracts.js'
import {
  FILE_TREE_GIT_STATUS_CLASS,
  FILE_TREE_GIT_STATUS_LABEL,
  FILE_TREE_GIT_STATUS_MARK,
  FILE_TREE_GIT_STATUS_PRIORITY,
  buildFileTreeGitStatusIndex,
  fileTreeGitStatusOfChange,
  fileTreeRepoRelativePrefix,
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
    expect(fileTreeGitStatusOfChange(change('e', { index: ' ', worktree: 'U', unstaged: true })))
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
  it('文件拿自己的状态，节点是文件还是目录各查各的表', () => {
    const index = buildFileTreeGitStatusIndex([
      change('src/a.ts', { worktree: 'M', unstaged: true })
    ])
    expect(index.get('src/a.ts', false)).toBe('modified')
    // 文件路径当目录查不命中：目录表只有真实祖先目录（src），文件本身不是任何目录。
    // 「是文件还是目录」是查询的入参，读错这一维就会把文件当目录查而落空。
    expect(index.get('src/a.ts', true)).toBeNull()
    // 而 src 作为祖先目录被标记（下一个用例细验聚合）。
    expect(index.get('src', true)).toBe('modified')
  })

  it('目录聚合取后代里最紧迫的那个状态，折叠时仍看得见', () => {
    const index = buildFileTreeGitStatusIndex([
      change('src/added.ts', { index: 'A', staged: true }),
      change('src/broken.ts', { index: ' ', worktree: 'U', unstaged: true }),
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

describe('fileTreeRepoRelativePrefix', () => {
  it('工作区即 repo 顶层时前缀为空', () => {
    expect(fileTreeRepoRelativePrefix('/repo', '/repo')).toBe('')
    expect(fileTreeRepoRelativePrefix('/repo/', '/repo')).toBe('')
  })

  it('工作区是 repo 子目录时前缀是那段相对路径', () => {
    expect(fileTreeRepoRelativePrefix('/repo', '/repo/app/desktop')).toBe('app/desktop')
  })

  it('工作区不在 repo 内时前缀为空（不投影）', () => {
    expect(fileTreeRepoRelativePrefix('/repo', '/elsewhere')).toBe('')
  })
})

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
