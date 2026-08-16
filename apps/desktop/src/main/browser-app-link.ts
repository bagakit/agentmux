/**
 * 一个 Browser 目标该进视图、该拒绝，还是该交给系统的哪一种。判定单独成一个纯模块，
 * 理由和 `window-security.ts` 那次一样：留在 Electron 回调体里就只能靠文本扫描守，而那个文件的
 * docstring 记着两个**实测存活**的变异，都是因为「回调体里有语句可改」。这里的判定同样要能被
 * 单元测试直接质询。
 *
 * 这个文件**必须保持纯**：不 import electron、无模块级副作用。`shell.openExternal` 由调用方注入。
 * （`contracts.ts` 只进 `import type`，不落运行时 import。）
 */
import type { AppLinkSchemeChoice } from '../shared/contracts.js'

/**
 * 视图真的装得下的那些。
 *
 * 与 `assertAllowedBrowserUrl` 的关系：那道闸门**逐字不变**，分流发生在它之前。`customapp://` 装不进
 * `WebContentsView`，所以应用链接要的不是「放行进视图」，是改道给系统。
 */
const EMBEDDABLE_PROTOCOLS = new Set(['http:', 'https:', 'file:'])

/**
 * 永远不交给系统的伪 scheme。这是一张**禁止清单**，而禁止清单必漏——这里可以接受，因为漏的那边
 * 是安全的那边：漏掉的伪 scheme 会掉进 `ask`，于是用户被问一次（保守、可发现）。
 *
 * 反过来把「未知即拒绝」写成白名单就不行了：漏一个的后果是「这个 app 链接永远打不开」，而且
 * 没有人会注意到。判据是漏了会往哪边倒，不是清单本身长不长。
 *
 * `about:` 在这张表里而不在兜底那一段：它是浏览器自己的伪 scheme，不是任何一个应用的。递出去会得到
 * 一句「open about: links in another app?」——那一问对用户毫无意义，而 `about:blank` 更是每一个无参
 * `window.open()` 的目标，等于每开一个空白页都弹一次。
 */
const NEVER_HANDED_OFF_PROTOCOLS = new Set(['javascript:', 'data:', 'blob:', 'about:'])

export type BrowserTargetKind =
  /** 进视图，走原来的闸门。 */
  | 'embed'
  /** 既不进视图也不交给系统。伪 scheme 走这里。 */
  | 'refuse'
  /** 应用链接。交给系统之前先问一次（或读已经记住的答案）。 */
  | 'hand-off'

export interface BrowserTarget {
  readonly kind: BrowserTargetKind
  /**
   * `hand-off` 时是那个 scheme 的名字（不带冒号，如 `alphaapp`）——记住的选择按它存，问的话也说它。
   * 其余两种为 `null`。
   */
  readonly scheme: string | null
}

const EMBED: BrowserTarget = { kind: 'embed', scheme: null }
const REFUSE: BrowserTarget = { kind: 'refuse', scheme: null }

/**
 * 判一个目标属于三段里的哪一段。**顺序判，不是查一张表**：能装的先走，伪 scheme 再拒，剩下的
 * 一律算应用链接。
 *
 * 第三段刻意兜底而不枚举：一般浏览器的做法就是把未知 scheme 交给 OS 判，我们枚举不完
 * `alphaapp` / `betaapp` / `mailto` 之外的世界。安全边界是**那一问**，不是那张表。
 *
 * 解析不了的字符串算 `refuse`：连 scheme 都取不出来的东西，没有任何理由递给 `shell.openExternal`。
 */
export function classifyBrowserTarget(rawUrl: string): BrowserTarget {
  let protocol: string
  try {
    protocol = new URL(rawUrl).protocol.toLowerCase()
  } catch {
    return REFUSE
  }
  if (EMBEDDABLE_PROTOCOLS.has(protocol)) return EMBED
  if (NEVER_HANDED_OFF_PROTOCOLS.has(protocol)) return REFUSE
  return { kind: 'hand-off', scheme: protocol.slice(0, -1) }
}

/**
 * 用户对某个 scheme 记住的答案。没记过就是 undefined——那一档要问。
 *
 * 真源在 `contracts.ts` 的 `APP_LINK_SCHEME_CHOICES` 元组（`config-store.ts` 的 `z.enum` 读同一份），
 * 这里只转出去，不再声明第二遍——原先本文件自己写一份 `'allow' | 'deny'`，与磁盘校验各说各的。
 */
export type { AppLinkSchemeChoice }

