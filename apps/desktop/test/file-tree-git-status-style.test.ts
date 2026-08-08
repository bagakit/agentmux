import { describe, expect, it } from 'vitest'
import { allStyleRules } from './helpers/styles.js'
import {
  FILE_TREE_GIT_STATUS_CLASS,
  type FileTreeGitStatus
} from '../src/renderer/src/lib/file-tree-git-status.js'

/**
 * 文件树源码状态标记的 CSS 守卫。
 *
 * `rendered-class-has-rule` 只查选择器**名**在不在场：删掉一条规则的**声明体**（比如把
 * `.tree-row--git-deleted .tree-row__git { color: var(--red-text) }` 的 color 拿掉），那道守卫照旧
 * 全绿，而删除态的红色再也画不出来（记忆 CSS 守卫只查选择器名时删掉承重声明体全绿）。这条补的就是
 * 「每个状态 class 真的把标记染上了一个 token 颜色」，且逐状态钉死颜色取值——把两个状态的颜色对调
 * 也会红。
 *
 * class 名的清单不手抄，直接来自 lib 的穷举表：加一个状态、表里多一项，这里自动要求它也有规则。
 */

// 每个状态期望的标记颜色 token。故意与源码分开写死（外部锚点），这样把 CSS 里两个状态的颜色对调、
// 或把某条 color 删掉，都会与这份清单对不上而变红。
const EXPECTED_MARK_COLOR: Record<FileTreeGitStatus, string> = {
  modified: 'var(--amber-text)',
  renamed: 'var(--amber-text)',
  added: 'var(--green-text)',
  untracked: 'var(--green-text)',
  deleted: 'var(--red-text)',
  conflicted: 'var(--red-text)'
}

const css = allStyleRules()

/**
 * 取出所有把 `color: <token>` 赋给 `.tree-row__git` 的规则里，选择器上出现的状态 class 与那个颜色。
 * 允许一条规则用逗号列出多个选择器（本表就是这么合并同色状态的），因此对整条选择器串扫描每个状态类。
 */
function markColorFor(statusClass: string): string | null {
  // 匹配形如 `.tree-row--git-deleted .tree-row__git { color: var(--red-text); }`，也容纳逗号合并的
  // 多选择器规则：先找到包含该 class 且落在 .tree-row__git 上的规则块，读它的 color。
  const rulePattern = new RegExp(
    `\\.${statusClass}\\s+\\.tree-row__git[^{]*\\{[^}]*color:\\s*([^;}]+)`
  )
  const match = css.match(rulePattern)
  return match ? match[1]!.trim() : null
}

describe('文件树 git 状态标记的 CSS', () => {
  it('每个状态 class 都给标记染上它约定的 token 颜色', () => {
    for (const [status, statusClass] of Object.entries(FILE_TREE_GIT_STATUS_CLASS) as [
      FileTreeGitStatus,
      string
    ][]) {
      const color = markColorFor(statusClass)
      expect(color, `${statusClass} 的 .tree-row__git 没有 color 声明——标记不着色了`).not.toBeNull()
      expect(color, `${statusClass} 的标记颜色与约定不符`).toBe(EXPECTED_MARK_COLOR[status])
    }
  })

  it('颜色全部走 token，标记规则里不出现裸 hex', () => {
    // 抓住 .tree-row__git 那一族规则，断言其中没有 #rrggbb。
    const markRules = [...css.matchAll(/\.tree-row--git-[\w-]+\s+\.tree-row__git[^{]*\{[^}]*\}/g)]
      .map((m) => m[0])
      .join('\n')
    expect(markRules, '标记规则一条都没扫到——判据落空会恒绿').not.toBe('')
    expect(/#[0-9a-fA-F]{3,8}\b/.test(markRules), '标记规则里出现了裸 hex，颜色必须走 token').toBe(false)
  })
})
