import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AgentSessionRecoveryCandidate } from '../src/shared/contracts.js'
import {
  classifyContinuityFailure,
  continuityRefreshEnabled,
  continuityRetryEnabled
} from '../src/renderer/src/lib/continuity-failure-notice.js'
import { recoveryCandidateSession } from '../src/renderer/src/store.js'

// The point of this module is that "resume failed" is not one fact. Core already distinguishes the
// reasons; the renderer used to collapse them into a single disabled "Resume unavailable" button, so
// a Provider that can NEVER resume looked exactly like a Host that is merely offline right now. These
// tests assert the three classes stay distinguishable — and that the remedy matches the class, since
// a retry button on a permanently-unresumable Agent promises something that cannot happen.

describe('continuity failure classes', () => {
  it('says a Provider that cannot resume is permanent, and offers a new Agent', () => {
    const notice = classifyContinuityFailure('unavailable', 'provider-resume-unsupported')

    expect(notice?.remedy).toEqual({ kind: 'start-new' })
    expect(continuityRetryEnabled(notice)).toBe(false)
    // The distinguishing fact: it is the Provider, not this session, and nothing was lost here.
    expect(notice?.reason).toContain('Provider')
    expect(notice?.title).not.toBe('Agent resume unavailable')
  })

  it('scopes a missing resume token to this one Agent', () => {
    const notice = classifyContinuityFailure('unavailable', 'native-handle-unavailable')

    expect(notice?.remedy).toEqual({ kind: 'start-new' })
    // "Other Agents are unaffected" is the whole reason this class is separate from the one above.
    expect(notice?.reason).toContain('Other Agents')
  })

  it('treats a missing Provider as retryable, because it can come back', () => {
    // The one unavailable case that is NOT permanent: install the Provider, or bring the Host back,
    // and the same Agent Session resumes. Telling the user to start a new Agent would throw away a
    // recoverable session.
    const notice = classifyContinuityFailure('unavailable', 'provider-unavailable')

    expect(notice?.remedy).toEqual({ kind: 'retry' })
    expect(continuityRetryEnabled(notice)).toBe(true)
    expect(notice?.reason).toContain('intact')
  })

  it('tells a stale Run to re-read, never to wait for a Run that was already replaced', () => {
    // 这是这条轴的核心：session-run-changed 说的是「这条 Agent 还活着，但已经在一个更新的 Run 上」。
    // 「等一下」在这里是**错建议**——被换掉的那条 Run 等多久都不会回来。此前两类折成同一个 'wait'，
    // 于是一半用户被指着一个永不返回的东西干等。
    const notice = classifyContinuityFailure('conflict', undefined, 'session-run-changed')

    expect(notice?.remedy).toEqual({ kind: 'refresh' })
    expect(notice?.title).toContain('newer Run')
    // 落在 refresh 而不是 retry：再 resume 一次是第二次抢占，不是「让界面追上事实」。
    expect(continuityRefreshEnabled(notice)).toBe(true)
    expect(continuityRetryEnabled(notice)).toBe(false)
    // 而且必须说清 Agent 本身没丢——否则用户会去新开一个，白扔一条活着的 session。
    expect(notice?.reason).toContain('alive')
  })

  it('tells a busy lifecycle op to wait, because that one really does come back', () => {
    const notice = classifyContinuityFailure('conflict', undefined, 'lifecycle-busy')

    expect(notice?.remedy).toEqual({ kind: 'wait' })
    expect(notice?.title).toContain('Another operation')
    // 「等」这一类没有任何按得动的按钮：按了也不会让那个操作提前结束。
    expect(continuityRefreshEnabled(notice)).toBe(false)
    expect(continuityRetryEnabled(notice)).toBe(false)
  })

  it('keeps the two conflict classes from collapsing back into one', () => {
    // 回归锚：这两类**要求用户做的事相反**。任何把它们说成同一句话、或给同一个动作的改动，
    // 都会让其中一类的建议变成错的——这正是本条轴要消灭的东西。
    const stale = classifyContinuityFailure('conflict', undefined, 'session-run-changed')
    const busy = classifyContinuityFailure('conflict', undefined, 'lifecycle-busy')

    expect(stale?.remedy).not.toEqual(busy?.remedy)
    expect(stale?.title).not.toBe(busy?.title)
    expect(stale?.reason).not.toBe(busy?.reason)
    expect(stale?.actionLabel).not.toBe(busy?.actionLabel)
  })

  it('admits it does not know which kind of claim it was when Core reports none', () => {
    // conflict 但没给类别：如实说分不清，不挑一类当默认。挑 'wait' 就会对一半的人说错话
    // （那正是修好前的行为），挑 'refresh' 至少不会把人钉在原地干等。
    const notice = classifyContinuityFailure('conflict', undefined)

    expect(notice?.remedy).toEqual({ kind: 'refresh' })
    expect(notice?.reason).toContain('did not report')
    // 而它绝不能冒充成两个已知类别中的任何一个。
    expect(notice?.title).not.toBe(
      classifyContinuityFailure('conflict', undefined, 'session-run-changed')?.title
    )
    expect(notice?.title).not.toBe(
      classifyContinuityFailure('conflict', undefined, 'lifecycle-busy')?.title
    )
    // 更严的一条：不许**近似**于 lifecycle-busy 的措辞。这两格要求的动作相反（重读 vs 等），
    // 而标题一旦读起来像同一句话，用户拿到的就是"同一句话要求两件相反的事"——那正是这一层
    // 要消灭的形状，且它躲得过上面那种逐字不等的断言（实测：曾是
    // 'This Agent is owned by another operation' vs 'Another operation is using this Agent'）。
    const busyTitle = classifyContinuityFailure('conflict', undefined, 'lifecycle-busy')?.title ?? ''
    const shared = new Set(busyTitle.toLowerCase().match(/[a-z]+/g) ?? [])
    const overlap = (notice?.title.toLowerCase().match(/[a-z]+/g) ?? []).filter((word) =>
      shared.has(word) && !['this', 'agent', 'the', 'a', 'is', 'it'].includes(word)
    )
    expect(overlap).toEqual([])
  })

  it('never offers both buttons for one notice', () => {
    // 互斥是这一层的产出本身：一次通知只能落在一个动作上。同时给「重读」和「重试恢复」，
    // 用户又回到「不知道该按哪个」——那正是分类要消灭的东西。
    const every = [
      classifyContinuityFailure('unavailable', 'provider-resume-unsupported'),
      classifyContinuityFailure('unavailable', 'native-handle-unavailable'),
      classifyContinuityFailure('unavailable', 'provider-unavailable'),
      classifyContinuityFailure('unavailable', 'unknown-session'),
      classifyContinuityFailure('unavailable', undefined),
      classifyContinuityFailure('conflict', undefined),
      classifyContinuityFailure('conflict', undefined, 'session-run-changed'),
      classifyContinuityFailure('conflict', undefined, 'lifecycle-busy')
    ]

    for (const notice of every) {
      expect(continuityRefreshEnabled(notice) && continuityRetryEnabled(notice)).toBe(false)
    }
    // 且两个判据都不能退化成恒 false——那样按钮全死，等于回到折叠前。
    expect(every.filter((notice) => continuityRefreshEnabled(notice)).length).toBeGreaterThan(0)
    expect(every.filter((notice) => continuityRetryEnabled(notice)).length).toBeGreaterThan(0)
  })

  it('admits it does not know when Core reports no reason', () => {
    // Honest "we don't know" rather than picking a class. Guessing "Provider unsupported" would send
    // the user to start a new Agent when the truth might be a dropped Host.
    const notice = classifyContinuityFailure('unavailable', undefined)

    expect(notice?.remedy).toEqual({ kind: 'retry' })
    expect(notice?.reason).toContain('did not report')
  })

  it('produces nothing at all when continuity did not fail', () => {
    expect(classifyContinuityFailure(undefined, undefined)).toBeNull()
    expect(continuityRetryEnabled(null)).toBe(false)
  })

  it('keeps every class distinguishable — no two share a title or an action', () => {
    // This is the acceptance criterion itself: 合成一句「恢复失败」等于没说. If a future edit makes
    // two classes render the same words, this is the test that notices. 两个 conflict 类也在里面：
    // 它们此前正是被折成同一条，而它们要求用户做的事相反。
    const notices = [
      classifyContinuityFailure('unavailable', 'provider-resume-unsupported'),
      classifyContinuityFailure('unavailable', 'native-handle-unavailable'),
      classifyContinuityFailure('unavailable', 'provider-unavailable'),
      classifyContinuityFailure('unavailable', 'unknown-session'),
      classifyContinuityFailure('conflict', undefined, 'session-run-changed'),
      classifyContinuityFailure('conflict', undefined, 'lifecycle-busy')
    ]

    expect(notices.every((notice) => notice !== null)).toBe(true)
    const titles = new Set(notices.map((notice) => notice?.title))
    const reasons = new Set(notices.map((notice) => notice?.reason))
    expect(titles.size).toBe(notices.length)
    expect(reasons.size).toBe(notices.length)
  })

  it('never offers a button that cannot work', () => {
    // A retry that is guaranteed to fail is worse than a disabled button: it promises a result.
    //
    // 两个判据都要查。此前这里只查 retry 那一侧，于是「给出一个按了也没用的**重读**按钮」这半边
    // 完全没人守——把某个 unavailable 类的 remedy 改成 'refresh' 能静默绕过整条守卫，而那恰恰是
    // 它声称要禁止的形状（notice 源文件 :141-142 也是这么写的）。实测见过这颗变异。
    //
    // refresh 对这三类都是错的答案：它的语义是「session 还活着，只是我们手里的 Run 过期了，重读
    // 快照就能追上」（源文件 :26-33）。而这三类要么这个 Provider 根本不能 resume、要么从来没记下
    // 凭据、要么 Core 连 retired binding 都没有——没有"当前快照"可读，按下去必然再失败一次。
    for (const reason of ['provider-resume-unsupported', 'native-handle-unavailable', 'unknown-session'] as const) {
      const notice = classifyContinuityFailure('unavailable', reason)
      expect(continuityRetryEnabled(notice), `${reason} 不该给可按的「重试恢复」`).toBe(false)
      expect(continuityRefreshEnabled(notice), `${reason} 不该给可按的「重读」——没有可重读的快照`).toBe(false)
    }
  })

  it('每个 unavailable 原因的 remedy 都被钉死，没有一个只靠"不是 retry"过关', () => {
    // 上面那条查的是「哪些按钮不能给」，这条查「该给哪个」。两者缺一不可：只有否定式断言时，
    // 把 start-new 换成另一个同样不可按的 remedy 也能全绿，而那会换掉 actionLabel、给用户
    // 一句不同的指示。unknown-session 此前是五个原因里唯一一个 remedy 从未被任何 toEqual 钉死的。
    //
    // 判据取自每一类的事实，不是照抄现状：
    //   - provider-resume-unsupported / native-handle-unavailable：换个时间点也不会变 → start-new
    //   - unknown-session：Core 连 retired binding 都没有，同样回不来 → start-new
    //   - provider-unavailable：Session 完好，Provider 装回来就能继续 → retry
    expect(classifyContinuityFailure('unavailable', 'provider-resume-unsupported')?.remedy).toEqual({ kind: 'start-new' })
    expect(classifyContinuityFailure('unavailable', 'native-handle-unavailable')?.remedy).toEqual({ kind: 'start-new' })
    expect(classifyContinuityFailure('unavailable', 'unknown-session')?.remedy).toEqual({ kind: 'start-new' })
    expect(classifyContinuityFailure('unavailable', 'provider-unavailable')?.remedy).toEqual({ kind: 'retry' })
  })

  it('两个判据互斥：一次通知只落在一个动作上', () => {
    // 源文件 :155-156 声明「这条互斥由测试钉住」，但此前没有任何测试钉它。遍历全部六类，
    // 而不是抽查——互斥是个全集性质，抽一对过了不代表没有第七类同时满足两边。
    const notices = [
      classifyContinuityFailure('unavailable', 'provider-resume-unsupported'),
      classifyContinuityFailure('unavailable', 'native-handle-unavailable'),
      classifyContinuityFailure('unavailable', 'provider-unavailable'),
      classifyContinuityFailure('unavailable', 'unknown-session'),
      classifyContinuityFailure('unavailable', undefined),
      classifyContinuityFailure('conflict', undefined, 'session-run-changed'),
      classifyContinuityFailure('conflict', undefined, 'lifecycle-busy'),
      classifyContinuityFailure('conflict', undefined)
    ]
    for (const notice of notices) {
      expect(notice).not.toBeNull()
      const both = continuityRetryEnabled(notice) && continuityRefreshEnabled(notice)
      expect(both, `${notice?.title} 同时给了「重试」与「重读」两个按钮`).toBe(false)
    }
    // 且这两个判据真的各自有活儿：都恒返回 false 也能满足互斥，那是把界面变成没有按钮。
    expect(notices.some((notice) => continuityRetryEnabled(notice)), '没有任何一类可重试').toBe(true)
    expect(notices.some((notice) => continuityRefreshEnabled(notice)), '没有任何一类可重读').toBe(true)
  })
})

