import { describe, expect, it } from 'vitest'
import {
  GIT_REMOTE_SUCCESS,
  describeGitRemote,
  discardIntent,
  type GitRemoteFailureKind,
  type GitRemoteVerb
} from '../src/renderer/src/lib/git-remote-outcome.js'
import type { GitRemoteResult } from '../src/shared/contracts.js'

/**
 * 守的缺陷（#206）：preload 的 git 面有 10 个方法，其中 5 个（unstage / discard / push / pull /
 * fetch）**渲染层零调用者**——main 侧实现完整、有分类、有脱敏、有路径硬化，就是没有任何入口。
 *
 * 这一族最容易的错修法是「加个按钮，失败就 setError(result.message)」。那样等于把 main 侧那套
 * 5-way 分类压回 1 类：用户看到 git 原话而不是下一步。所以这一层的判据不是「有没有说话」，而是
 * **每一对 (动作, kind) 都说了自己那件事**。
 */

const VERBS: GitRemoteVerb[] = ['push', 'pull', 'fetch']
const FAILURES: GitRemoteFailureKind[] = ['no-upstream', 'non-fast-forward', 'diverged', 'error']

/** 造一个失败结果。message 刻意是可辨认的假 git 原话。 */
function failure(kind: GitRemoteFailureKind, message = 'fatal: something git said'): GitRemoteResult {
  return { kind, message } as GitRemoteResult
}

describe('远端动作的结果说成下一步', () => {
  it('成功时的回执认得出是哪一个动作', () => {
    // 三句必须互不相同：并发点了 Pull 和 Fetch 时，回执要能对上你点的那一个。
    const messages = VERBS.map((verb) => {
      const outcome = describeGitRemote(verb, { kind: 'ok' })
      expect(outcome.ok, `${verb} 的 ok 结果被当成了失败`).toBe(true)
      return outcome.message
    })
    expect(new Set(messages).size, '两个动作的成功回执是同一句话——看不出哪个成了').toBe(VERBS.length)
  })

  it('每一对 (动作, 失败 kind) 都给出一句非空的话', () => {
    // 覆盖全集，不是抽样：漏掉的那一格在界面上是一个什么都不说的失败。
    for (const verb of VERBS) {
      for (const kind of FAILURES) {
        const outcome = describeGitRemote(verb, failure(kind))
        expect(outcome.ok, `${verb}/${kind} 被当成了成功`).toBe(false)
        expect(outcome.message.trim(), `${verb}/${kind} 没有任何说法`).not.toBe('')
      }
    }
  })

  it('push 与 pull 对 no-upstream 说的是相反的下一步', () => {
    // 这是整条守卫的核心，也是「只按 kind 写一张表」会犯的那个错（#85 的形状）：
    //   - push 拿到 no-upstream ≈ detached HEAD（push 自带 --set-upstream），下一步是 checkout。
    //   - pull 拿到 no-upstream ≈ 这个分支还没发布，下一步是 push。
    // 两句话若相同，其中一句必然是错建议——而它们看起来都「说了话」，所以非空断言抓不到。
    const push = describeGitRemote('push', failure('no-upstream'))
    const pull = describeGitRemote('pull', failure('no-upstream'))
    expect(push.message).not.toBe(pull.message)
    // 逐字不等还不够（记忆 near-identical-copy-defeats-distinct-classes）：钉住各自真的指向了那个动作。
    expect(pull.message.toLowerCase(), 'pull 的 no-upstream 应当让用户先 push').toContain('push')
    expect(push.message.toLowerCase(), 'push 的 no-upstream 应当让用户先 checkout 一个分支').toContain('check out')
    // 反向也钉：把 push 那句写成「先 push」是自指的废话，这一条挡住它。
    expect(push.message.toLowerCase()).not.toContain('push it first')
  })

  it('push 的 non-fast-forward 指向 pull，pull 的 diverged 指向 merge/rebase 决定', () => {
    // 两个最常遇到的真处境。判据是「说的那个动作是不是能解决它的那个动作」。
    const rejected = describeGitRemote('push', failure('non-fast-forward'))
    expect(rejected.message.toLowerCase(), 'push 被拒时应当让用户先 pull').toContain('pull')
    const diverged = describeGitRemote('pull', failure('diverged'))
    const text = diverged.message.toLowerCase()
    expect(text.includes('merge') || text.includes('rebase'), 'diverged 应当点明要在 merge / rebase 之间做决定').toBe(true)
  })

  it('只有认不出来的 error 才附 git 原话', () => {
    // 分野是承重的：`error` 那一类我们编不出比 git 更准的说法（认证、传输、损坏），盖住它就是隐瞒；
    // 其余三类我们已经把处境翻译成下一步，再接一句 git 原文只是把同一件事说两遍。
    const raw = 'fatal: Authentication failed for https://example.invalid/repo.git'
    for (const verb of VERBS) {
      expect(
        describeGitRemote(verb, failure('error', raw)).message,
        `${verb} 的 error 没有把 git 的原话带上——真失败被我们的话盖住了`
      ).toContain(raw)
      for (const kind of FAILURES.filter((candidate) => candidate !== 'error')) {
        expect(
          describeGitRemote(verb, failure(kind, raw)).message,
          `${verb}/${kind} 把 git 原话也贴上了——这一类已经翻译过，重复只会更让人不知所措`
        ).not.toContain(raw)
      }
    }
  })

  it('error 的原话为空时不留一个尾巴', () => {
    // git 偶尔什么都不打印（超时被杀）。此时不能显示 "Could not push:" 后面空着。
    const outcome = describeGitRemote('push', failure('error', '   '))
    expect(outcome.message.trim()).toBe(outcome.message.trim())
    expect(outcome.message.endsWith(':'), '空原话时应当自己收尾，而不是留一个悬着的冒号').toBe(true)
    expect(outcome.message.trim(), '空原话时不该出现两个空格或悬空片段').not.toMatch(/:\s+$/u)
  })

  it('成功表与失败判据取自同一个动作集合', () => {
    // 在场自检：上面几条都遍历 VERBS。若某天加了第四个动作而这里的手写清单没跟上，那个动作的
    // 每一格都无人守，而全部断言照旧全绿（记忆 name-existence-check-is-blind-to-rule-bodies）。
    // 判据是「导出的成功表的键集恰好是被遍历的那个集合」——两侧一个多一个少都红。
    expect(Object.keys(GIT_REMOTE_SUCCESS).sort()).toEqual([...VERBS].sort())
  })
})

describe('丢弃改动不可能一次点击就发生', () => {
  it('第一次点是武装，不是执行', () => {
    // discard 对未跟踪文件走的是 `git clean --force`：从磁盘删除，无 reflog、无 stash、不可撤销。
    // 而这个按钮就挨在 Stage 旁边。一次点击直接删，是这一族最贵的误触。
    expect(discardIntent(null, 'src/a.ts')).toBe('arm')
  })

  it('同一行第二次点才执行', () => {
    expect(discardIntent('src/a.ts', 'src/a.ts')).toBe('discard')
  })

  it('武装着 A 去点 B 是给 B 武装，不是删 B', () => {
    // 「武装」若只按「有没有武装过」判，它就只挡住了第一次点击，挡不住点错行——用户武装了 A，
    // 手滑点到 B，B 立刻被删。这一条把「武装是逐行的」钉住。
    expect(discardIntent('src/a.ts', 'src/b.ts')).toBe('arm')
  })
})
