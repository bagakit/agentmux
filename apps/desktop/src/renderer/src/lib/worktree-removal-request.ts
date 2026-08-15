// 单条 worktree 移除的那次「先问再删」。
//
// 为什么把它抽成纯函数而不是写在面板里：这条路上有两次决定，而两次的措辞必须不一样。
// 第一次是普通确认（这是一次删除动作，问一句）；第二次是 git 已经说了「这里有未提交的改动」之后
// 的重问，此时用户要看到的是**git 自己的话**，而不是同一句「确定要删吗」再来一遍。本仓的教训是
// 措辞近似会吃掉分类：两次问句长得一样，用户就分不出第二次问的是另一件事，于是「丢弃他人改动」
// 会被当成「我刚才不是已经确认过了吗」而顺手点掉。
//
// 所以这里的判据是：两个阶段的正文不许有共同实词，且第二阶段必须原样带着 git 的理由。

import type { RemoveWorktreeOutcome, WorktreeRetention } from '../../../shared/contracts'

/**
 * 移除流程的阶段。`confirm` 是还没动手，`blocked` 是 git 拒绝了并把理由带回来了。
 *
 * `retention` 跟着 `blocked` 一起走，因为「下一步该给什么」只有它能答：只有脏树那一档，「丢弃并删除」
 * 是一个真的下一步。git 挂了那档没有东西可丢弃，而记录没撤下那档目录已经不在了——对这两档还摆着
 * 「Discard uncommitted work?」是在骗人。此前这里只带一个 `reason` 字符串，于是这三种都被当成脏树问了。
 *
 * 没有 `removing` 这一态：忙碌是一个正交的布尔（面板的 busyBranch），把它编进阶段里会让
 * 「忙碌时用户在看哪一屏」变成两处各判一次。
 */
export type WorktreeRemovalStage =
  | { kind: 'confirm' }
  | { kind: 'blocked'; retention: WorktreeRetention; reason: string }

export type WorktreeRemovalRequest = {
  /** 要移除的 worktree 所属的 Workspace。 */
  workspaceId: string
  /** 分支名，只用于文案——移除 worktree 不动分支。 */
  branch: string
  /** worktree 在盘上的路径，给用户核对。 */
  path: string
  /**
   * 「这条分支会留下什么」那句话，main 侧数完独有提交之后给的（见 `lane-orphan-commits.ts`）。
   *
   * `null` 是**还没问到**（正在查，或者这次没查），不是「查了没有」。两者在屏幕上必须不同：没问到就
   * 什么都不说，而「查了查不出来」有它自己的那句话，由 main 侧的 `branchRetentionNote(branch, null)`
   * 给出——那句话会作为一个正常的 `note` 送到这里。所以这里的 `null` 只表示尚未抵达，不参与表态。
   */
  note?: string | null
  stage: WorktreeRemovalStage
}

/** 对话框要显示的那四段文字，以及确认键真正会执行的动作。 */
export type WorktreeRemovalPrompt = {
  title: string
  description: string
  subject: string
  confirmLabel: string
  /**
   * 确认键要不要带 `discardChanges`。
   *
   * 只有 `blocked` 阶段才是 true：git 说了这里有活儿，用户看过理由之后仍然选择继续。第一次确认
   * **绝不能**带它——否则脏树保护形同不存在，而用户会以为自己只是确认了一次普通删除。
   */
  discardChanges: boolean
}

/**
 * 由阶段算出该显示什么、确认键做什么。
 *
 * 两个阶段的 `description` 刻意没有共同实词：第一段讲的是「这个签出会被删掉，分支不受影响」，
 * 第二段讲的是「git 报告有未保存产出，继续就等于丢弃」。同一句话要求两件相反的事，是本仓栽过的坑。
 */
