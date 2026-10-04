import { Textarea } from './Textarea.js'
import { useState, type ComponentPropsWithRef } from 'react'
import {
  composerCompositionHandlers,
  composerRenderValue,
  type ComposerCompositionState
} from '../lib/composer-composition.js'

/** Controlled native multiline input; the DOM owns its in-progress composition preview.
 * Callers retain the draft, keyboard actions, validation and native ref. */
export type ComposerTextareaProps = Omit<
  ComponentPropsWithRef<'textarea'>,
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
    <Textarea
      {...rest}
      value={composerRenderValue(value, composition)}
      onChange={(event) => ime.change(event.target.value)}
      onCompositionStart={(event) => ime.compositionStart(event.currentTarget.value)}
      onCompositionUpdate={(event) => ime.compositionUpdate(event.currentTarget.value)}
      onCompositionEnd={(event) => ime.compositionEnd(event.currentTarget.value)}
    />
  )
}
