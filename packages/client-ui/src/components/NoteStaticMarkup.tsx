import { useEffect, useState } from 'react'
import * as Dialog from './Modal.js'
import { StaticMarkupPreview } from './StaticMarkupPreview.js'
import { useVisibleWork } from '../lib/use-visible-work.js'

export function noteStaticMarkupLanguage(language: string | null): 'html' | 'svg' | null {
  const normalized = language?.trim().toLowerCase()
  return normalized === 'html' || normalized === 'svg' ? normalized : null
}

/** Preview choice and size belong to this view; the original source stays with its editor. */
export function NoteStaticMarkup({ content, kind }: { content: string; kind: 'html' | 'svg' }) {
  const [preview, setPreview] = useState(false), [height, setHeight] = useState(240), [expanded, setExpanded] = useState(false)
  const { ref, visible } = useVisibleWork<HTMLDivElement>(preview)
  const title = `${kind.toUpperCase()} preview`
  useEffect(() => { if (!visible) setExpanded(false) }, [visible])
  return <div ref={ref} className="note-static-markup" contentEditable={false}>
    <div className="note-static-markup__tools">
      <span>{kind.toUpperCase()}</span>
      <button type="button" aria-expanded={preview} onClick={() => setPreview(value => !value)}>{preview ? 'Hide preview' : `Preview ${kind.toUpperCase()}`}</button>
      {preview && <>
        <label>Height <select aria-label="Static preview height" value={height} onChange={event => setHeight(Number(event.currentTarget.value))}>
          <option value={240}>Small</option><option value={400}>Medium</option><option value={600}>Large</option>
        </select></label>
        <Dialog.Root open={expanded && visible} onOpenChange={setExpanded}>
          <Dialog.Trigger asChild><button type="button">Expand preview</button></Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="note-static-markup__overlay" />
            <Dialog.Content className="note-static-markup__dialog" aria-describedby={undefined}>
              <header><Dialog.Title>{title}</Dialog.Title><Dialog.Close asChild><button type="button" aria-label="Close expanded preview">Close</button></Dialog.Close></header>
              <StaticMarkupPreview content={content} title={`Expanded ${title}`} height="calc(80vh - 64px)" className="note-static-markup__frame" />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </>}
    </div>
    {preview && <StaticMarkupPreview content={content} title={title} height={height} className="note-static-markup__frame" />}
  </div>
}
