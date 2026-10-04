import type { SessionSnapshot } from '../../../shared/contracts'

/**
 * 恢复不了的时候，到底是哪一类恢复不了——判定层。
 *
 * Core 已经把原因分得很细（provider 根本不支持 resume / 这条 session 没有 verified handle /
 * 另一个生命周期操作占着它），但界面上四种原因收敛成同一句 "Resume unavailable"，用户只看到
 * 东西没了，无从判断是自己记错了、应用丢了数据，还是换个做法就能恢复。**合成一句「恢复失败」
 * 等于没说**。
 *
 * 三类要求用户做的事完全不同：Provider 不支持是**永久**的（这个 Agent 换个时间点也回不来，
 * 该新开一个），handle 缺失只关乎**这一条** session（别的 Agent 不受影响），conflict 说明
 * 东西**还在、只是被占着**（等那个操作结束就能回来）。把它们说成同一件事，用户就无法在
 * 「重试」「新开」「等一下」之间做出正确选择——而这正是他此刻唯一需要做的决定。
 *
 * 判定写成纯函数而不是散在 JSX 里：本仓库测试用 `renderToStaticMarkup`，effect 不跑、DOM 事件
 * 点不动，写在组件里的分支没有断言够得着。与 service-window 的分类层同构。
 */

/** 用户此刻能做的那件事。恢复动作是否可用，取决于原因，不取决于"失败了没有"。 */
export type ContinuityRemedy =
  /** 换个时间点也不会变——只能新开一个 Agent。 */
  | { kind: 'start-new' }
  /** 东西还在，只是被别的操作**此刻**占着——等它结束。 */
  | { kind: 'wait' }
  /**
   * 这条 session 还活着，但我们手里的 Run 已经过期——重读它的当前快照。
   *
   * 与 `wait` 分开是这条轴的重点：Run 已经被换掉了，等多久都不会回来，
   * 而重读（按稳定的 agentSessionId 取，见 runtime-controller 的 refresh）能立刻拿到真的那条。
   * 与 `retry` 也分开：这里不该再 resume 一次（已经有人 resume 过了，再来一次是第二次抢占），
   * 该做的只是让界面追上事实。
   */
  | { kind: 'refresh' }
  /** 这条 session 的凭据没了，但重试有意义（Provider 可能刚装好 / Host 刚恢复）。 */
  | { kind: 'retry' }

/** 恢复失败要说清的三件事，与服务窗同形：哪一类、为什么、现在能做什么。 */
export type ContinuityFailureNotice = {
  /** 归类标题——三类必须彼此可区分，不能都是 "Resume unavailable"。 */
  title: string
  /** 为什么恢复不了，用用户的语言，不是错误码。 */
  reason: string
  /** 此刻能做的那件事。 */
  remedy: ContinuityRemedy
  /** 恢复动作按钮上的字。永远说得出"现在能做什么"，不留一个只写着"不可用"的死按钮。 */
  actionLabel: string
}

/**
 * 把一次恢复失败分类。
 *
 * 两个 switch **都没有 default**——与服务窗分类层同一条理由：Core 日后新增一个原因时，
 * 这里少一个分支必须**编译不过**，而不是安静地折进某一类通用文案。把未知原因显示成
 * "Provider 不支持" 会让用户去新开 Agent，而真相可能只是 Host 掉线了。
 */
