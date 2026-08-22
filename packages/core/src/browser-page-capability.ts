/**
 * Browser 页面能力清单——**唯一事实来源**。
 *
 * ## 为什么这份清单住在 core 而不是 Desktop
 *
 * 「Agent 能调哪些页面能力」此前有三份互不相干的答案：真正注入子进程的那份
 * （`browser-script-runner.ts` 的数组）、人工接管后要拒绝的动作子集
 * （`browser-view-manager.ts` 的第二个数组）、以及 Skill 里手写的散文
 * （`agentmux-cli-help.ts`）。三份分属两个包、不在同一条构建图上，**tsc 一个都守不到**
 * ——Skill 那份是字符串，另两份互相之间没有类型关系。新增一个能力时忘改其中任何一份，
 * 都不会有东西变红：Skill 漂了 Agent 永远不知道那个能力存在，动作子集漂了它在人工接管
 * 之后照样能改页面。
 *
 * 放 core 是因为需要它的两侧都能 import 它，而反过来不成立：core 不得依赖 Desktop
 * （AGENTS.md 目标 1）。Desktop 依赖 core 已经是既有方向（26 处 `from '@agentmux/core'`），
 * 所以清单进 core 是唯一不制造反向依赖的位置。
 *
 * ## 这不是协议表面
 *
 * **这些名字不是 Control 协议的操作，这条边界是承重的。** 它们不进
 * `AgentMuxControlRequest` 联合、不进 `OPERATION_BUDGET`、不是 CLI 的动词。协议只发一条
 * 通用的「跑这段代码」（`browser.run`），页面能力是那段代码的运行时库。
 *
 * 理由是兼容成本的归属：协议表面发出去就撤不回（AGENTS.md 不留兼容层），而页面能力还在
 * 演进——改名、改签名、加参数都该是自由的。把它们提升成协议方法，等于每加一个页面动词
 * 都做一次协议版本变更。所以这份清单**作为数据跨包流动，不作为操作进协议**。
 *
 * 它在这里是一张有类别的表，而不是一串名字：类别本身是被消费的事实（哪些在人工接管后
 * 必须拒绝），手抄那个子集正是它此前漂移的地方。
 */

/**
 * 一个页面能力对页面做什么——这是**被消费的判据**，不是给人看的分类标签。
 *
 * `act` 与其余两类的分界决定了人工接管之后拒绝谁：人拿回页面之后，改页面的一律拒绝，
 * 看页面的继续放行。放行观察不是宽容而是诚实——程序被打断之后最该做的事就是「看一眼
 * 现在页面什么样」再决定怎么报告；把 `snapshot` 也拦掉，它只能瞎猜着退出。而观察不改
 * 页面，跟人不会打架。
 *
 * `navigate` 单独成类而不并进 `act`：它确实改页面（所以接管后同样要拒），但它改的是
 * 「在哪一页」而不是页面里的某个元素，对 Agent 的意义不同，Skill 里也分开教。
 */
export type BrowserPageCapabilityEffect =
  /** 只读页面，不改变它。接管之后仍然放行。 */
  | 'observe'
  /** 改变页面内容或状态。接管之后一律拒绝。 */
  | 'act'
  /** 只是等待，既不读也不改。接管之后放行（等待不跟人打架）。 */
  | 'wait'
  /** 换到另一个 URL。改变页面，所以接管之后同样拒绝。 */
  | 'navigate'

export type BrowserPageCapability = {
  name: string
  effect: BrowserPageCapabilityEffect
  /** 一句话说明，给 Skill 渲染用。写成 Agent 读得懂的动作，不是实现描述。 */
  summary: string
}

