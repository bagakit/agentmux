import type { BrowserPageNode, BrowserPageSnapshot } from '../shared/contracts.js'

/**
 * ref 账本：让一个 ref 在发出它的那次运行结束之后仍然有意义。
 *
 * **不做这件事的后果不是"ref 失效"，是"ref 静默指错"**。快照的 ref 是按走查顺序现编的
 * （`browser-page-snapshot.ts` 的 `nextRef`，每次从 @e1 重新数）。Agent 第二轮拿着上一轮的
 * `@e3` 来 click，派发层缓存是空的，于是它取一张新快照，而新快照里**照样有 @e3**——解得开，
 * 点得下去，点的是另一个元素。整条路上没有一处报错。这正是 AGENTS.md:32-52 不许出现的那种
 * 结局：分不清的被当成了好的。
 *
 * 所以账本记的不是 `backendNodeId`（它随 CDP 会话消亡，重启后一个都不作数），而是**内容身份**：
 * 角色 + 可访问名 + 第几个。重启之后页面重新加载，只有这三样还在。
 *
 * 自愈（按 role+name+nth 重新匹配）改编自一个 MIT 许可的参考实现（署名见 THIRD_PARTY_NOTICES.md）
 * 的 `tryRecoverRef`。**有损性是这份实现相对原版的全部增量**：原版匹配上就当解开了，调用方无从
 * 分辨"还是那个元素"和"另一个长得一样的元素"。这里每一次自愈都留下一条说明，交给上层自己判断
 * 要不要信——静默自愈比不自愈更糟。
 *
 * 为什么另起一个 store 而不是挂到 `AgentSessionStore` 上：生命周期不同。ref 跟着页面内容失效，
 * session 不跟。挂在一起之后，每次改 session 的持久化都要连带想一遍 ref 会不会被影响。
 */

/**
 * 账本里的一条。
 *
 * **不记 `backendNodeId`，也不记 `sessionId`**：前者是 CDP 给当前渲染树的编号，后者是本次 attach
 * 的 frame 会话号。运行一结束两者一起作废，记下来只会诱使下一轮拿它去解——而那种解开是假的。
 */
export type BrowserRefLedgerEntry = {
  ref: string
  /** 快照里那份**归一化后**的角色名。自愈要拿新快照的同一字段比，所以两边必须是同一套词。 */
  role: string
  name: string
  /** 同名同角色的元素里排第几个（从 1 起）。分页导航那种「全是 Next」的页面全靠它区分。 */
  nth: number
}

export type BrowserRefLedger = {
  /** 发出这批 ref 时页面所在的地址。地址变了这批 ref 就是真作废，不该去猜。 */
  url: string
  entries: BrowserRefLedgerEntry[]
}

/** 自愈的结局。成功也带一句话——它是有损的，上层有权知道。 */
export type BrowserRefHeal =
  | { healed: true; node: BrowserPageNode; note: string }
  | { healed: false; reason: string }

/**
 * 给快照里每个节点编上「同角色同名的第几个」。
 *
 * 写成一个函数而不是两处各数一遍，是因为**账本侧和自愈侧必须用同一条计数规则**：一边把无名文本
 * 节点算进去、另一边不算，nth 就会整体错位，而错位的结果是自愈稳定地匹配到隔壁那个元素。
 */
function ordinals(snapshot: BrowserPageSnapshot): { node: BrowserPageNode; nth: number }[] {
  const seen = new Map<string, number>()
  return snapshot.nodes.map((node) => {
    // \u0000 做分隔符，不是空格：可访问名是页面文本，什么字符都可能有。
    // 要写成转义而不是真的 NUL 字节：后者在源码里看不见，git 会把整个文件当成二进制，
    // 于是这个模块的每一次 diff 都不可读—— review 看不见的改动等于没人审。
    const key = `${node.role}\u0000${node.name}`
    const nth = (seen.get(key) ?? 0) + 1
    seen.set(key, nth)
    return { node, nth }
  })
}

/** 把一张快照压成账本。只收发过 ref 的节点——没发出去的把手没人会拿回来。 */
export function ledgerFromSnapshot(snapshot: BrowserPageSnapshot): BrowserRefLedger {
  const entries: BrowserRefLedgerEntry[] = []
  for (const { node, nth } of ordinals(snapshot)) {
    if (node.ref !== '') entries.push({ ref: node.ref, role: node.role, name: node.name, nth })
  }
  return { url: snapshot.url, entries }
}

/**
 * 拿账本在一张新快照上把旧 ref 认回来。
 *
 * 三道关，每一道失败都说到下一步为止：地址换了（这批 ref 真作废）、账本里没这个 ref（Agent 拼错了
 * 或来自更早的一批）、页面上没有对得上的元素（东西没了）。
 */
export function healRef(
  ledger: BrowserRefLedger,
  ref: string,
  fresh: BrowserPageSnapshot
): BrowserRefHeal {
  if (ledger.url !== fresh.url) {
    return {
      healed: false,
      reason:
        `${ref} was issued on ${ledger.url} but this Browser is now on ${fresh.url}, ` +
        'so every ref from before is void. Take a new snapshot().'
    }
  }
  const entry = ledger.entries.find((candidate) => candidate.ref === ref)
  if (!entry) {
    return {
      healed: false,
      reason:
        `No element ${ref} in the current snapshot, and the previous run did not hand out that ref ` +
        'either. Take a fresh snapshot() and use a ref from it.'
    }
  }
  // backendNodeId 为 0 的节点解不回 DOM（地标、纯文本就是这种）。拿它当匹配结果等于发一个
  // 永远失败的把手回去。
  const candidates = ordinals(fresh).filter(
    ({ node }) => node.role === entry.role && node.name === entry.name && node.backendNodeId !== 0
  )
  const exact = candidates.find((candidate) => candidate.nth === entry.nth)
  const chosen = exact ?? candidates[0]
  if (!chosen) {
    return {
      healed: false,
      reason:
        `${ref} pointed at ${entry.role} "${entry.name}" (#${entry.nth}), and nothing on the page ` +
        'matches that now. Take a new snapshot().'
    }
  }
  // 这句话是这个模块存在的一半理由。匹配成功**不等于**还是那个元素——列表重排、分页翻页、
  // 同名按钮换了一行，都会让 role+name+nth 命中一个"看起来一样"的邻居。消不掉，只能说出来。
  const ordinalNote = exact
    ? ''
    : ` The #${entry.nth} match is gone, so the #${chosen.nth} of ${candidates.length} was used instead —` +
      ' that is a weaker match than the ordinal it was recorded with.'
  return {
    healed: true,
    node: chosen.node,
    note:
      `${ref} was recovered by matching ${entry.role} "${entry.name}" against the page again, because ` +
      `the snapshot that issued it is gone.${ordinalNote} This match is by appearance, not identity: ` +
      'it can land on a different element that looks the same. Check the result before trusting it.'
  }
}
