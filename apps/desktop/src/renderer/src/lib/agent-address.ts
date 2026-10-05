/** Desktop shares Core object links and uses Core commands for error recovery. */
import {
  agentSessionSendCommand,
  AMUX_AGENT_LIST_COMMAND as LIST_SESSIONS
} from '@agentmux/core/sharing'
export {
  formatSessionAddress,
  formatRegionAddress,
  formatTabAddress
} from '@agentmux/core/sharing'

/**
 * 寻址失败时的下一步。
 *
 * 失败不是终点，是一个要说清楚"现在怎么办"的时刻。`MESSAGE_TARGET_NOT_UNIQUE` 已经带
 * `candidates`，但一份候选清单仍然要求接收方自己拼出命令——那正是"歧义不甩给接收方"这条原则
 * 在错误路径上的漏洞。所以这里每出现一行命令，它就必须真能跑。
 *
 * 反过来也成立：**没有可跑的命令时就不写命令**。恢复层只拿得到错误码，拿不到 tabId、regionId
 * （抛出点没带过来），而 View / Region id 本就是界面上的临时身份，CLI 无从重建。此时凑一条
 * 命令形状的文字比不给更糟——它看起来像出路，粘贴过去只会撞 INVALID_CLI_ARGUMENT，把人引向
 * 第二次失败。这种分支给界面里的下一步，外加一条真能跑的旁路（按 Session 身份寻址）。
 *
 * 恢复命令来自 Core 的公共命令 formatter，不在 Desktop 重新拼接。
 *
 * 入参是**未收窄的错误码**、返回 `string | null`，这是有意的：哪些码算"寻址失败"由本模块说了
 * 算。调用方（控制响应边界）拿到任何码都往这里问一次，不在边界处再列一份码表——两份码表一定会
 * 漂移，而漂移的那天没有测试会红。
 */
