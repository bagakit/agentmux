import { useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'

type ImeKeyboardEvent = {
  isComposing?: boolean
  keyCode?: number
  nativeEvent?: { isComposing?: boolean; keyCode?: number }
}

type ImeModifierGestureEvent = ImeKeyboardEvent & {
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
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

export function resolveImeModifierGesture(
  active: boolean,
  event: ImeModifierGestureEvent
): { active: boolean; carried: boolean; owned: boolean } {
  const hasModifier = Boolean(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
  const marked = isImeOwnedKeyboardEvent(event)
  const owned = active || (hasModifier && marked)
  return { active: owned && hasModifier, carried: active && !marked, owned }
}

type ImeEnterGestureEvent = Pick<
  ReactKeyboardEvent,
  'key' | 'keyCode' | 'nativeEvent' | 'preventDefault' | 'shiftKey'
> & { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }

/**
 * Why：CJK 组字的「确认 Enter」以两次 keydown 到达，而这两次的先后顺序**因平台而异**。
 * Windows/Linux 在 keyup **之前**就重新派发那个未标记的 `Enter`/13；macOS 则先送 keyup、
 * 之后才重新派发。因此一个「在 keyup 上同步过期」的令牌会让 macOS 回归——它会在重新派发之前
 * 就把 carry 清掉。所以 carry 一直保留到**下一个动画帧**才过期。令牌按身份隔离（每次手势一个
 * 新对象），这样一次较旧手势的过期回调不会误清掉一次较新手势的 carry。
 */
export function useImeEnterGestureOwnership(): {
  isComposing: () => boolean
  ownsKeyDown: (event: ImeEnterGestureEvent) => boolean
  onKeyUp: (event: ImeEnterGestureEvent) => void
  reset: () => void
  setComposing: (active: boolean) => void
} {
  const stateRef = useRef<{ composing: boolean; pendingEnter: object | null }>({
    composing: false,
    pendingEnter: null
  })

  return useMemo(() => {
    const reset = (): void => {
      stateRef.current = { composing: false, pendingEnter: null }
    }
    // Shift+Enter 是换行，永远不是提交——它绝不能被拥有或被吞掉。
    const isPlainEnter = (event: ImeEnterGestureEvent): boolean =>
      event.key === 'Enter' && event.keyCode === 13 && !event.shiftKey
    // 确认时重新派发的那个 Enter 不带任何修饰键，因此一个带修饰键（chorded）的 Enter 是用户
    // 越过 IME、自己发起的提交。它仍要 ARM（武装 carry），但绝不能被吞掉。
    const hasChordModifier = (event: ImeEnterGestureEvent): boolean =>
      Boolean(event.altKey || event.ctrlKey || event.metaKey)
    return {
      isComposing: () => stateRef.current.composing,
      ownsKeyDown: (event: ImeEnterGestureEvent): boolean => {
        const markedEnter =
          (event.nativeEvent.isComposing || stateRef.current.composing) &&
          (isPlainEnter(event) ||
            (event.key === 'Enter' && event.keyCode === 229) ||
            (event.key === 'Process' && event.keyCode === 229))
        if (markedEnter) {
          stateRef.current.pendingEnter = {}
          return true
        }
        if (
          stateRef.current.pendingEnter &&
          isPlainEnter(event) &&
          !event.nativeEvent.isComposing
        ) {
          // 手势无论如何都在这里结算，所以 carry 无论如何都在这里花掉；只有裸 Enter 会同时被吞掉，
          // 因为带修饰键的那个是用户自己的提交。
          stateRef.current.pendingEnter = null
          if (hasChordModifier(event)) {
            return false
          }
          event.preventDefault()
          return true
        }
        return false
      },
      onKeyUp: (event: ImeEnterGestureEvent): void => {
        // 一个 Process/229 的 keyup 意味着 IME 结束了却没有重新派发，所以手势立即结束。
        if (event.key === 'Process' && event.keyCode === 229) {
          stateRef.current.pendingEnter = null
          return
        }
        // 其余每一个 keyup 都在**下一帧**过期，绝不同步过期。Enter/13 是因为 macOS 在那次未标记的
        // 重新派发之前就送 keyup；其它键是因为有些 IME 对**每一个**键都报 Process/229（拼音选字），
        // 它们释放的是一个非 Enter 键，而一个「只在 Process 上清」的做法会让 carry 仍武装着，进而
        // 吃掉用户下一次真正的 Enter。
        const pendingEnter = stateRef.current.pendingEnter
        if (pendingEnter) {
          requestAnimationFrame(() => {
            if (stateRef.current.pendingEnter === pendingEnter) {
              stateRef.current.pendingEnter = null
            }
          })
        }
      },
      reset,
      setComposing: (active: boolean) => {
        stateRef.current.composing = active
      }
    }
  }, [])
}

/**
 * Why：CJK 输入法（日文/中文/韩文）会为「只用来确认转换候选」的那个 Enter 触发一次 keydown。
 * 那些在 `Enter` 上提交的重命名/标题输入必须忽略这次 keydown，否则它们会在组字中途就以一个
 * 半转换的取值提交。`isComposing` 覆盖多数浏览器；`keyCode === 229` 是给那些在 keydown 上不设
 * `isComposing` 的 IME 的一道防御性兜底。
 */
export function isImeCompositionKeyDown(event: ReactKeyboardEvent): boolean {
  return isImeOwnedKeyboardEvent(event)
}
