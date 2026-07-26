/**
 * 地址的唯一出处。
 *
 * 复制一个 id 和复制一个**寻址方式**是两件事。裸 id 把工作留给了接收方：它得先猜出这是哪一层
 * 身份，再去想该配哪个 flag，最后才谈得上寻址——而那正是这次复制本该省掉的一步。所以这里产出的
 * 每一段文本都自带命令，接收方粘贴即可执行。
 *
 * 三级地址回答三个不同的问题，绝不互为别名：
 *   - Session 回答"哪个 Agent"，跨 View 稳定，可同时投影到多个 Region 与多个 Tab；
 *   - Region 回答"屏幕上哪一格"，是分屏下唯一无歧义的展示身份；
 *   - View 回答"哪张完整工作面"，只在它恰好承载唯一一个 Agent 时才谈得上 Agent 寻址。
 *
 * 三个入口共用这里，不各自拼字符串——同一个 Session 从 Tab 菜单和从 Region 菜单复制出来必须
 * 逐字一致，那是同一份真相的两个入口，不是两套格式。
 */

/** 按 shell 语义转义，使带空格或单引号的 id 粘贴即可执行。 */
function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/**
 * 寻址命令的唯一出处。
 *
 * 三级地址与失败恢复都从这里取命令文本，谁都不自己拼。这不是为了少写几行——复制出去的地址和
 * 失败时给出的下一步必须**逐字一致**，否则接收方会看到同一件事的两种写法；而两处拼接一定会各自
 * 演进，漂移的那天不会有任何测试变红。改这里的格式，复制与恢复两侧的断言必须同时红。
 *
 * flag 只用已被 CLI 与 Control 面接受的那套（`--to-session` / `--to-region` / `--to-tab` 及
 * `inspect` 的对应 flag），不为任何新入口发明第二套语法。
 */
const ADDRESS_FLAGS = {
  session: { send: '--to-session', inspect: '--session' },
  region: { send: '--to-region', inspect: '--region' },
  tab: { send: '--to-tab', inspect: '--tab' }
} as const

type AddressKind = keyof typeof ADDRESS_FLAGS

/** 发消息给这个地址的命令。 */
function sendCommand(kind: AddressKind, id: string): string {
  return `agentmux send ${ADDRESS_FLAGS[kind].send}=${shellArgument(id)} --text "..."`
}

/** 查看这个地址的命令。 */
function inspectCommand(kind: AddressKind, id: string): string {
  return `agentmux inspect ${ADDRESS_FLAGS[kind].inspect}=${shellArgument(id)}`
}

/**
 * 列出还活着的 Agent Session。
 *
 * 是 `list sessions` 不是 `list agents`：后者列的是配好的 executor 类型（codex / claude / …），
 * 不是此刻活着的 Session——名字像，答非所问。
 */
const LIST_SESSIONS = 'agentmux list sessions'

/**
 * 哪个 Agent。
 *
 * Session 是 Provider 语义身份，与它此刻显示在哪张 View 的哪一格无关，因此这是唯一一个
 * 在 View 被关掉、被移动、被分屏之后依然指向同一个 Agent 的地址。
 */
export function formatSessionAddress(agentSessionId: string): string {
  return `AgentMux Agent Session ${agentSessionId}

这是 Agent 的语义身份，与它显示在哪张 View、哪一格无关。

发消息给它：
${sendCommand('session', agentSessionId)}

查看它：
${inspectCommand('session', agentSessionId)}`
}

/**
 * 屏幕上哪一格。
 *
 * 一张 View 分屏承载多个 Agent 时，View 地址本身是歧义的，而 Region 地址不是。歧义只在源头
 * 可见——复制发生时我们知道用户点的是哪一格，接收方不知道——所以此时就该给出 Region 地址，
 * 而不是让接收方自己去 inspect 消歧。
 */
export function formatRegionAddress(regionId: string): string {
  return `AgentMux Region ${regionId}

这是 View 里的一格。分屏承载多个 Agent 时，它 unambiguous 地指向这一格，View 地址做不到。

发消息给这一格里的 Agent：
${sendCommand('region', regionId)}

查看这一格：
${inspectCommand('region', regionId)}`
}

/**
 * 哪张完整工作面。
 *
 * 它如实声明自己的前提：只有当这张 View 恰好承载一个 Agent 时，它才谈得上 Agent 寻址。
 * 多 Agent 时引导去用 Region 地址——而不是像旧 handoff 那样，让接收方先撞一次
 * MESSAGE_TARGET_NOT_UNIQUE 再自己从 candidates 里挑。
 */