export function addressingRecovery(error: {
  code: string
  // `regionIds` 是非空元组：候选只从边界校验器出来，那里已经证明了每个候选至少有一格
  // （见 control-api.ts 的 ValidatedCandidate）。这里跟着收窄，下游就不必为一个到不了的
  // 情况留分支——留了也没有调用者，只会被读、被维护、被测试假装覆盖。
  candidates?: readonly { agentSessionId: string; regionIds: readonly [string, ...string[]] }[]
}): string | null {
  if (error.code === 'MESSAGE_TARGET_NOT_UNIQUE') {
    return formatTargetNotUnique(error.candidates ?? [])
  }
  if (error.code === 'MESSAGE_TARGET_NOT_AGENT') {
    // 这里**故意不给命令**。想给的那条是 `amux space inspect --region=<regionId>`——这个码只在
    // Region 分支抛（store.ts 里 `region.kind !== 'agent'` 那一处，全仓仅此一处），所以丢掉的是
    // regionId 而不是 tabId。但抛出点只带 code 与 message 过来，恢复层拿不到它。凑一条跑不了的
    // 命令比不给更糟：它看起来像出路，粘贴过去却只会撞 INVALID_CLI_ARGUMENT，把人引向第二次失败。
    return `这一格不是 Agent（是终端、浏览器或文件）。
在承载 Agent 的那一格上右键重取地址；或按语义身份寻址：
${LIST_SESSIONS}`
  }
  if (error.code === 'UNKNOWN_AGENT_SESSION') {
    return `当前未观察到这个 Agent Session，不能据此确认它已退出或被回收。
列出当前可观察的 Agent Session：
${LIST_SESSIONS}`
  }
  if (error.code === 'TAB_NOT_OPEN' || error.code === 'REGION_NOT_OPEN') {
    // View / Region id 是界面上的临时身份，关掉就没了，CLI 无从重建——所以"重新取一次"只能在
    // 界面里做，这一句没有对应命令。能给的是另一条路：Session 跨 View 稳定，用它照样够得到。
    return `当前没有打开这个 Tab 或 Region；这不代表其中的 Agent Session 已结束。
要找那个空间位置，重新取得准确地址；要联系同一个 Agent，使用跨 Tab 稳定的 Session 身份：
${LIST_SESSIONS}`
  }
  if (error.code === 'AMBIGUOUS_REGION_TARGET' || error.code === 'AMBIGUOUS_TAB_TARGET') {
    // 这**不是**"粘来的地址匹配到多个"，意思是"发起方自己同时显示在多处"。但两个码的抛出面
    // **不对称**，别把它们当同一件事：
    //   - `AMBIGUOUS_TAB_TARGET` 只有一处，在 `resolveWorkbenchControlTab` 里，`target.kind === 'tab'`
    //     提前 return 之后——所以它确实只从 self 来。
    //   - `AMBIGUOUS_REGION_TARGET` 有**两处**：`resolveWorkbenchControlRegion` 的 self 分支之内，
    //     以及**显式 id 那条路**（"Region target is ambiguous."，在 `REGION_NOT_OPEN` 之后）。
    // 曾经这段注释写的是"两个码都只从 self 分支抛"，并据此说显式 id 走不到这里。前半句对 TAB 成立、
    // 对 REGION 是假的：那一处真实存在且**已被现有测试执行过**——view-focus.test.ts 的
    // "resolves Launcher destinations through the open-only unique Region owner" 喂两张各持
    // 'duplicate-launcher' 的开着的 Tab，拿到的就是这个码。
    //
    // 它今天不可达靠的是**另一个**前提：没有任何生产路径能让一个 regionId 同时留在两张开着的 Tab 的
    // `regions` 表里。两种铸造拼法（`region:${crypto.randomUUID()}` 与 `initialWorkbenchRegionId` 的
    // `region:${tabId}`，而 tabId 自己也带 uuid）都全局唯一；唯一刻意复用 id 的 `promoteRegionToTab`
    // 由 `removeWorkbenchRegion` 从源 Tab 上 `delete` 掉那一格，源只剩一格时它整条不做（返回
    // unchanged）。这个前提被 promote 那条守卫钉着——见 agent-address.test.ts 里"唯一刻意复用
    // regionId 的路径"那条，它按"跨 Tab 持有计数恰好为 1"判，与那处 `matches.length !== 1` 同形。
    //
    // 所以下一步不是"再挑一个候选"，而是**别再用 self**：self 依赖"我在哪"，而发起方此刻
    // 在多处，这个前提本身就塌了。改用与"在哪"无关的 Session 身份。
    //
    // 若哪天真有路径造出跨 Tab 的重号，下面这句就会对那条路径说谎（用户粘的是显式 id，不是 self）。
    // 那时该做的是把 REGION 的两处分成两个码，而不是把这段文案改得两边都含糊。
    return `相对寻址（self）失败：发起方自己同时显示在多个位置，"我这一格"指向不唯一。
改用与位置无关的 Session 身份，先列出活着的 Agent：
${LIST_SESSIONS}`
  }
  if (error.code === 'CALLER_NOT_OPEN') {
    // 同样是 `self` 失败，只是方向相反：上面是"在多处"，这里是"一处都不在"。这个码两处抛出点
    // （Region 解析与 Tab 解析各一处）都在 self 分支之内，不像 AMBIGUOUS_REGION_TARGET 那样另有
    // 一条显式 id 的路——所以对它，"只从 self 来"是真的。
    // 两者前提相同——self 要求发起方恰好显示在一处——所以下一步也相同：换成绝对身份。
    return `相对寻址（self）失败：发起方自己没有显示在任何一格里，"我这一格"无从算起。
改用与位置无关的 Session 身份，先列出活着的 Agent：
${LIST_SESSIONS}`
  }
  // 不是寻址失败。别硬编一句放之四海的"再试一次"——那种话等于没说，还会盖住真正的原因。
  return null
}

function formatTargetNotUnique(
  // `[string, ...string[]]`：每个候选**至少**有一格。这不是防御性收窄，是把上游已经成立的事实
  // 写进类型——生产者只在遇到一格 Agent 时才建候选（lib/control.ts），边界校验又直接拒掉
  // `regionIds` 为空的候选（control-api.ts）。写成 `string[]` 就得在这里处理一个到不了的情况，
  // 那段代码没有调用者、不会被执行，却要一直被读、被维护、被测试假装覆盖。
  candidates: readonly { agentSessionId: string; regionIds: readonly [string, ...string[]] }[]
): string {
  // 候选为空是"这张 View 里一个 Agent 都没有"，与"有多个"是不同的下一步。
  if (candidates.length === 0) {
    return `这张 Tab 里没有 Agent，没有可交接的目标。
先在这张 Tab 里启动一个 Agent，或改为在承载 Agent 的那一格上操作。`
  }
  // 语义收件人已经确定；不为发送猜第一个空间投影。
  const lines = candidates.map((candidate) => agentSessionSendCommand(candidate.agentSessionId))
  return `这张 Tab 承载多个不同的 Agent Session，--to-tab 无法唯一指定收件人。选择一个 Agent：

${lines.join('\n')}`
}
