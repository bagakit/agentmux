/** Native composition mirror; callers retain their draft and business actions. */
/**
 * 组字状态。`null` 表示此刻没有组字。
 *
 * 非空时带的 `domValue` 就是「DOM 里现在装的那串字」——每次事件都从 `currentTarget.value` 重读，
 * 不是自己累加出来的。这一点是这层的全部安全性所在：自己推算就会与 DOM 漂移，而漂移正是缺陷本身。
 */
export type ComposerCompositionState = { domValue: string } | null

/**
 * 一次组字相关的输入事件。四种，对应 textarea 上那四个处理器。
 *
 * `input` 是 React 的 `onChange`（底下是 DOM 的 `input`）。刻意**不**带 `isComposing`：那个位在
 * 「哪些步会派发」这件事上本来就不可靠（见文件头），而这层已经有 `compositionstart` 给的状态，
 * 不需要再问事件一次。
 */
export type ComposerCompositionEvent = {
  kind: 'start' | 'update' | 'end' | 'input'
  domValue: string
}

/**
 * 状态机。四条规则各自承重，改任何一条都会让某一类破坏重新可达：
 *
 * - `start` → 进入组字，记下镜像。这是唯一一条**开始**组字的入口。
 * - `update` → 刷新镜像，且**也会**在没有组字时进入组字。为什么不忽略：`compositionupdate` 按规范
 *   总跟在 `compositionstart` 之后，所以「没有组字却收到 update」本不该发生；两种处置的代价不对称
 *   ——忽略它的代价是数据被改坏（正是本缺陷），进入组字的代价只是「这次外部写入被压到下一次
 *   非组字 `input` 或 `end`」，而那两条都会立刻把状态清掉。取有界且自愈的那一侧。
 * - `end` → 退出组字。调用方在同一个处理器里把 `domValue` 推给 store，所以这一帧渲染出来的
 *   `props.value` 已经是最终文本，React 那句赋值照旧不会发生。
 * - `input` → **只刷新已有的**组字镜像，绝不开启组字。没在组字时它把状态清成 `null`，让普通受控
 *   回路重新接管（也顺带把上面 `update` 那条的保守选择拉回来）。
 */
export function nextComposerCompositionState(
  state: ComposerCompositionState,
  event: ComposerCompositionEvent
): ComposerCompositionState {
  switch (event.kind) {
    case 'start':
    case 'update':
      return { domValue: event.domValue }
    case 'end':
      return null
    case 'input':
      return state === null ? null : { domValue: event.domValue }
  }
}

/**
 * 这一帧交给 textarea 的 `value`。
 *
 * 组字期间给镜像（与 DOM 构造上相等，React 因此无从赋值），否则给外部取值（普通受控）。
 * 这个函数小，但它就是整条修复的判决点：把它改成恒返回 `external`，缺陷原样回来。
 */
export function composerRenderValue(external: string, state: ComposerCompositionState): string {
  return state === null ? external : state.domValue
}

/** {@link composerCompositionHandlers} 要的三件事，注入形式。 */
export interface ComposerCompositionDeps {
  /** 当前状态（组件的 `useState` 那一份）。 */
  state: ComposerCompositionState
  /** 写回状态。 */
  setState: (next: ComposerCompositionState) => void
  /** 把文本交给上游（Composer 的 `onChange`，最终落到草稿表）。 */
  writeValue: (value: string) => void
}

/**
 * textarea 上那四个处理器，键就是 JSX 属性名去掉 `on` 前缀之后的意思。
 *
 * 为什么连处理器一起抽出来，而不只抽状态机：只抽状态机时「壳有没有把它接上」照旧无人守——在
 * 组件里写 `onCompositionStart={() => {}}` 或者干脆不挂那个属性，状态机那族测试全绿，而缺陷完好
 * 无损（本仓记过：抽进 lib 只解决一半 / 守卫要判可达性不是在场）。收法是让壳里每个属性只剩一句
 * 转发，判定与副作用全在这里，可以直接喂 `domValue` 断言「状态被写成什么」「外界被碰了几次」。
 *
 * `change` 与 `compositionEnd` 都写 store，理由不同：前者是为了 `canSubmit`／Enter 闸能跟着打字更新，
 * 后者是为了**这一帧**就让外部取值等于最终文本——它与 `setState(null)` 在同一个批次里，所以清掉
 * 镜像的那次重渲染读到的已经是新值，接缝处不会有一帧 `props.value` 落后于 DOM。
 */
export function composerCompositionHandlers(deps: ComposerCompositionDeps): {
  change: (domValue: string) => void
  compositionStart: (domValue: string) => void
  compositionUpdate: (domValue: string) => void
  compositionEnd: (domValue: string) => void
} {
  const advance = (kind: ComposerCompositionEvent['kind'], domValue: string): void => {
    deps.setState(nextComposerCompositionState(deps.state, { kind, domValue }))
  }
  return {
    change: (domValue) => {
      advance('input', domValue)
      deps.writeValue(domValue)
    },
    compositionStart: (domValue) => {
      advance('start', domValue)
    },
    compositionUpdate: (domValue) => {
      advance('update', domValue)
    },
    compositionEnd: (domValue) => {
      advance('end', domValue)
      deps.writeValue(domValue)
    }
  }
}