export function formatViewAddress(tabId: string): string {
  return `AgentMux View ${tabId}

这是一张完整工作面。它用于 Agent 寻址的前提是：这张 View 里 exactly one Agent。
这张 View 分屏承载多个 Agent 时，改用那一格的 Region 地址——在那一格上右键复制。

发消息给它（前提如上）：
${sendCommand('tab', tabId)}

查看它（列出它的每一格）：
${inspectCommand('tab', tabId)}`
}

/**
 * 交接入口解析出的最精确地址。
 *
 * 入口按意图命名（"给这个 Agent 发消息"），因此这里要替用户决定该给哪一层身份——用户想的是把这个
 * Agent 交出去，不是"我要 Region 还是 Session"。解析只有一条规则：**调用方知道是哪一格就给 Region
 * 地址，不知道就给 Session 地址**。
 *
 * 判据是`调用方知不知道`，不是`有没有分屏`：歧义只在源头可见。Region 菜单的点击天然发生在某一格上，
 * 它知道是哪一格而接收方不知道，此时给 Region 才是把消歧做在源头——哪怕这张 View 眼下没分屏，下一秒
 * 分屏了这个地址依然指得准。Tab 菜单没有这个信息，于是落到 Session：它在 View 被关掉、移动、分屏之后
 * 依然指向同一个 Agent。
 */
export function formatHandoffAddress(target: {
  agentSessionId: string
  regionId?: string
}): string {
  return target.regionId === undefined
    ? formatSessionAddress(target.agentSessionId)
    : formatRegionAddress(target.regionId)
}

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
 * 命令来自上面那三个地址出口，不另写一份拼接：两份拼接会各自演进，漂移时不会有测试变红。
 *
 * 入参是**未收窄的错误码**、返回 `string | null`，这是有意的：哪些码算"寻址失败"由本模块说了
 * 算。调用方（控制响应边界）拿到任何码都往这里问一次，不在边界处再列一份码表——两份码表一定会
 * 漂移，而漂移的那天没有测试会红。
 */
export function addressingRecovery(error: {
  code: string
  candidates?: readonly { agentSessionId: string; regionIds: readonly string[] }[]
}): string | null {
  if (error.code === 'MESSAGE_TARGET_NOT_UNIQUE') {
    return formatTargetNotUnique(error.candidates ?? [])
  }
  if (error.code === 'MESSAGE_TARGET_NOT_AGENT') {
    // 这里**故意不给命令**。想给的那条是 `agentmux inspect --tab=<tabId>`，但 tabId 在抛出点
    // 就被丢掉了（store.ts 只带 code 与 message 过来），恢复层拿不到。凑一条跑不了的命令比不给
    // 更糟：它看起来像出路，粘贴过去却只会撞 INVALID_CLI_ARGUMENT，把人引向第二次失败。
    return `这一格不是 Agent（是终端、浏览器或文件）。
在承载 Agent 的那一格上右键重取地址；或按语义身份寻址：
${LIST_SESSIONS}`
  }
  if (error.code === 'UNKNOWN_AGENT_SESSION') {
    return `这个 Agent 已经不在了（已退出或已被回收）。
列出还活着的 Agent：
${LIST_SESSIONS}`
  }
  if (error.code === 'TAB_NOT_OPEN' || error.code === 'REGION_NOT_OPEN') {
    // View / Region id 是界面上的临时身份，关掉就没了，CLI 无从重建——所以"重新取一次"只能在
    // 界面里做，这一句没有对应命令。能给的是另一条路：Session 跨 View 稳定，用它照样够得到。
    return `这个地址指向的 View 或 Region 已经不存在了（被关掉或重新分屏过）。
要回到那个位置，在界面里重新取一次地址；要够到同一个 Agent，用它跨 View 稳定的 Session 身份：
${LIST_SESSIONS}`
  }
  // 不是寻址失败。别硬编一句放之四海的"再试一次"——那种话等于没说，还会盖住真正的原因。
  return null
}

function formatTargetNotUnique(
  candidates: readonly { agentSessionId: string; regionIds: readonly string[] }[]
): string {
  // 每个候选都给一条能直接跑的命令：有 Region 就用 Region（分屏下唯一无歧义的那一格），
  // 否则退到 Session。候选为空是"这张 View 里一个 Agent 都没有"，与"有多个"是不同的下一步。
  if (candidates.length === 0) {
    return `这张 View 里没有 Agent，没有可交接的目标。
先在这张 View 里启动一个 Agent，或改为在承载 Agent 的那一格上操作。`
  }
  const lines = candidates.map((candidate) => {
    const region = candidate.regionIds[0]
    return region === undefined
      ? sendCommand('session', candidate.agentSessionId)
      : sendCommand('region', region)
  })
  return `这张 View 承载多个 Agent，--to-tab 无法唯一寻址。挑一个直接跑：

${lines.join('\n')}`
}
