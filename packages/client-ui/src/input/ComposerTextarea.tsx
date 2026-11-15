import { Textarea, type TextareaProps } from './Textarea.js'
import { useState } from 'react'
import {
  composerCompositionHandlers,
  composerRenderValue,
  type ComposerCompositionState
} from '../lib/composer-composition.js'

/** Controlled native multiline input; the DOM owns its in-progress composition preview.
 * Callers retain the draft, keyboard actions, validation and native ref. */
export type ComposerTextareaProps = Omit<
  TextareaProps,
  'value' | 'onChange' | 'onCompositionStart' | 'onCompositionUpdate' | 'onCompositionEnd'
> & {
  value: string
  onValueChange: (value: string) => void
  variant?: 'compact'
  /** Gives the compact field more editing room without replacing the native control. */
  expanded?: boolean
}

export function ComposerTextarea({ value, onValueChange, variant, expanded, className, ...rest }: ComposerTextareaProps) {
  const [composition, setComposition] = useState<ComposerCompositionState>(null)
  const ime = composerCompositionHandlers({
    state: composition,
    setState: setComposition,
    writeValue: onValueChange
  })
  return (
    <Textarea
      {...rest}
      className={variant === 'compact' ? ['ui-input--compact-editor', className].filter(Boolean).join(' ') : className ?? ''}
      data-expanded={variant === 'compact' && expanded || undefined}
      value={composerRenderValue(value, composition)}
      onChange={(event) => ime.change(event.target.value)}
      onCompositionStart={(event) => ime.compositionStart(event.currentTarget.value)}
      onCompositionUpdate={(event) => ime.compositionUpdate(event.currentTarget.value)}
      onCompositionEnd={(event) => ime.compositionEnd(event.currentTarget.value)}
    />
  )
}
