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
    description: `The checkout at this location goes away. Branch ${request.branch} itself is untouched and stays available.`,
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
  'git-failed': (count) => `Git refused to remove ${count} worktree(s); nothing was discarded`,
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
 * 把批量收尾的结果整理成分档告知。
 *
 * 顺序固定为「脏树 → git 失败 → 记录未撤下」，即由「用户可以处理」到「需要有人来看一眼」：最后那档是
 * 唯一一个磁盘与记录已经不一致的状态，放在末尾是为了它最后被读到、也最靠近用户的下一步。
 * 顺序写死在这里而不是跟着 outcomes 的到达次序，是因为「先说哪句」也是判断。
 */
export function retainedLaneNotices(
  outcomes: readonly { status: string; workspaceId: string; retention?: WorktreeRetention; reason?: string }[]
): RetainedLaneNotice[] {
  const order: WorktreeRetention[] = ['uncommitted-changes', 'git-failed', 'record-not-withdrawn']
  const notices: RetainedLaneNotice[] = []
  for (const retention of order) {
    const lanes = outcomes.filter(
      (outcome) => outcome.status === 'retained' && outcome.retention === retention
    )
    if (lanes.length === 0) continue
    // git 的原话原样带上。压平成我们自己的说法会丢掉用户真正需要的那部分（是哪个文件、什么权限）。
    const reasons = lanes.map((lane) => lane.reason ?? '').filter(Boolean).join('; ')
    notices.push({
      retention,
      workspaceIds: lanes.map((lane) => lane.workspaceId),
      message: `${RETENTION_HEADLINE[retention](lanes.length)}: ${reasons}`
    })
  }
  return notices
}