export function worktreeRemovalPrompt(request: WorktreeRemovalRequest): WorktreeRemovalPrompt {
  if (request.stage.kind === 'blocked') {
    // 这一屏**只对脏树成立**：它标题在问「要不要丢弃未提交的产出」，确认键带 `discardChanges: true`。
    // 另外两档保留（git 挂了 / 记录没撤下）根本不该走到这里——`nextAfterWorktreeRemoval` 把它们判成
    // `failed`。这里响亮地拒绝而不是悄悄换套文案：如果哪天有人让它们进来了，问题在路由上，此时弹一个
    // 「丢弃产出？」的框比抛出来危险得多——`record-not-withdrawn` 那档目录已经不在，按下去等于去删一个
    // 不存在的路径，然后把「记录撤不下来」误报成一次 git 失败。
    if (request.stage.retention !== 'uncommitted-changes') {
      throw new Error(
        `worktreeRemovalPrompt: the discard prompt is only valid for uncommitted work, got ${request.stage.retention}`
      )
    }
    return {
      title: 'Discard uncommitted work?',
      // git 的原话原样带出来。压平成我们自己的说法会丢掉用户真正需要的那部分——是哪个文件、
      // 是暂存了还是未跟踪。
      description: `Git refused: ${request.stage.reason}`,
      subject: request.path,
      confirmLabel: 'Discard and Remove',
      discardChanges: true
    }
  }
  return {
    title: 'Remove worktree?',
    // 那句「分支会留下什么」接在后面，而不是替换掉前半句。前半句讲的是**这次动作做了什么**（签出没了、
    // 分支不动），后半句讲的是**那条留下来的分支里有什么**——两件事，用户两件都要知道才判断得了。
    //
    // 没拿到就不说：宁可少一句，也不能因为「还没问到」而默认说一句安心话。真正查不出来的那一档有它
    // 自己的措辞（`branchRetentionNote(branch, null)`），会作为一个正常的 note 送进来。
    description:
      `The checkout at this location goes away. Branch ${request.branch} itself is untouched and stays available.` +
      (request.note ? ` ${request.note}` : ''),
    subject: request.path,
    confirmLabel: 'Remove',
    discardChanges: false
  }
}

/**
 * 一次移除尝试的结果该把流程带到哪里。
 *
 * `retained` 不一定是错误，但也不一定不是——要看是哪一档保留（见 `WorktreeRetention`）：
 *
 * - `uncommitted-changes` 是保护生效了。它既不关闭对话框、也不进全局错误条，而是把同一个请求推进到
 *   `blocked` 阶段，让用户读到 git 的理由并自己决定第二步。
 * - `git-failed` / `record-not-withdrawn` 没有第二步可给。前者没有东西可丢弃，后者目录已经不在了，
 *   两者都收场并如实报错。此前这两档也被推进到 `blocked`，于是用户会看到一个「Discard uncommitted
 *   work?」的对话框，按下去只会再失败一次——**而 `record-not-withdrawn` 那档按下去更糟**：它会去删
 *   一个已经不存在的目录，把「记录撤不下来」误报成一次 git 失败。
 *
 * 而**已经在** `blocked` 阶段又被拒绝（用户已经选了丢弃、git 还是不干）也是收场并如实报错，否则用户
 * 会在同一个对话框里无限点「Discard and Remove」。
 */
export type WorktreeRemovalNext =
  | { kind: 'done' }
  | { kind: 'ask'; request: WorktreeRemovalRequest }
  | { kind: 'failed'; reason: string }

export function nextAfterWorktreeRemoval(
  request: WorktreeRemovalRequest,
  outcome: RemoveWorktreeOutcome
): WorktreeRemovalNext {
  if (outcome.status === 'removed') return { kind: 'done' }
  if (request.stage.kind === 'blocked') return { kind: 'failed', reason: outcome.reason }
  // 只有脏树那一档能问出第二个问题。判据落在 `retention` 而不是 `reason` 的措辞上：按文本猜分类会在
  // git 换句话时静默失效，而分类本身是服务层在失败现场定的。
  if (outcome.retention !== 'uncommitted-changes') return { kind: 'failed', reason: outcome.reason }
  return {
    kind: 'ask',
    request: {
      ...request,
      stage: { kind: 'blocked', retention: outcome.retention, reason: outcome.reason }
    }
  }
}

/** 三种走向各自在屏幕上留下什么。三个字段一起看才是「用户接下来看到的那一屏」。 */
export type WorktreeRemovalEffect = {
  /** 对话框接下来显示哪个请求。`null` 是关掉它。 */
  removal: WorktreeRemovalRequest | null
  /** 要给用户读的失败原话。`null` 是没有错误可报——不是「有错误但不说」。 */
  error: string | null
  /** 要不要重扫分支列表。 */
  rescan: boolean
}

