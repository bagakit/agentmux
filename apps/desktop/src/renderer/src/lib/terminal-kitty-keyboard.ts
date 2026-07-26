/**
 * kitty keyboard 协议的启用状态，从下游 TUI 自己的输出里探测。
 *
 * 为什么要探测而不是假定：Shift+Enter 想送 CSI-u 编码（`ESC [13;2u`），前提是跑在终端里的
 * 那个程序确实在按这个协议读键。它没协商过就送，等于往它嘴里塞一串它不认识的字节——那会把
 * 「少了个换行」的缺陷换成「输入全乱」的缺陷，后者严重得多。所以启用与否由**它自己说了算**：
 * 程序通过 `CSI > flags u` 声明自己要用这个协议，我们只是读到并记住。
 *
 * 为什么不主动开启：我们是宿主，不是那个程序的作者。替它决定用什么键盘协议，就是在替它改写
 * 输入语义——而它并不知道，也没法反驳。
 *
 * 这一层是纯函数：喂字节序列进去，拿状态出来，不需要真实 PTY 就能验证 push/pop/set 的效果。
 */

/** 协议状态。`stack` 是协议自身的标志位栈，`pending` 存跨 chunk 截断的半条转义序列。 */
export type KittyKeyboardState = {
  readonly stack: readonly number[]
  readonly pending: string
}

export function initialKittyKeyboardState(): KittyKeyboardState {
  return { stack: [], pending: '' }
}

/**
 * 半条序列最多留这么长。
 *
 * 转义序列本身只有几个字节，留一小段就够拼回被 chunk 边界切断的那条。设上限是因为一段永远
 * 等不到结尾的 `ESC [` 否则会让 pending 无限长——输出流是别人写的，不能假定它总是良构。
 */
const MAX_PENDING = 32

// `CSI > flags u` 推入、`CSI < number u` 弹出、`CSI = flags ; mode u` 修改栈顶。
const KITTY_SEQUENCE = /\u001b\[([>=<])([0-9;]*)u/g

function numbers(params: string): number[] {
  if (params === '') return []
  return params.split(';').map((part) => (part === '' ? 0 : Number(part)))
}

function applySet(current: number, flags: number, mode: number): number {
  // mode 2 置位、mode 3 清位，其余（含缺省的 1）整体替换。
  if (mode === 2) return current | flags
  if (mode === 3) return current & ~flags
  return flags
}

/**
 * 把一段 PTY 输出折进协议状态。
 *
 * 只读不写：我们从不代替程序发起协商，只记录它自己发过什么。
 */
export function readKittyKeyboardOutput(
  state: KittyKeyboardState,
  chunk: string
): KittyKeyboardState {
  const combined = state.pending + chunk
  const stack = [...state.stack]
  let lastEnd = 0
  KITTY_SEQUENCE.lastIndex = 0
  for (let match = KITTY_SEQUENCE.exec(combined); match; match = KITTY_SEQUENCE.exec(combined)) {
    const [kind, params] = [match[1]!, numbers(match[2]!)]
    if (kind === '>') {
      stack.push(params[0] ?? 0)
    } else if (kind === '<') {
      // 缺省弹一层。弹空栈不是错误——程序可能比我们更早开始运行，我们只见到了后半段。
      for (let remaining = params[0] ?? 1; remaining > 0 && stack.length > 0; remaining -= 1) {
        stack.pop()
      }
    } else {
      const next = applySet(stack[stack.length - 1] ?? 0, params[0] ?? 0, params[1] ?? 1)
      if (stack.length === 0) stack.push(next)
      else stack[stack.length - 1] = next
    }
    lastEnd = match.index + match[0].length
  }

  // 末尾可能有半条被 chunk 边界切断的序列，留到下一段拼上。
  const tail = combined.slice(lastEnd)
  const escape = tail.lastIndexOf('\u001b')
  const pending = escape === -1 ? '' : tail.slice(escape)
  return { stack, pending: pending.length > MAX_PENDING ? '' : pending }
}

/**
 * 下游程序是否正在按 kitty 协议读键。栈顶标志位非 0 即为启用。
 *
 * 这里只回答"启不启用"这一个问题，不导出标志位本身：具体是哪几位（disambiguate、事件类型、
 * 关联文本……）描述的是该程序想收到多细的按键上报，与我们"Shift+Enter 送哪种编码"无关。
 * 导出一个没人用得上的数字，只会让后来者以为那里有个需要分情况处理的维度。
 */
export function isKittyKeyboardActive(state: KittyKeyboardState): boolean {
  return (state.stack[state.stack.length - 1] ?? 0) > 0
}
