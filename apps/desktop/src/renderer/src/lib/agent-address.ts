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
 * 哪个 Agent。
 *
 * Session 是 Provider 语义身份，与它此刻显示在哪张 View 的哪一格无关，因此这是唯一一个
 * 在 View 被关掉、被移动、被分屏之后依然指向同一个 Agent 的地址。
 */
export function formatSessionAddress(agentSessionId: string): string {
  const id = shellArgument(agentSessionId)
  return `AgentMux Agent Session ${agentSessionId}

这是 Agent 的语义身份，与它显示在哪张 View、哪一格无关。

发消息给它：
agentmux send --to-session=${id} --text "..."

查看它：
agentmux inspect --session=${id}`
}

/**
 * 屏幕上哪一格。
 *
 * 一张 View 分屏承载多个 Agent 时，View 地址本身是歧义的，而 Region 地址不是。歧义只在源头
 * 可见——复制发生时我们知道用户点的是哪一格，接收方不知道——所以此时就该给出 Region 地址，
 * 而不是让接收方自己去 inspect 消歧。
 */
export function formatRegionAddress(regionId: string): string {
  const id = shellArgument(regionId)
  return `AgentMux Region ${regionId}

这是 View 里的一格。分屏承载多个 Agent 时，它 unambiguous 地指向这一格，View 地址做不到。

发消息给这一格里的 Agent：
agentmux send --to-region=${id} --text "..."

查看这一格：
agentmux inspect --region=${id}`
}

/**
 * 哪张完整工作面。
 *
 * 它如实声明自己的前提：只有当这张 View 恰好承载一个 Agent 时，它才谈得上 Agent 寻址。
 * 多 Agent 时引导去用 Region 地址——而不是像旧 handoff 那样，让接收方先撞一次
 * MESSAGE_TARGET_NOT_UNIQUE 再自己从 candidates 里挑。
 */
export function formatViewAddress(tabId: string): string {
  const id = shellArgument(tabId)
  return `AgentMux View ${tabId}

这是一张完整工作面。它用于 Agent 寻址的前提是：这张 View 里 exactly one Agent。
这张 View 分屏承载多个 Agent 时，改用那一格的 Region 地址——在那一格上右键复制。

发消息给它（前提如上）：
agentmux send --to-tab=${id} --text "..."

查看它（列出它的每一格）：
agentmux inspect --tab=${id}`
}