/**
 * 由走向算出那一屏。
 *
 * 为什么这三个字段必须在**纯函数**里算，而不是留在面板的 if/else 里：`renderToStaticMarkup` 不跑
 * effect，也点不了对话框的确认键，所以面板里那段分派**没有任何东西执行它**。实测过的后果是
 * `setActionError(next.reason)` 换成 `setActionError(null)` 时 21 条断言与 tsc 全绿——而那个变异的
 * 症状是：用户已经授权了丢弃、git 还是拒绝，对话框却静静关掉，什么也不说，用户以为删成功了。
 *
 * 三种走向 × 三个字段 = 九件事，逐条都能各自漂移，所以这不是把 `nextAfterWorktreeRemoval` 换个说法
 * 抄一遍。要点在于三条里**只有一条**重扫（`ask` 什么都没删，重扫会把用户正在读的那句 git 理由
 * 刷掉；`failed` 也什么都没删），也**只有一条**报错。
 */
export function worktreeRemovalEffect(next: WorktreeRemovalNext): WorktreeRemovalEffect {
  if (next.kind === 'done') {
    // 记录已经撤了，那一行的归属跟着变（从 Worktrees 组挪回 Without worktree），所以必须重扫。
    // 不重扫会留一个指向已删目录的行，点它会报一句难懂的话。
    return { removal: null, error: null, rescan: true }
  }
  if (next.kind === 'ask') {
    // 保护生效了，不是错误：不进错误条，而是把同一个请求推进到下一档让用户读 git 的理由。
    return { removal: next.request, error: null, rescan: false }
  }
  // git 的原话必须落到用户读得到的地方。用户已经授权丢弃、git 还是不干，此时唯一有用的下一步全在
  // 这句话里（权限？路径被占用？）。压成 null 就是上面说的那个变异。
  return { removal: null, error: next.reason, rescan: false }
}

/**
 * 批量收尾之后，被留下的那些 lane 该怎么跟用户说。
 *
 * 为什么措辞在这里而不在 store 里：store 那一版把三档保留折成一句硬编码的
 * 「kept because they still hold changes」，对另外两档都是假话——git 挂掉的那档没有改动可言，而
 * 记录没撤下的那档目录已经被删了，让用户去「review before discarding」是把他送去找一份不存在的产出。
 * 分档措辞是判断，判断要在能被测试质询的地方。
 *
 * 每一档的句子刻意不共用实词（本仓的教训：措辞近似会吃掉分类），并且各自只说这一档真实成立的事：
 * 前两档说目录还在，第三档**不说**目录还在，而是说清楚记录与磁盘已经不一致。
 */
const RETENTION_HEADLINE: Record<WorktreeRetention, (count: number) => string> = {
  'uncommitted-changes': (count) => `${count} worktree(s) kept because they hold uncommitted work`,
  // 不说「有未提交的改动」：git 挂掉时根本没走到那一步，说了就是把用户送去 review 一份不存在的产出。
  // 唯一对这一档成立的事是「什么都没被丢掉」。
  //
  // 也**不说动词**——不说「拒绝删除」，尽管这一档最早只有删除那一个来源。`git-failed` 现在有两个
  // 生产者，而它们做的是**相反的动作**：删那边是 git 拒绝了移除，建那边（扇出时 worktree 建好了、
  // 记录没落上）是 git **建**成了。原先那句 `Git refused to remove N worktree(s)` 套到建的那一侧，
  // 用户读到的是「拒绝删除…: 这个 worktree 已经建好了，只是没记上」——一句自相矛盾的话。
  //
  // 这一档的定义从来不是某个动词，而是**世界状态**：目录还在、什么都没被丢弃、没有可撤销的 git 动作。
  // 所以措辞只说这个状态，让 git 的原话去讲到底发生了什么（它本来就带着「created」或「remove」）。
  // 教训的第二层：复用枚举档位时核对了世界状态和过滤逻辑还不够，**消费方的措辞**也得逐个核——
  // 措辞里藏着一个没人声明过的前提。
  //
  // 另外不带否定词（"could not" 之类）：`record-not-withdrawn` 那句里有 "was not updated"，而三句话
  // **实词不许有交集**（同文件那条判据）。一个 "not" 就会让两句话开始像同一件事。
  'git-failed': (count) => `Git step incomplete for ${count} worktree(s); nothing was discarded`,
  // 唯一一句不许说「kept」「remain」的：那两个词都在暗示目录还在，而它已经被删了。
  'record-not-withdrawn': (count) =>
    `${count} worktree(s) were deleted, but the workspace list was not updated`
}

/**
 * 一档保留：这一档有哪些 lane、给用户看哪句话。
 *
 * 按档分组而不是拼成一条长句，是因为一次批量收尾里三档可以同时出现，而它们要求用户做的事完全不同。
 */