export function classifyContinuityFailure(
  continuity: 'unavailable' | 'conflict' | undefined,
  reason: SessionSnapshot['status']['continuityReason'],
  conflict?: SessionSnapshot['status']['continuityConflict']
): ContinuityFailureNotice | null {
  if (!continuity) return null

  if (continuity === 'conflict') {
    // conflict 也没给类别：如实说分不清，别挑一类当默认——两类的动作相反，挑错一半的人被误导。
    // 标题必须**明显不同于** lifecycle-busy 那条：两者措辞一旦接近，就等于用同一句话要求两件相反的事，
    // 那正是这一层要消灭的形状。所以这里说"不知道是谁"，那里说"另一个操作正在用"。
    if (!conflict) {
      return {
        title: 'Cannot tell what claimed this Agent',
        reason: 'Something else claimed this Agent Session, so the stale Run was not resumed. Core did not report which kind of claim it was.',
        remedy: { kind: 'refresh' },
        actionLabel: 'Re-read this Agent'
      }
    }
    switch (conflict) {
      case 'session-run-changed':
        // 「等」在这里是错建议：这条 session 已经在一个更新的 Run 上，被替换掉的那条等不回来。
        return {
          title: 'This Agent already moved to a newer Run',
          reason: 'Something else resumed this Agent Session, so the Run this view held is stale. The Agent itself is alive — this view just needs to catch up.',
          remedy: { kind: 'refresh' },
          actionLabel: 'Re-read this Agent'
        }
      case 'lifecycle-busy':
        // 这一类才是真的「等」：另一个生命周期操作此刻持有它，短暂。
        return {
          title: 'Another operation is using this Agent',
          reason: 'A lifecycle operation holds this Agent Session right now, so no new Run was started. It will be free once that finishes.',
          remedy: { kind: 'wait' },
          actionLabel: 'Waiting for that operation'
        }
    }
  }

  // unavailable 但 Core 没给原因：这是"分不清"，如实说分不清，绝不挑一类当默认。
  if (!reason) {
    return {
      title: 'Agent resume unavailable',
      reason: 'Core did not report why this Agent Session could not be resumed.',
      remedy: { kind: 'retry' },
      actionLabel: 'Try resuming again'
    }
  }

  switch (reason) {
    case 'provider-resume-unsupported':
      return {
        title: 'This Provider cannot resume sessions',
        reason: 'This Provider has no native resume, so no Agent of this kind can be restored — nothing was lost by this session in particular.',
        remedy: { kind: 'start-new' },
        actionLabel: 'Start a new Agent'
      }
    case 'native-handle-unavailable':
      return {
        title: 'No resume token for this Agent',
        reason: 'This Agent Session never recorded a verified Provider handle, so there is nothing to resume from. Other Agents are unaffected.',
        remedy: { kind: 'start-new' },
        actionLabel: 'Start a new Agent'
      }
    case 'provider-unavailable':
      return {
        title: 'Provider unavailable on this Host',
        reason: 'The Provider executable or its resume capability is missing here. The Agent Session is intact and can resume once the Provider is back.',
        remedy: { kind: 'retry' },
        actionLabel: 'Try resuming again'
      }
    case 'unknown-session':
      return {
        title: 'Agent Session no longer known',
        reason: 'Core has no current or retired binding for this Agent Session.',
        remedy: { kind: 'start-new' },
        actionLabel: 'Start a new Agent'
      }
  }
}

/**
 * 恢复按钮此刻能不能按。
 *
 * 只有 `retry` 可按——`start-new` 与 `wait` 按了也不会成功，而一个按下去必然失败的按钮比禁用
 * 更糟：它承诺了一件做不到的事。禁用态的 title 由 notice.reason 承载，不是空着。
 *
 * `refresh` **不**从这里出：它可按，但按下去要走的是另一条通路（重读快照而不是再 resume 一次），
 * 所以由 `continuityRefreshEnabled` 单独判。用同一个判据会让 refresh 那一类去调 resume——那正是
 * 第二次抢占，比不给按钮更糟。
 */
export function continuityRetryEnabled(notice: ContinuityFailureNotice | null): boolean {
  return notice?.remedy.kind === 'retry'
}

/**
 * 这条通知该不该给一个「重读」按钮，而不是「重试恢复」。
 *
 * 两个判据必须互斥：一次通知只能落在一个动作上，否则界面同时给两个按钮，用户又回到
 * 「不知道该按哪个」——那正是这一层要消灭的东西。这条互斥由测试钉住。
 */
export function continuityRefreshEnabled(notice: ContinuityFailureNotice | null): boolean {
  return notice?.remedy.kind === 'refresh'
}
