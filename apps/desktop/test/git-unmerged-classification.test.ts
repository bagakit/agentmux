import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseGitStatusPorcelain } from '../src/main/git-service.js'
import {
  GIT_UNMERGED_CODES,
  GIT_UNMERGED_DESCRIPTION,
  gitChangeClass,
  gitChangeLabel,
  gitUnmergedCodeOf
} from '../src/renderer/src/lib/git-porcelain-status.js'
import { fileTreeGitStatusOfChange } from '../src/renderer/src/lib/file-tree-git-status.js'

/**
 * 守的缺陷（#746）：**真的合并冲突在两个界面上都被画成 added / deleted**。
 *
 * porcelain 给每条改动两个字母 `XY`。冲突是**这一对**的性质，不是任一个字母的性质，而两个界面各自
 * 手写过一份「挑一列然后 switch」的分类器。于是七个 unmerged 码里四个判错（`DD`→deleted、`AU`→added、
 * `DU`→deleted、`AA`→added），另外三个（`UD`/`UA`/`UU`）判对纯属巧合——它们的 X 恰好就是 `U`。两份手抄
 * 犯同一个错、且都没人发现，因为最常见的那个冲突 `UU` 在两边都是对的。
 *
 * ---
 * 前提全部由**真 git** 生成。理由与 file-tree-git-status-gitlink.test.ts 同：这条缺陷的整个前提就是
 * 「git 到底吐哪几个码」，用声明拼出来的 fixture 只会把我的假设当成证据（记忆
 * synthesized-fixture-is-self-certification）。所以七个码是在临时目录里真造一次合并冲突拿到的，反例
 * 那三个（`AD`/`RM`/` T`）也是真跑出来的。
 *
 * 反例这一族是这个文件的另一半，且比正面那半更重要：**「两列都非空⇒冲突」是错的**。`AD`（暂存了新增，
 * 又把文件从盘上删了）和 `RM`（暂存了重命名，又在工作区改了内容）都有两个非空列，都不是冲突，且都在
 * 任何合并之外正常出现。所以判据只能是那七个码的**闭集**，不能是「空不空」这种谓词。少了这半边，一个
 * 用 blankness 写的实现会在正面七条上全绿。
 *
 * 这个文件**不**守什么：不守 porcelain 解析本身（git-status-porcelain.test.ts 管），不守分类归谁所有
 * （git-change-classification-ownership 那道结构守卫管），也不守组件挂载后画成什么（本包无 DOM 环境，
 * 记忆 render-to-static-markup-blind-to-effects）。
 */

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args],
    { cwd, env: GIT_ENV, encoding: 'utf8' }
  )
}

