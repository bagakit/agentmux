import type { BrowserPageNode, BrowserPageSnapshot } from '../shared/contracts.js'
import type { BrowserCdpSender } from './browser-page-snapshot.js'

/**
 * 把一个 ref 解回可派发动作的 objectId。
 *
 * 这是「结构化 ref 寻址 ≠ 键鼠模拟」落到执行层的那一步：整条路径就是
 * `ref → 快照里的节点 → DOM.resolveNode({backendNodeId}) → object.objectId`，一次 CDP 往返。
 *
 * 刻意**不做**定位 DSL（`css=` / `role=` / `xpath=` / `text=`）、不做 shadow 穿透、不做跨 frame 搜索、
 * 不做 actionability 判定。理由是熵不是工作量：DSL 一旦提供就是永久语法面，每种语法要永远解析、
 * 永远保证语义不漂、失败时永远要说清是哪层没匹配上。而 ref 是闭环内自洽的——它由我方快照发出，
 * 不是用户手写的表达式，没有「用户以为的语义 vs 实际语义」这条裂缝。真要 DSL，Agent 用页面函数库的
 * js 逃生口自己写就行，不必由我们提供并永久维护。
 *
 * 参考实现（MIT，署名见 THIRD_PARTY_NOTICES.md）在这条路径上还有一个 role/name 回退：backendNodeId
 * 解不开时按角色和名字重新找一个。**这里不要那个回退**——它会静默地选中另一个同名元素，而 Agent
 * 拿到的仍然是「成功」。解不开就是解不开，明说「重新取快照」。
 */

/** 解析失败的原因。分两类是因为它们对 Agent 意味着不同的下一步。 */
export type BrowserRefResolutionFailure =
  /** 这个 ref 根本不在快照里：Agent 拼了一个不存在的把手，或者用的是上一张快照的 ref。 */
  | { kind: 'unknown-ref'; ref: string }
  /** ref 在快照里，但页面已经变了——节点没了。唯一的出路是重新取快照。 */
  | { kind: 'stale-ref'; ref: string; reason: string }
  /** 快照本身已经作废：页面导航过了，整张快照的 ref 一个都不能用。 */
  | { kind: 'stale-snapshot'; ref: string; snapshotNavigationId: string; currentNavigationId: string }

export type BrowserRefResolution =
  | { resolved: true; objectId: string; sessionId?: string }
  | { resolved: false; failure: BrowserRefResolutionFailure }

/**
 * CDP 的对象组。同一组里的 remote object 可以一次性释放，不必逐个记 objectId。
 * 用一个固定名字就够——这里解出来的句柄都是要真正拿去派发动作的，不是批量临时句柄。
 */
const OBJECT_GROUP = 'agentmux-browser'

export type BrowserRefResolveInput = {
  snapshot: BrowserPageSnapshot
  ref: string
  /** 主 frame 的 sender。 */
  send: BrowserCdpSender
  /** frameId → 该 frame 的 sender。节点带 sessionId 时必须发到对应的那个。 */
  frames?: Map<string, BrowserCdpSender>
  /**
   * 当前的导航身份。与快照不符就说明页面换过了——整张快照的 ref 全部作废。
   * 不传表示调用方不做这项检查（例如快照刚取完、中间不可能发生导航）。
   */
  currentNavigationId?: string
}

/** 在快照里按 ref 找节点。ref 是快照内唯一的，所以第一个命中就是答案。 */
function findNode(snapshot: BrowserPageSnapshot, ref: string): BrowserPageNode | undefined {
  return snapshot.nodes.find((node) => node.ref !== '' && node.ref === ref)
}

/**
 * 解一个 ref。
 *
 * 四种结局各自独立，没有一种是"看起来成功"：解出来了、ref 不认识、节点没了、整张快照作废。
 * 返回结构化结局而不是抛异常，是因为调用方（Agent 脚本执行器）要把它原样报告给 Agent——
 * 一个 Error 的字符串会让"哪种失败"退化成要靠正则去猜。
 */
export async function resolveBrowserRef(input: BrowserRefResolveInput): Promise<BrowserRefResolution> {
  const { snapshot, ref } = input

  // 导航检查放最前面：页面换过之后，ref 在旧快照里"找得到"恰恰是最危险的——
  // backendNodeId 可能还能解开，只是解到了新页面上一个毫不相干的节点。
  if (
    input.currentNavigationId !== undefined &&
    input.currentNavigationId !== snapshot.navigationId
  ) {
    return {
      resolved: false,
      failure: {
        kind: 'stale-snapshot',
        ref,
        snapshotNavigationId: snapshot.navigationId,
        currentNavigationId: input.currentNavigationId
      }
    }
  }

  const node = findNode(snapshot, ref)
  if (!node) return { resolved: false, failure: { kind: 'unknown-ref', ref } }

  // 节点属于哪个 frame，命令就要发到哪个 session——发错了 backendNodeId 解不开，
  // 而那种失败看起来和"元素没了"一模一样。
  const send = node.sessionId ? input.frames?.get(node.sessionId) : input.send
  if (!send) {
    return {
      resolved: false,
      failure: {
        kind: 'stale-ref',
        ref,
        reason: `No CDP session for frame ${node.sessionId} — the frame is gone; take a new snapshot`
      }
    }
  }

  let resolvedObjectId: string | undefined
  try {
    const result = (await send('DOM.resolveNode', {
      backendNodeId: node.backendNodeId,
      objectGroup: OBJECT_GROUP
    })) as { object?: { objectId?: string } }
    resolvedObjectId = result.object?.objectId
  } catch (error) {
    // 这里**不**回退到按角色/名字重找。回退会静默选中另一个同名元素并报成功。
    return {
      resolved: false,
      failure: { kind: 'stale-ref', ref, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  // CDP 不抛错但也没给 objectId，同样是没解开。不能因为"没抛错"就当成功
  // （AGENTS.md:32-52 原则 11：不许把分不清的当成好的）。
  if (!resolvedObjectId) {
    return {
      resolved: false,
      failure: { kind: 'stale-ref', ref, reason: 'DOM.resolveNode returned no objectId; take a new snapshot' }
    }
  }

  return { resolved: true, objectId: resolvedObjectId, ...(node.sessionId ? { sessionId: node.sessionId } : {}) }
}
