import * as Dialog from '@radix-ui/react-dialog'
import { ListTree, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { markdownHeadingText, type MarkdownHeading } from '../lib/agent-markdown.js'

/** Presentation only: the Markdown mount owns the headings and the navigation destination. */
export function MarkdownOutline({ headings, onNavigate }: {
  headings: MarkdownHeading[]
  onNavigate(source: HTMLElement, anchor: string): void
}) {
  const [open, setOpen] = useState(false)
  const navigating = useRef(false)
  const entries = useMemo(() => open ? headings.map(heading => ({
    anchor: heading.anchor, level: heading.level, label: markdownHeadingText(heading)
  })) : [], [open, headings])
  if (!headings.length) return null

  return <div className="md-outline">
    <Dialog.Root modal={false} open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className="md-outline__trigger" aria-label="Show document outline" title="Document outline">
          <ListTree size={14} aria-hidden="true" />Contents
        </button>
      </Dialog.Trigger>
      <Dialog.Content className="md-outline__popover" aria-describedby={undefined}
        onCloseAutoFocus={event => {
          if (navigating.current) event.preventDefault()
          navigating.current = false
        }}>
        <div className="md-outline__header">
          <Dialog.Title className="md-outline__title">On this page</Dialog.Title>
          <Dialog.Close asChild><button type="button" className="md-outline__close" aria-label="Close document outline"><X size={13} aria-hidden="true" /></button></Dialog.Close>
        </div>
        <nav aria-label="Document outline" className="md-outline__entries">
          {entries.map(entry => <button key={entry.anchor} type="button" className="md-outline__entry"
            data-md-outline-anchor={entry.anchor} data-level={entry.level} title={entry.label}
            style={{ paddingInlineStart: `${8 + (entry.level - 1) * 12}px` }}
            onClick={event => {
              navigating.current = true
              onNavigate(event.currentTarget, entry.anchor)
              setOpen(false)
            }}>{entry.label}</button>)}
        </nav>
      </Dialog.Content>
    </Dialog.Root>
  </div>
}
