import { useState, type ComponentPropsWithoutRef } from 'react'
import {
  composerCompositionHandlers,
  composerRenderValue,
  type ComposerCompositionState
} from '../lib/composer-composition'

/**
 * 一个受控 textarea，且**认识 IME 组字**（#609）。
 *
 * 为什么要有这层壳，而不是让每个调用方自己写 `<textarea value onChange>`：受控 textarea 在组字期间
 * 会被 React 的无条件 DOM 赋值改坏（整条机制、实测的 react-dom 行号、以及为什么修法是「让它没得写」，
 * 全部记在 lib/composer-composition.ts 的文件头）。那不是某个组件的疏忽，而是**每一个**受控 textarea
 * 的默认状态——本仓实测 8 个，改这轮之前 0 个认识组字。所以正确的落点是一层可复用的壳，而不是在
 * AgentComposer 里补一次。
 *
 * 壳里刻意没有任何判断：状态机与副作用全在 lib 里，可直接调用并断言；这里只剩「把四个事件转发过去」
 * 和「把取值交给 composerRenderValue」。三层各自的判据在 test/composer-ime.test.ts——那里还有一层是钉
 * **调用方真的用了这层壳**（而不是又写一个裸 `<textarea>`），因为那种情况下本文件每一条判据都照旧全绿
 * 而用户的缺陷完好无损。那个文件头也写明了本仓没有 DOM/IME 测试环境、因此哪些事这族测试**没有**证明。
 *
 * 契约上它仍是受控的：`value` 由调用方给，`onValueChange` 每次用户改动都会被调用（组字中间步也会，
 * 因为 Send 的 canSubmit / Enter 闸读那个取值）。唯一的例外是**组字进行中这一帧渲染出的 DOM 取值**
 * 由这层作主——那正是修复本身。
 */
export type ComposerTextareaProps = Omit<
  ComponentPropsWithoutRef<'textarea'>,
  'value' | 'onChange' | 'onCompositionStart' | 'onCompositionUpdate' | 'onCompositionEnd'
> & {
  value: string
  onValueChange: (value: string) => void
}

export function ComposerTextarea({ value, onValueChange, ...rest }: ComposerTextareaProps) {
  const [composition, setComposition] = useState<ComposerCompositionState>(null)
  const ime = composerCompositionHandlers({
    state: composition,
    setState: setComposition,
    writeValue: onValueChange
  })

  return (
    <textarea
      {...rest}
      value={composerRenderValue(value, composition)}
      onChange={(event) => ime.change(event.target.value)}
      onCompositionStart={(event) => ime.compositionStart(event.currentTarget.value)}
      onCompositionUpdate={(event) => ime.compositionUpdate(event.currentTarget.value)}
      onCompositionEnd={(event) => ime.compositionEnd(event.currentTarget.value)}
    />
  )
}