describe('the store actually carries Core’s reason to the surface', () => {
  // Asserting the classifier alone proves nothing about the seam this task is about: a test that
  // seeds `continuityReason` into a fixture stays green even if the store never writes it. These
  // assert the RETURNED projection, so dropping the field in store.ts turns them red.
  function candidate(): AgentSessionRecoveryCandidate {
    return {
      agentSessionId: 'agent-1',
      hostId: 'local',
      workspacePath: '/repo',
      providerId: 'codex',
      executorId: 'codex',
      capabilities: {
        terminal: true,
        hookEvents: true,
        timeline: 'complete-events',
        permission: 'observe',
        providerResume: true,
        acp: false,
        replyCorrelation: 'none'
      },
      label: 'Codex',
      createdAt: 1,
      updatedAt: 1,
      run: { runId: 'run-1' }
    }
  }

  it('projects each unavailable reason onto the Session snapshot', () => {
    for (const reason of [
      'provider-resume-unsupported',
      'native-handle-unavailable',
      'provider-unavailable',
      'unknown-session'
    ] as const) {
      const session = recoveryCandidateSession(candidate(), {
        kind: 'unavailable',
        agentSessionId: 'agent-1',
        previousRun: { runId: 'run-1' },
        reason,
        evidence: { kind: 'run-missing', observedAt: 1 }
      })

      expect(session.status.continuity).toBe('unavailable')
      expect(session.status.continuityReason).toBe(reason)
      // And the reason must survive far enough to change what the user is told.
      expect(classifyContinuityFailure('unavailable', session.status.continuityReason)).not.toBeNull()
    }
  })

  it('carries which kind of conflict it was, because the two ask for opposite things', () => {
    // 这条守的是**投影这一段**，不是判定层：Core 的 conflict variant 一直带着 reason，丢失发生在
    // store 把它投成 SessionSnapshot 的时候。断言落在返回的快照上，所以 store.ts 里少写这一项就变红。
    for (const reason of ['session-run-changed', 'lifecycle-busy'] as const) {
      const session = recoveryCandidateSession(candidate(), {
        kind: 'conflict',
        agentSessionId: 'agent-1',
        previousRun: { runId: 'run-1' },
        currentRun: { runId: 'run-2' },
        reason
      })

      expect(session.status.continuity).toBe('conflict')
      expect(session.status.continuityConflict).toBe(reason)
      // conflict 不是 unavailable，两个字段不许互相冒充——否则 conflict 会掉进 unavailable 的分支里。
      expect(session.status.continuityReason).toBeUndefined()
    }
  })

  it('projects the two conflict classes onto DIFFERENT remedies end to end', () => {
    // 逐层各自绿仍然可能整条链是死的：投影写了字段、判定认得取值，但两者对不上就还是折叠。
    // 这条把 store → 判定 串起来跑，只有真的端到端分开才绿。
    const remedy = (reason: 'session-run-changed' | 'lifecycle-busy') => {
      const session = recoveryCandidateSession(candidate(), {
        kind: 'conflict',
        agentSessionId: 'agent-1',
        previousRun: { runId: 'run-1' },
        currentRun: { runId: 'run-2' },
        reason
      })
      return classifyContinuityFailure(
        session.status.continuity,
        session.status.continuityReason,
        session.status.continuityConflict
      )?.remedy
    }

    expect(remedy('session-run-changed')).toEqual({ kind: 'refresh' })
    expect(remedy('lifecycle-busy')).toEqual({ kind: 'wait' })
  })

  it('两个投影出口共用同一处判定——各写一遍时这条红', () => {
    // 这条守的是**结构**，不是某一次取值。理由是实测的：`continuityConflict` 起初只加在
    // recoveryCandidateSession 一处，于是**用户自己点「恢复」**走的 recoverSession 照旧折叠，
    // 而上面所有断言都还是绿的（它们只够得着前一处）。这个洞在变异中存活过一轮。
    //
    // 正确的修法不是给第二处再配一条断言，而是让两条路共用一处判定；这条则钉住「共用」本身不被拆回去。
    // 与「守卫按出口数不按条件数」同一条判据：两处该联动的写入分居两地必然 drift。
    const source = readFileSync(
      new URL('../src/renderer/src/store.ts', import.meta.url),
      'utf8'
    )

    // 两个出口都必须经那一处产出。
    expect(source.match(/\.\.\.continuityStatusFields\(recovery\)/g)).toHaveLength(2)
    // 且这些字段只许在那个函数体里被赋值一次——任何出口自己再写一遍就是把 drift 装回去。
    expect(source.match(/continuityConflict: recovery\.reason/g)).toHaveLength(1)
    expect(source.match(/continuityReason: recovery\.reason/g)).toHaveLength(1)
    expect(source.match(/detail: continuityFailureDetail\(recovery\)/g)).toHaveLength(1)
  })

  it('detail 也按 Core 给的类别分，不按 currentRun 在不在场猜', () => {
    // 同一个「替 Core 猜类别」的形状还藏在 detail 里：它此前按 currentRun 是否存在来选措辞，
    // 于是一条 session-run-changed 只要没带 currentRun，就被说成「另一个操作占着」——
    // 与横幅标题互相矛盾。判据必须是 reason 本身。
    const detail = (
      reason: 'session-run-changed' | 'lifecycle-busy',
      currentRun?: { runId: string }
    ) =>
      recoveryCandidateSession(candidate(), {
        kind: 'conflict',
        agentSessionId: 'agent-1',
        previousRun: { runId: 'run-1' },
        ...(currentRun ? { currentRun } : {}),
        reason
      }).status.detail

    // 带 currentRun 时说得出具体是哪条 Run。
    expect(detail('session-run-changed', { runId: 'run-2' })).toContain('run-2')
    // 不带也仍旧是「已经换到更新的 Run」，绝不退化成「另一个操作占着」。
    expect(detail('session-run-changed')).toContain('newer Run')
    expect(detail('session-run-changed')).not.toContain('Another lifecycle operation')
    // 而真正被占着的那一类才这么说。
    expect(detail('lifecycle-busy')).toContain('Another lifecycle operation')
  })
})