/** 真跑一次生产用的 porcelain 命令，并按生产的解析器还原成 GitFileChange。 */
function statusOf(repo: string) {
  const raw = git(repo, 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all')
  return parseGitStatusPorcelain(raw).changes
}

let root: string
/** 每个 unmerged 码 → 造出它的那条改动。由真 git 填。 */
let conflicted: Map<string, ReturnType<typeof statusOf>[number]>
/** 两列都非空但**不是**冲突的那几条（`AD`/`RM`），加上单列的 ` T`。 */
let nonConflicted: Map<string, ReturnType<typeof statusOf>[number]>

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'am-unmerged-'))

  // ── 一次真合并，七个码一次拿全 ───────────────────────────────────────────────
  // 分歧的重命名（同一个源文件两边改到不同名字）造 DD/AU/UA；两边改同一文件造 UU；
  // 一边删一边改，两个方向各来一次，造 UD/DU；两边各加同名新文件造 AA。
  const merge = join(root, 'merge')
  git(root, 'init', '-q', '-b', 'main', 'merge')
  writeFileSync(join(merge, 'both_mod.txt'), 'base\n')
  writeFileSync(join(merge, 'we_del.txt'), 'base\n')
  writeFileSync(join(merge, 'they_del.txt'), 'base\n')
  writeFileSync(join(merge, 'rename_src.txt'), 'base\n')
  git(merge, 'add', '-A')
  git(merge, 'commit', '-qm', 'base')

  git(merge, 'checkout', '-q', '-b', 'theirs')
  writeFileSync(join(merge, 'both_mod.txt'), 'theirs\n')
  writeFileSync(join(merge, 'we_del.txt'), 'theirs\n')
  unlinkSync(join(merge, 'they_del.txt'))
  git(merge, 'mv', 'rename_src.txt', 'theirs_target.txt')
  writeFileSync(join(merge, 'both_add.txt'), 'theirs\n')
  git(merge, 'add', '-A')
  git(merge, 'commit', '-qm', 'theirs')

  git(merge, 'checkout', '-q', 'main')
  writeFileSync(join(merge, 'both_mod.txt'), 'ours\n')
  unlinkSync(join(merge, 'we_del.txt'))
  writeFileSync(join(merge, 'they_del.txt'), 'ours\n')
  git(merge, 'mv', 'rename_src.txt', 'ours_target.txt')
  writeFileSync(join(merge, 'both_add.txt'), 'ours\n')
  git(merge, 'add', '-A')
  git(merge, 'commit', '-qm', 'ours')

  // 冲突是这一步的**预期**结果，所以非零退出码要吃掉，别当失败。
  try {
    git(merge, 'merge', 'theirs')
  } catch {
    /* 冲突即成功 */
  }

  conflicted = new Map()
  for (const change of statusOf(merge)) {
    conflicted.set(`${change.index}${change.worktree}`, change)
  }

  // ── 反例：两列都脏但不是冲突 ─────────────────────────────────────────────────
  const plain = join(root, 'plain')
  git(root, 'init', '-q', '-b', 'main', 'plain')
  writeFileSync(join(plain, 'keep.txt'), 'base\n')
  writeFileSync(join(plain, 'tc.txt'), 'x\n')
  git(plain, 'add', '-A')
  git(plain, 'commit', '-qm', 'base')

  // AD：暂存新增，再把文件从盘上删掉。两列都非空，不是冲突。
  writeFileSync(join(plain, 'gone.txt'), 'new\n')
  git(plain, 'add', 'gone.txt')
  unlinkSync(join(plain, 'gone.txt'))
  // RM：暂存重命名，再在工作区改内容。两列都非空，不是冲突。
  git(plain, 'mv', 'keep.txt', 'moved.txt')
  appendFileSync(join(plain, 'moved.txt'), 'more\n')
  //  T：类型改变（文件 → 软链接）。单列，但走的是 switch 的 `T` 臂。
  unlinkSync(join(plain, 'tc.txt'))
  symlinkSync('moved.txt', join(plain, 'tc.txt'))

  nonConflicted = new Map()
  for (const change of statusOf(plain)) {
    nonConflicted.set(`${change.index}${change.worktree}`, change)
  }
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('git 的七个 unmerged 码（前提由真 git 生成）', () => {
  it('这一次真合并吐出了全部七个码——后面每条用例的前提', () => {
    // 这是本文件的**在场自检**：七个码若不是真的都在场，下面的循环就会在缺席的码上悄悄少跑几轮，
    // 而 `it` 照旧全绿（记忆 vitest-empty-filter-yields-no-counts 的同族：不可观测的空转）。
    expect([...conflicted.keys()].sort()).toEqual([...GIT_UNMERGED_CODES].sort())
  })

  it('GIT_UNMERGED_CODES 恰好是 git 自己吐的那一套，不多不少', () => {
    // 与上一条不是同一件事：上一条说「fixture 齐了」，这一条说「常量表没有多列也没有漏列」。
    // 少一个码 → 那种冲突被判成 added/deleted；多一个 → 一个正常状态被误判成冲突。
    expect(new Set(GIT_UNMERGED_CODES)).toEqual(new Set(conflicted.keys()))
  })

  for (const code of GIT_UNMERGED_CODES) {
    it(`${code} 被认成冲突，而不是按单列读成 added/deleted`, () => {
      const change = conflicted.get(code)
      expect(change, `fixture 缺 ${code}`).toBeDefined()
      expect(gitUnmergedCodeOf(change!)).toBe(code)
      expect(gitChangeClass(change!)).toBe('conflicted')
    })

    it(`${code} 在文件树里画成 conflicted 标记`, () => {
      // 这是缺陷的用户可见面：`DD`/`AU`/`DU`/`AA` 此前在树里是绿 `A` 或红 `D`，一点冲突标记都没有。
      expect(fileTreeGitStatusOfChange(conflicted.get(code)!)).toBe('conflicted')
    })

    it(`${code} 的标签点明是哪一种冲突`, () => {
      // 「deleted by them」与「deleted by us」要用户做相反的事，一个统一的 "Conflicted" 恰好在最需要
      // 区分的时候把这个事实丢掉。
      expect(gitChangeLabel(conflicted.get(code)!)).toBe(`Conflict: ${GIT_UNMERGED_DESCRIPTION[code]}`)
    })
  }
})

describe('两列都脏但不是冲突（闭集判据的另一半）', () => {
  it('反例 fixture 真的造出了 AD 与 RM——两列都非空', () => {
    // 在场自检。这两个码若不在场，下面「不是冲突」的断言就恒真，而它们正是「别用 blankness 判」的全部
    // 理由（记忆 sampled-pair-can-be-the-blind-spot）。
    expect([...nonConflicted.keys()].sort()).toEqual([' T', 'AD', 'RM'])
  })

  it('AD（暂存新增后从盘上删掉）不是冲突', () => {
    const change = nonConflicted.get('AD')!
    expect(gitUnmergedCodeOf(change)).toBeNull()
    expect(gitChangeClass(change)).not.toBe('conflicted')
  })

  it('RM（暂存重命名后又改内容）不是冲突', () => {
    const change = nonConflicted.get('RM')!
    expect(gitUnmergedCodeOf(change)).toBeNull()
    expect(gitChangeClass(change)).not.toBe('conflicted')
  })

  it('AD 按暂存那一列读成 added（暂存区里确实是一次新增）', () => {
    expect(gitChangeClass(nonConflicted.get('AD')!)).toBe('added')
    expect(gitChangeLabel(nonConflicted.get('AD')!)).toBe('Added')
  })

  it('RM 按暂存那一列读成 renamed', () => {
    expect(gitChangeClass(nonConflicted.get('RM')!)).toBe('renamed')
    expect(gitChangeLabel(nonConflicted.get('RM')!)).toBe('Renamed')
  })

  it('类型改变有自己的类别与措辞，不被折进 modified', () => {
    const change = nonConflicted.get(' T')!
    expect(gitChangeClass(change)).toBe('typeChanged')
    expect(gitChangeLabel(change)).toBe('Type changed')
    // 但**树上**刻意折成 modified：折叠的一行只有一个标记位，`T` 挨着 `M` 对读者没有增量。
    expect(fileTreeGitStatusOfChange(change)).toBe('modified')
  })
})
