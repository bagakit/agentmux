import type { RuntimeSnapshot } from '../shared/contracts.js'

/**
 * 把「运行时快照」和「app 生命期的环境告示」合成一份 `sessions:snapshot` 的应答。
 *
 * 为什么要单独一个模块，而不是在 handler 里就地展开：那个 handler 长在 `registerIpc` 的闭包里，经
 * `ipcMain.handle` 注册，本仓没有任何测试 import 得到它。实测（#877 审计独立复现）：把那次合并整段删掉
 * ——也就是让应答永远不带 `environmentWarning`——五个相关 suite 共 76 条全绿，而用户侧的后果是登录
 * shell 没加载全时那条告示**永远不出现**：终端和 Agent 都拿不到用户的 PATH，界面上却一句话都不说。
 * 与它同族的 `runtimeOwnershipWarnings` 是由 `RuntimeController.snapshot` 自己算出来的，所以那半有真
 * 覆盖；`environmentWarning` 的来源在 `RuntimeController` 之外（`buildWindow` 里 await 出来的那个值），
 * 只能在这一层合进去，于是它是这条应答里唯一没人守的字段。
 *
 * 合并方向是**告示覆盖快照**：告示是启动那一刻探针的结论，而 `RuntimeController` 根本不产出这个字段，
 * 所以今天不存在冲突。写成覆盖而不是「只在快照没有时才填」，是因为前者在两种世界里都给出同一个答案，
 * 而后者一旦将来 controller 也开始产出这个字段，就会静默保留旧的那份。
 */
export function sessionSnapshotPayload(
  snapshot: RuntimeSnapshot,
  environmentWarning: string | undefined,
  localHome?: string
): RuntimeSnapshot {
  // 缺席时**不写这个键**，而不是写成 `environmentWarning: undefined`。`exactOptionalPropertyTypes` 下
  // 这两者的类型就不同，而且经 IPC 结构化克隆后前者是「没有这个字段」，后者是「字段在、值是 undefined」
  // ——渲染层用 `?? null` 兜底，两者恰好同果，但合同上只承诺了前者。
  //
  // `localHome` 与 `environmentWarning` 同族：都是主进程事实、`RuntimeController` 不产出、只能在这一层
  // 合进去。缺席（拿不到本机 home）时同样不写键——渲染层据此不缩写，而不是拿一个空串去猜边界。
  return {
    ...snapshot,
    ...(environmentWarning === undefined ? {} : { environmentWarning }),
    ...(localHome === undefined ? {} : { localHome })
  }
}
