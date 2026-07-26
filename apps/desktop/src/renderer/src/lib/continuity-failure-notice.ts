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
  /** 东西还在，只是被别的操作占着——等它结束。 */
  | { kind: 'wait' }
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
 * `reason` 的 switch **没有 default**——与服务窗分类层同一条理由：Core 日后新增一个原因时，
 * 这里少一个分支必须**编译不过**，而不是安静地折进某一类通用文案。把未知原因显示成
 * "Provider 不支持" 会让用户去新开 Agent，而真相可能只是 Host 掉线了。
 */
export function classifyContinuityFailure(
  continuity: 'unavailable' | 'conflict' | undefined,
  reason: SessionSnapshot['status']['continuityReason']
): ContinuityFailureNotice | null {
  if (!continuity) return null

  if (continuity === 'conflict') {
    return {
      title: 'This Agent is owned by another operation',
      reason: 'Something else claimed this Agent Session, so the stale Run was not resumed.',
      remedy: { kind: 'wait' },
      actionLabel: 'Resolve conflict first'
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
 */
export function continuityRetryEnabled(notice: ContinuityFailureNotice | null): boolean {
  return notice?.remedy.kind === 'retry'
}
