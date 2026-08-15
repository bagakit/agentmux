/**
 * Agent prompt 的预算：一个字节上限，以及由它推出的两个行数上限。
 *
 * **本模块不许有任何 import。** 这是它存在的第一个理由：字节上限此前住在
 * `agent-terminal-screen.ts`，而那个模块 `import '@xterm/headless'`，又没有挂在
 * package.json 任何 subpath exports 上。于是 renderer 够不着这个数——它只经 subpath 取值，
 * 而把整个屏幕模块挂上去会把 @xterm/headless 拖进 renderer 的构建图。结果是 renderer 侧
 * 入队时**完全不检查大小**，一条超大 prompt 能一路排到 core 才被永久拒绝，卡死整条队列。
 * 想修那个缺陷，唯一不手抄数字的办法就是把预算搬进一个无依赖的模块。
 *
 * 第二个理由是单位。此前只有一个常量 `MAX_AGENT_PROMPT_BYTES`，四个用处里两个当**行数**用
 * （xterm 的 scrollback、composerText 的回扫上界），两个当**字节**用。名字断言 BYTES，一半用处
 * 不是字节。谁按名字去调"prompt 的字节预算"，会顺手改掉两处行数语义，而且不会有任何测试变红
 * ——那两处的行为差异被真实 buffer 尺寸吸收了。这正是本仓记过的
 * [counting-a-symbol-misses-other-spellings] 一族：一个符号承担两种含义时，改它的人只会想到
 * 其中一种。
 *
 * 拆开之后的关键是：**行数不是另取一个数，是从字节数推出来的**，而且推导是紧的。见下。
 */

/**
 * 一条 Agent prompt 的字节上限。超过即 `INVALID_AGENT_PROMPT`，永久拒绝。
 *
 * 判这条界请用 {@link agentPromptExceedsBudget}，不要自己数字节：按**字节**还是按 `.length`
 * 判，对 ASCII 完全等价，只在多字节输入上分岔——那正是没人会顺手测到的那一侧。
 */
export const MAX_AGENT_PROMPT_BYTES = 64 * 1024

/**
 * composerText() 从光标往回找 composer 标记时，最多回扫多少**行**。
 *
 * 为什么等于字节上限，且这不是巧合：**一个字节最多产生一行**。最坏情况是整条 prompt 全是
 * 换行符——64KB 个 `\n` 就是 65536 行。任何其他内容都只会更少（普通字符要凑满 cols 才折行）。
 * 所以「字节上限」正是「行数上限」的紧确界，两者数值相同是推导出来的，不是抄过来的。
 *
 * 这条推导以前从没写下来过，于是那行 `cursorLine - MAX_AGENT_PROMPT_BYTES - 1` 看起来像
 * 单位写错了。它的值一直是对的，错的是没人能从名字看出为什么对。
 *
 * 注意这是**上界**不是常态：扫描找到标记就返回，正常情况下标记就在光标附近，几行就命中。
 * 只有标记不在场时才会真的扫到底——而那恰好是 readiness 等待期间的常态（composer 还没画出来），
 * 实测在满 buffer 下单次约 39ms。这个代价是否值得优化是另一个问题，不在本模块的职责内：
 * 这里只负责把界说清楚，收窄它需要各自的证据。
 */
export const AGENT_COMPOSER_SCAN_BACK_ROWS = MAX_AGENT_PROMPT_BYTES

/**
 * 影子屏保留多少**行**滚动历史。
 *
 * 必须不小于 {@link AGENT_COMPOSER_SCAN_BACK_ROWS}：回扫能看多远，取决于 buffer 里还留着多少行。
 * 保留得比回扫界少，回扫的上界就是假的——真正的界会变成 scrollback，而那件事没有任何注释说明，
 * 属于[两个预算守同一件事]的形状。两者同源于此，改一处不会留下另一处的孤儿。
 *
 * xterm 的 scrollback 单位是行，其 typings 原话："the amount of **rows** that are retained
 * when lines are scrolled beyond the initial viewport."
 */
export const AGENT_SCREEN_SCROLLBACK_ROWS = AGENT_COMPOSER_SCAN_BACK_ROWS

const ENCODER = new TextEncoder()

/**
 * 这条 prompt 是否超出字节预算。
 *
 * 判据和常量必须一起住在这里，否则拆出来的只是个数字：光导出 `MAX_AGENT_PROMPT_BYTES`，
 * 每个调用方还要自己写一遍「怎么算字节」，而那一步恰恰是错得最安静的一步——把
 * `Buffer.byteLength(p)` 写成 `p.length`，对纯 ASCII 完全等价，只有多字节输入才分岔。
 * 本仓记过这一族（[counting-a-symbol-misses-other-spellings]）：常量只有一份，算法有 N 份。
 *
 * 用 `TextEncoder` 而不是 `Buffer.byteLength`，是因为 renderer 里没有 `Buffer`——沙箱化的
 * renderer 拿不到 Node 全局。而 renderer 正是最需要这个判据的一侧：它入队前不检查大小，
 * 一条超大 prompt 能一路排到 core 才被永久拒绝。两侧要判同一件事，就只能用两侧都有的 API。
 * 两者对孤立代理对的处理一致（都替换成 U+FFFD），不存在边界分歧。
 */
export function agentPromptExceedsBudget(prompt: string): boolean {
  return ENCODER.encode(prompt).length > MAX_AGENT_PROMPT_BYTES
}
