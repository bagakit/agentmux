/**
 * 受控 textarea 与 IME 组字的和解层。
 *
 * ─── 缺陷（#609，用户原话「给 Agent 输入中文, 删掉后再输入, 会变成不是我输入的奇怪的文字」）───
 *
 * Composer 那一格是**完全受控**的：`value` 每一次按键都往 store 走一圈再回来，而全渲染层
 * （实测 8 个 textarea）**没有任何一处认识组字**。这在 IME 下是不安全的，理由在 React 自己的
 * 提交路径里：`updateTextarea(element, value)` 的正文就是
 *
 *     value !== element.value && (element.value = value)
 *
 * ——**无条件**的 DOM 赋值，没有任何 `isComposing` 闸（本仓实测 react-dom 19.2.8 的
 * `react-dom-client.development.js:1842`）。并且每次 change 派发之后 React 还会跑一次
 * `restoreStateOfTarget`（同文件 `:3178`，由 `batchedUpdates` 的 finally 段驱动），把 props 再按一遍。
 *
 * 于是只要**组字进行中**那一刻 `props.value` 与 DOM 里的字不相等，React 就会给 `element.value`
 * 赋值。而组字期间 DOM 里装的是**预览串**（未上屏的候选），IME 自己另记着一段 composition 区间的
 * 偏移。一次外部赋值把文本换掉、区间不动，接下来这次上屏就落在错的位置上——用户看到的正是
 * 「不是我输入的奇怪的文字」。
 *
 * 「不相等」有好几条来路，**不需要**把它们一一列全才能修（这一点很重要，因为其中至少一条
 * 本仓无法观测，见下）：
 *   - 别人在写这张草稿表。`appendAgentComposerDraft`（浏览器标注那条 dock 动作）把
 *     `current + '\n\n' + text` 写回来，与 DOM 里的预览完全无关。
 *   - 某一步组字**没有**派发 `input`。Chromium 各版本、各输入法在「删一个字再重新组字」这种
 *     再转换（reconversion）路径上派发哪些事件并不一致；漏掉一次 `input` 就意味着 store 落后
 *     DOM 一步，下一次重渲染必然赋值。
 *   - 受控回路本身的任何一次合并/丢弃（StrictMode 双调、写 key 漂移——#306 那族）。
 *
 * ─── 修法：组字期间让 `props.value` 恒等于 DOM 里的那份 ───
 *
 * 不是「劝 React 别写」（做不到，那句赋值无条件），而是**让它没得写**：组字一开始就记下 DOM 里的
 * 取值（下称镜像），组字期间交给 textarea 的 `value` 就是这份镜像。镜像每次都从事件里的
 * `event.currentTarget.value` 直接读，所以它与 DOM **构造上**相等，`value !== element.value` 恒假。
 * 组字结束（`compositionend`）把镜像丢掉、并把最终文本推给 store，此后回到普通受控。
 *
 * 为什么组字期间照旧往 store 写（`change` 也带 `writeValue`）：Send 按钮的 `canSubmit`、Enter 闸都读
 * 那个取值，停写会让「打着中文时 Send 是灰的」。写进去无害——那一帧渲染出来的仍是镜像。
 *
 * ─── 这一层**不**保证什么 ───
 *
 *   - 它保证的是「组字期间 React 不会给 DOM 赋值」。它**不**保证 store 在组字期间是最新的
 *     （那正是被刻意放弃的一致性：DOM 才是这段时间的真相），也不保证组字期间到来的外部写入
 *     能活下来——**那次写入会被覆盖掉，不是被延后**。机制：`compositionEnd` 调
 *     `writeValue(domValue)`，而 `domValue` 是 IME 交出来的那串字，它从来没见过那次追加，于是
 *     一次无条件的整串写回就把追加的内容抹掉了（`store.appendAgentComposerDraft` 是
 *     `current + '\n\n' + text` 的读-改-写，被覆盖的正是它刚写进去的那一段）。
 *
 *     外部写入者今天有两个，都走 `appendAgentComposerDraft`：dock 上那个按钮（`SurfaceToolDock`
 *     的浏览器标注动作），以及对话消息上的选区注解（`SessionPane.annotateMessage`）。两个都要先
 *     把焦点移出 Composer——dock 按钮是点它就移焦；注解那条更远，弹层自带一个 autoFocus 的
 *     `ComposerTextarea`，用户是在**那一格**里打字，Composer 根本没有焦点——所以组字都已先结束，
 *     这条今天不产生可见行为。但它是**取舍**不是巧合，而且这条注释
 *     此前把它写成「压到 compositionend 之后由 store 自己决定要不要还在」——那是假的，读起来像
 *     追加还活着。真要修，`compositionEnd` 不能整串写回，得让它只提交「这次组字新增的那一段」，
 *     那是另一件事（本仓记过「今天没人需要」是会过期的理由）。
 *
 *     「只有一条追加路径」不是自然而然的：`annotateMessage` 曾手写过一份读-改-写
 *     （`getState()` + `setAgentComposerDraft`），于是这条注释说的「唯一」当时是假的，而且两份实现
 *     在尾部空白上给不同结果。收敛到 `appendAgentComposerDraft` 之后这句话才成立——
 *     再有人手写第三份，这段描述会重新变成谎。
 *   - 它**没有**测到那次真实的 IME 破坏：desktop 包没有 DOM/IME 测试环境（无 jsdom / happy-dom /
 *     @testing-library，渲染只有 `renderToStaticMarkup`，它不跑 effect 也不派发事件）。所以这一族的
 *     判据分三层：**取值与状态机**在这里，可以直接调用并断言；**壳（`ComposerTextarea`）有没有把
 *     它接上**、以及**用的那一格有没有真的用那层壳**（而不是又写了一个裸 `<textarea>`）各由
 *     `composer-ime.test.ts` 的一族 AST 守卫钉住。三层各自能独立变红——实测每层都有只杀它自己的变异。
 */

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
