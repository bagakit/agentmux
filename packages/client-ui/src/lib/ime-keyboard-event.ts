export type ImeKeyboardEvent = {
  isComposing?: boolean
  keyCode?: number
  nativeEvent?: { isComposing?: boolean; keyCode?: number }
}

/**
 * 键盘事件当前是被 IME（输入法）而非 AgentMux 拥有时为 true。
 *
 * 判据读**四**个来源而不是三个：React 合成事件上的 `isComposing`/`keyCode`，以及原生事件
 * `nativeEvent` 上的 `isComposing`/`keyCode`。第四个（nativeEvent.keyCode）最容易顺手漏掉，
 * 但有些 IME 只在原生事件上标 229，缺了它那条路径就会把组字中的 Enter 当成用户提交。
 */
export function isImeOwnedKeyboardEvent(event: object): boolean {
  const candidate = event as ImeKeyboardEvent
  return (
    candidate.isComposing === true ||
    candidate.keyCode === 229 ||
    candidate.nativeEvent?.isComposing === true ||
    candidate.nativeEvent?.keyCode === 229
  )
}
