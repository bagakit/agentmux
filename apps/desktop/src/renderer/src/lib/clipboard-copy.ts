/**
 * 复制到剪贴板的唯一出口。
 *
 * 「复制路径 / 复制文本」曾在六处各写一份，容错等级三个档：有的 try/catch 报给共享错误面，有的把
 * 错误塞进本地 state，还有一处是裸 `void api.ui.writeClipboardText(...)`——复制失败完全静默，用户
 * 以为复制成功，粘出来是旧内容。三份实现迟早各自演进，而漂移那天不会有测试变红。所以这里收成一处：
 * 全 renderer 只有本模块碰 `api.ui.writeClipboardText`，谁要复制都从这里过。
 *
 * **容错的选择：出口自己报，且强制调用方交出报错口。**
 * 失败不能静默——那是本仓明令禁止的「把未知当成好的」。可以让出口返回结果、由调用方决定怎么展示，
 * 也可以让出口自己报。这里选后者，理由是：报错口是**必填参数**，调用方无法在不指定「失败去哪」的
 * 情况下发起复制。返回结果那种写法把「记得处理失败」留给了调用方，而那正是裸 `void` 的来路——
 * 调用方一疏忽，失败就无声无息。把它做成签名上过不去的东西，比做成一条约定更硬。
 *
 * 返回 `boolean` 只为一个真实需求：BrowserPane 复制成功后才收起选区，失败要留着让用户重试。所以
 * 出口在报错之余还如实返回成败，让「成功才做的副作用」有据可依。多数调用方忽略这个返回值即可。
 */
import { api } from './api'
import { joinWorkspacePath } from './workspace-paths'

/** 复制失败往哪去。必填——不给报错口就发不起复制，静默失败在类型上就不成立。 */
export type CopyErrorReporter = (error: unknown) => void

/**
 * 路径变体：绝对 / 相对，多选用换行拼接。
 *
 * 只做这两种，因为当前只有这两种真有调用方（FileExplorer 的右键复制）。带行号的 `path:line` 没有
 * 任何调用点，不预先造。相对路径本就是工作区内相对身份，原样即可；绝对路径把每一段接到工作区根上。
 */
export function formatPathsForCopy(
  paths: readonly string[],
  variant: 'absolute' | 'relative',
  workspaceRoot: string
): string {
  const rendered =
    variant === 'absolute' ? paths.map((path) => joinWorkspacePath(workspaceRoot, path)) : [...paths]
  return rendered.join('\n')
}

/**
 * 把文本写进剪贴板；失败必报，绝不静默。
 *
 * 返回 `true` 表示写入成功，`false` 表示已把错误交给 `reportError` 之后放弃。出口自己吞掉异常，
 * 所以它永不 reject——调用方拿到的永远是一个如实的成败布尔，而不是一个可能炸掉当前流程的 promise。
 */
export async function copyTextToClipboard(
  text: string,
  reportError: CopyErrorReporter
): Promise<boolean> {
  try {
    await api.ui.writeClipboardText(text)
    return true
  } catch (error) {
    reportError(error)
    return false
  }
}