/**
 * 一次应用链接移交的结局。`open` 是唯一带副作用的一档，由 `appLinkOutcome` 自己执行——
 * 让调用方 `if (decision.shouldOpen) shell.openExternal(...)` 是**实测可被劫持**的形状
 * （见 `window-security.ts` 里 `windowOpenOutcome` 的注释：消费侧当时没人守，取反或删掉整行
 * 都能在全绿下存活）。所以这里同样把判定和它唯一的副作用收在一次调用里。
 */
export type AppLinkOutcome =
  /** 已经记住了 allow，直接开了。 */
  | { readonly kind: 'opened'; readonly scheme: string }
  /** 没记过，要问用户。 */
  | { readonly kind: 'ask'; readonly scheme: string; readonly url: string }
  /** 记住了 deny。不开，也要说出来。 */
  | { readonly kind: 'refused'; readonly scheme: string }

/**
 * 按已记住的选择决定这一次怎么走，并在该开的时候**真的开**。
 *
 * `openExternal` 由调用方注入而不是在这里 import electron（本文件必须保持纯），且必须以
 * `shell.openExternal.bind(shell)` 或箭头包一层的方式传入——直接摘方法会丢掉原生 receiver
 * （本仓吃过这个亏，`exit: app.exit` 那次抛的是 Illegal invocation）。
 */
export function appLinkOutcome(
  url: string,
  scheme: string,
  remembered: AppLinkSchemeChoice | undefined,
  openExternal: (target: string) => void
): AppLinkOutcome {
  if (remembered === undefined) return { kind: 'ask', scheme, url }
  if (remembered === 'deny') return { kind: 'refused', scheme }
  openExternal(url)
  return { kind: 'opened', scheme }
}

/**
 * 一次「这个页面想开新窗口」的结局。**只截应用链接**，其余一律交回 Chromium。
 *
 * 为什么「其余一律 allow」是承重的而不是偷懒：`649df3a2`（fix(browser): preserve native popup
 * semantics）删掉的那段，把**每一个** window-open 都改道成 `this.navigate(entry.id, url)` 再 deny——
 * 于是 `target="_blank"` 的普通链接被压进同一个 view，弹窗语义全没了。那次修法是**整个 handler 缺席**，
 * 而缺席的后果就是本 Feature 要修的另一半：应用链接的弹窗会真的开出一个 Electron 窗口（实测窗口数
 * 1→2→3），里面装着一个装不下的 `customapp:` 地址，没人管。
 *
 * 所以这里回装 handler，但**不回到那个形状**：非应用链接返回 `{ action: 'allow' }`，那正是「没有
 * handler」时 Electron 的默认动作，逐字等价。回到「一律改道」就是把 `649df3a2` 修的 bug 重新引入。
 *
 * `refuse` 那一档也走 `allow`，这不是放行而是**不插手**：`javascript:` 的 `window.open` 由 Chromium
 * 按 opener 自己的规则处置，与今天逐字相同。本任务只回装应用链接那一条截流，不顺手扩大 handler
 * 的职责——扩大了就得为每一档新行为负责，而那些行为今天没有任何人要求改。
 *
 * 与 `window-security.ts` 的 `windowOpenOutcome` 是两件事，别串：那个管的是**应用主窗口**（一律
 * deny，https 交给系统浏览器）；这个管的是内嵌 Browser 里那张页面（只有应用链接归我们）。
 *
 * `handOff` 由调用方注入，和 `appLinkOutcome` 的 `openExternal` 同理——判定与它唯一的副作用收在
 * 一次调用里，Electron 回调体里不留语句可改。
 */
export function browserWindowOpenOutcome(
  rawUrl: string,
  handOff: (url: string, scheme: string) => void
): { readonly action: 'allow' | 'deny' } {
  const target = classifyBrowserTarget(rawUrl)
  if (target.kind !== 'hand-off') return { action: 'allow' }
  handOff(rawUrl, target.scheme!)
  return { action: 'deny' }
}

/**
 * 被拒绝时显示的那句话。说到下一步为止——房规是「文案点名的动作要从当前状态真能走通」，
 * 所以点名的是 Settings › Browser 里那份「记住的答案」表（用户当初就是在这个面板上回答的，
 * 而那张表上有一个 Forget 按钮真能把这一档撤回去），不是一个需要去别处找的开关。
 *
 * 这句话点名的位置由 `browser-app-link-reachable.test.ts` 证明真的到得了——有节无控件同样是
 * 到不了，本仓在 `agentAutomation` 那次已经吃过一遍（记忆
 * copy-must-name-an-action-reachable-from-this-state）。
 */
export function appLinkRefusedMessage(scheme: string): string {
  return (
    `You chose not to let this page open ${scheme}: links in another app. ` +
    `Nothing was opened and the page did not navigate. ` +
    `To be asked again, forget that choice under "App links you answered" in Settings › Browser.`
  )
}
