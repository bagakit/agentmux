import * as Dialog from './Modal.js'
import { SegmentedControl } from './SegmentedControl.js'
import { useState } from 'react'
import { SemanticIcon } from '../theme/icons.js'

export type MarkdownReadingWidth = 'standard' | 'wide' | 'full'
export type MarkdownReadingTypeface = 'sans' | 'serif'
export type MarkdownReadingLayoutValue = { width: MarkdownReadingWidth; typeface: MarkdownReadingTypeface; fontSize: number }
/** One reader choice, never a whole layout: the Host applies it to the value it saves at that time, so quick choices compose. */
export type MarkdownReadingLayoutChange =
  | { kind: 'width'; width: MarkdownReadingWidth }
  | { kind: 'typeface'; typeface: MarkdownReadingTypeface }
  | { kind: 'font-size-step'; step: 1 | -1 }
  | { kind: 'font-size-reset' }
/** The Host owns persistence; this control only reports the reader's choice. */
export type MarkdownReadingLayout = {
  value: MarkdownReadingLayoutValue
  fontSizes: { min: number; max: number; default: number }
  onChange(change: MarkdownReadingLayoutChange): void
}

const WIDTHS = [
  { value: 'standard', label: 'Standard' },
  { value: 'wide', label: 'Wide' },
  { value: 'full', label: 'Full' },
] as const

const TYPEFACES = [
  { value: 'sans', label: <><span className="md-reading__sample" aria-hidden="true">Aa</span>Sans</> },
  { value: 'serif', label: <><span className="md-reading__sample" aria-hidden="true">Aa</span>Serif</> },
] as const

/** Width, typeface and size for the document; each change applies in place. */
export function MarkdownReadingLayoutControl({ layout }: { layout: MarkdownReadingLayout }) {
  const [open, setOpen] = useState(false)
  const { value, fontSizes } = layout
  return <div className="md-reading"><Dialog.Root modal={false} open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild>
      <button type="button" className="md-outline__trigger md-reading__trigger" aria-label="Reading layout" title="Reading layout">
        <SemanticIcon name="editor.markdown-reading-layout" size={14} aria-hidden="true" />
      </button>
    </Dialog.Trigger>
    <Dialog.Content className="md-outline__popover md-reading__popover" aria-describedby={undefined}>
      <div className="md-outline__header">
        <Dialog.Title className="md-outline__title">Reading layout</Dialog.Title>
        <Dialog.Close asChild><button type="button" className="md-outline__close" aria-label="Close reading layout"><SemanticIcon name="action.close" size={13} aria-hidden="true" /></button></Dialog.Close>
      </div>
      <div className="md-reading__body">
        <div className="md-reading__group">
          <span className="md-reading__label">Width</span>
          <SegmentedControl aria-label="Width" options={WIDTHS} value={value.width} onValueChange={width => layout.onChange({ kind: 'width', width })} />
        </div>
        <div className="md-reading__group">
          <span className="md-reading__label">Typeface</span>
          <SegmentedControl aria-label="Typeface" options={TYPEFACES} value={value.typeface} onValueChange={typeface => layout.onChange({ kind: 'typeface', typeface })} />
        </div>
        <div className="md-reading__group" role="group" aria-label="Text size">
          <span className="md-reading__label">Size</span>
          <div className="md-reading__stepper">
            <button type="button" className="md-reading__step" aria-label="Smaller text" disabled={value.fontSize <= fontSizes.min}
              onClick={() => layout.onChange({ kind: 'font-size-step', step: -1 })}><span aria-hidden="true" className="md-reading__step-glyph" data-step="down">A</span></button>
            <button type="button" className="md-reading__size" aria-label={`Text size ${value.fontSize} pixels, reset to ${fontSizes.default}`}
              title="Reset text size" onClick={() => layout.onChange({ kind: 'font-size-reset' })}>{value.fontSize}px</button>
            <button type="button" className="md-reading__step" aria-label="Larger text" disabled={value.fontSize >= fontSizes.max}
              onClick={() => layout.onChange({ kind: 'font-size-step', step: 1 })}><span aria-hidden="true" className="md-reading__step-glyph" data-step="up">A</span></button>
          </div>
        </div>
      </div>
    </Dialog.Content>
  </Dialog.Root></div>
}