/**
 * 全部页面能力，按类别。
 *
 * **这张表只放派发层真能服务的名字。** 一个 AgentMux Browser 就是一个页面（一个
 * `WebContentsView`），它没有自己的标签页——所以 `openOrReuseTab` / `switchTab` /
 * `listTabs` 这类动词不在这里。注入一个必定失败的名字比不注入更糟：Agent 会把它当成可用
 * 能力来规划，然后在半途撞上一句拒绝，而此时前面的动作已经做过了。要另一个页面就
 * `agentmux open browser`。
 *
 * 动作类一律经 ref 派发，**不接受屏幕坐标、不接受 selector**。ref 由我方快照发出，是闭环
 * 内自洽的把手；坐标和 selector 都会引入「Agent 以为的目标 vs 实际命中的元素」这条裂缝，
 * 而那条裂缝的失败是不可判定的。
 *
 * `js` 与 `cdp` 是**必须项不是可选项**：库里没有的能力，Agent 自己就能补，不用等我们加
 * 函数。少了这两个逃生口，这套方案就退化成「动词清单更长的 N 动词方案」。两者按 `act`
 * 计——它们能做任何事，漏掉任何一个都等于没拦。
 */
export const BROWSER_PAGE_CAPABILITIES: readonly BrowserPageCapability[] = [
  { name: 'snapshot', effect: 'observe', summary: 'read the page as a ref-addressable tree' },
  { name: 'snapshotText', effect: 'observe', summary: 'read the page as text' },
  { name: 'pageInfo', effect: 'observe', summary: 'read the current url and title' },
  { name: 'captureScreenshot', effect: 'observe', summary: 'capture what the page looks like' },
  { name: 'click', effect: 'act', summary: 'click the element a ref points at' },
  { name: 'fillInput', effect: 'act', summary: 'replace an input value' },
  { name: 'typeText', effect: 'act', summary: 'type into the focused element' },
  { name: 'pressKey', effect: 'act', summary: 'press one key' },
  { name: 'hover', effect: 'act', summary: 'move the pointer over an element' },
  { name: 'scroll', effect: 'act', summary: 'scroll the page or an element' },
  { name: 'waitForElement', effect: 'wait', summary: 'wait until an element is there' },
  { name: 'waitForLoad', effect: 'wait', summary: 'wait for navigation to settle' },
  { name: 'waitForNetworkIdle', effect: 'wait', summary: 'wait until requests stop' },
  { name: 'wait', effect: 'wait', summary: 'wait a fixed duration' },
  { name: 'gotoUrl', effect: 'navigate', summary: 'go to another url in this Browser' },
  { name: 'js', effect: 'act', summary: 'evaluate JavaScript in the page (escape hatch)' },
  { name: 'cdp', effect: 'act', summary: 'send a raw CDP command (escape hatch)' }
] as const

/**
 * 注入子进程的名字清单。派生自上表，不手抄。
 *
 * 名字**始终全部注入**，有没有页面能力由宿主那头决定。只在有能力时才注入的话，没能力时
 * 脚本会报 `click is not defined`——那看起来像 Agent 把名字写错了，而事实是这一轮没给
 * 页面能力。
 */
export const BROWSER_PAGE_CAPABILITY_NAMES: readonly string[] = BROWSER_PAGE_CAPABILITIES.map(
  (capability) => capability.name
)

/**
 * 会改变页面的那些能力——人工接管之后要拒绝的正是这一组。
 *
 * 派生而非手抄：此前 Desktop 侧有一份同内容的手写 Set，漂移时不会有任何东西变红，只是
 * 悄悄放宽了——一个漏掉的动作名意味着人拿回页面之后 Agent 仍能改它。
 *
 * `wait` 不在内：等待既不读也不改，拦它没有意义。`observe` 不在内：见
 * {@link BrowserPageCapabilityEffect} 里放行观察的理由。
 */
export const BROWSER_PAGE_MUTATING_CAPABILITY_NAMES: ReadonlySet<string> = new Set(
  BROWSER_PAGE_CAPABILITIES.filter(
    (capability) => capability.effect === 'act' || capability.effect === 'navigate'
  ).map((capability) => capability.name)
)

/**
 * 按类别取名字，给 Skill 渲染用。
 *
 * 渲染成散文时要按类别分组（「这些用来观察、这些用来操作」），而 Skill 是字符串、tsc 守不到，
 * 所以那份文本必须从这里取，不能手打名字。
 */
export function browserPageCapabilityNames(effect: BrowserPageCapabilityEffect): readonly string[] {
  return BROWSER_PAGE_CAPABILITIES.filter((capability) => capability.effect === effect).map(
    (capability) => capability.name
  )
}