export type RetainedLaneNotice = {
  retention: WorktreeRetention
  workspaceIds: string[]
  message: string
}

/**
 * 分档告知的顺序，只有这一份。
 *
 * 「脏树 → git 失败 → 记录未撤下」，即由「用户可以处理」到「需要有人来看一眼」：最后那档是唯一一个
 * 磁盘与记录已经不一致的状态，放在末尾是为了它最后被读到、也最靠近用户的下一步。
 *
 * 顺序写死而不是跟着 outcomes 的到达次序，是因为「先说哪句」也是判断。写在模块级而不是函数里，是因为
 * 现在有两个消费者（批量收尾、扇出的启动失败清理），而两处各排一次就会有两种读法。
 */
const RETENTION_ORDER: readonly WorktreeRetention[] = [
  'uncommitted-changes',
  'git-failed',
  'record-not-withdrawn'
]

/**
 * 按档分组，给每档配它自己那句话。
 *
 * 入参只要「这一条属于哪一档、叫什么、git 说了什么」——批量收尾按 workspaceId 认 lane，扇出按分支名认，
 * 而措辞和顺序对两者完全一样。让两处各写一遍分组，就是三档措辞当初被折成一句硬编码的那个形状，只是
 * 换了个地方复发。
 */
export function retentionNotices(
  lanes: readonly { retention: WorktreeRetention; id: string; reason: string }[]
): RetainedLaneNotice[] {
  const notices: RetainedLaneNotice[] = []
  for (const retention of RETENTION_ORDER) {
    const matching = lanes.filter((lane) => lane.retention === retention)
    if (matching.length === 0) continue
    // git 的原话原样带上。压平成我们自己的说法会丢掉用户真正需要的那部分（是哪个文件、什么权限）。
    const reasons = matching.map((lane) => lane.reason).filter(Boolean).join('; ')
    notices.push({
      retention,
      workspaceIds: matching.map((lane) => lane.id),
      message: `${RETENTION_HEADLINE[retention](matching.length)}: ${reasons}`
    })
  }
  return notices
}

/** 批量收尾的结果整理成分档告知。认 lane 的方式是 workspaceId，其余全部走 {@link retentionNotices}。 */
export function retainedLaneNotices(
  outcomes: readonly { status: string; workspaceId: string; retention?: WorktreeRetention; reason?: string }[]
): RetainedLaneNotice[] {
  return retentionNotices(
    outcomes.flatMap((outcome) =>
      outcome.status === 'retained' && outcome.retention
        ? [{ retention: outcome.retention, id: outcome.workspaceId, reason: outcome.reason ?? '' }]
        : []
    )
  )
}

/**
 * 分档告知折成能上屏的**一句**，没有可说的就是 `null`。
 *
 * 为什么必须折成一句：store 的错误面是一个槽（`reportError` 就是 `set({ error })`），后一次调用
 * 直接覆盖前一次。于是「循环里逐条 reportError」在屏幕上只剩最后一条——三档同时出现时前两档静默消失，
 * 而按 {@link RETENTION_ORDER} 排在第一位的脏树恰好是唯一有真实下一步可做的那一档，被擦掉的总是它。
 * 在扇出那边更糟：保留告知会盖掉「哪几条 lane 没起来、为什么」那句主信息。
 *
 * 分组数组作为**数据**是对的（每档要用户做的事不同），能上屏的只有一句，所以折叠——连分隔符——只在
 * 这里决定一次。两个调用点各写一遍 join 就会有两种读法。
 *
 * `null` 而不是空串：空串在 `reportError` 那边会变成一条什么都没写的错误弹出来。
 */
function collapse(notices: readonly RetainedLaneNotice[]): string | null {
  if (notices.length === 0) return null
  return notices.map((notice) => notice.message).join(' — ')
}

/** 扇出清理的分档告知，折成一句。认 lane 的方式是分支名。 */
export function retentionReport(
  lanes: readonly { retention: WorktreeRetention; id: string; reason: string }[]
): string | null {
  return collapse(retentionNotices(lanes))
}

/** 批量收尾的分档告知，折成一句。认 lane 的方式是 workspaceId。 */
export function retainedLaneReport(
  outcomes: readonly { status: string; workspaceId: string; retention?: WorktreeRetention; reason?: string }[]
): string | null {
  return collapse(retainedLaneNotices(outcomes))
}
