/**
 * 一个 Browser 目标该进视图、该拒绝，还是该交给系统的哪一种。判定单独成一个纯模块，
 * 理由和 `window-security.ts` 那次一样：留在 Electron 回调体里就只能靠文本扫描守，而那个文件的
 * docstring 记着两个**实测存活**的变异，都是因为「回调体里有语句可改」。这里的判定同样要能被
 * 单元测试直接质询。
 *
 * 这个文件**必须保持纯**：不 import electron、无模块级副作用。`shell.openExternal` 由调用方注入。
 */

/**
 * 视图真的装得下的那些。`about:blank` 归这一类是因为它就是空页面本身。
 *
 * 与 `assertAllowedBrowserUrl` 的关系：那道闸门**逐字不变**，分流发生在它之前。`lark://` 装不进
 * `WebContentsView`，所以应用链接要的不是「放行进视图」，是改道给系统。
 */
const EMBEDDABLE_PROTOCOLS = new Set(['http:', 'https:', 'file:'])

/**
 * 永远不交给系统的伪 scheme。这是一张**禁止清单**，而禁止清单必漏——这里可以接受，因为漏的那边
 * 是安全的那边：漏掉的伪 scheme 会掉进 `ask`，于是用户被问一次（保守、可发现）。
 *
 * 反过来把「未知即拒绝」写成白名单就不行了：漏一个的后果是「这个 app 链接永远打不开」，而且
 * 没有人会注意到。判据是漏了会往哪边倒，不是清单本身长不长。
 */
const NEVER_HANDED_OFF_PROTOCOLS = new Set(['javascript:', 'data:', 'blob:'])

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
   * `hand-off` 时是那个 scheme 的名字（不带冒号，如 `lark`）——记住的选择按它存，问的话也说它。
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
 * `lark` / `slack` / `zoommtg` / `vscode` / `mailto` 之外的世界。安全边界是**那一问**，不是那张表。
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

/** 用户对某个 scheme 记住的答案。没记过就是 undefined——那一档要问。 */
export type AppLinkSchemeChoice = 'allow' | 'deny'

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
 * 被拒绝时显示的那句话。说到下一步为止——房规是「文案点名的动作要从当前状态真能走通」，
 * 所以点名的是 Settings › Browser 里那份记住的清单（用户当初就是在这个面板上回答的），
 * 不是一个需要去别处找的开关。
 */
export function appLinkRefusedMessage(scheme: string): string {
  return (
    `You chose not to let this page open ${scheme}: links in another app. ` +
    `Nothing was opened and the page did not navigate. ` +
    `Change that choice in Settings › Browser if you want ${scheme}: links handed to your system again.`
  )
}
