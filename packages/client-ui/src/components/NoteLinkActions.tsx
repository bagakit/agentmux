import { useContext, useEffect, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { useNoteLinkOpener } from '../platform.js'
import { parseHttpLinkUrl } from '../lib/link-url.js'
import { NoteFileLinkContext, useNoteFileResource } from './NoteFileContext.js'

/** Link opening is a client action on the source resource, never a Renderer-relative URL. */
export function NoteLinkActions({ editor }: { editor: Editor | null }) {
  const resource = useNoteFileResource(), platformOpen = useNoteLinkOpener()
  const open = useContext(NoteFileLinkContext) ?? platformOpen
  const [issue, setIssue] = useState<string | null>(null)
  useEffect(() => {
    if (!editor) return
    let active = true, dom: HTMLElement | null = null
    setIssue(null)
    const activate = (event: MouseEvent | KeyboardEvent) => {
      const target = event.target as Element | null
      const anchor = target?.nodeType === 1 ? target.closest<HTMLAnchorElement>('a[href]') : null
      if (!anchor || anchor.closest('.ProseMirror') !== dom) return
      const control = target?.closest('button, input, textarea, select, [role="button"]')
      if (control && control !== anchor && anchor.contains(control)) {
        // Controls keep their own handlers and keyboard activation; a click must
        // not also perform the surrounding attachment anchor's default action.
        if (event.type === 'click' || event.type === 'auxclick') event.preventDefault()
        return
      }
      if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Enter') return
      if (event.type === 'auxclick' && (event as MouseEvent).button !== 1) return
      // A normal editing click places the caret; the schema Link view has no
      // independent window.open handler. Modified/middle clicks use the same owner.
      if (editor.isEditable && event.type !== 'auxclick' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); return }
      const href = anchor.getAttribute('href')!
      // A standalone reader retains normal external links. Relative file opening
      // needs its original host adapter, so it cannot navigate the Renderer by default.
      if (!open && parseHttpLinkUrl(href)) return
      event.preventDefault(); event.stopPropagation()
      if (!open) { setIssue('Original file navigation is unavailable here. The attachment address is kept.'); return }
      void open(resource, href).then(opened => {
        if (active) setIssue(opened ? null : 'This link could not be opened from its original file. Its address is kept.')
      }).catch(error => { if (active) setIssue(error instanceof Error ? error.message : String(error)) })
    }
    const detach = () => {
      dom?.removeEventListener('click', activate, true); dom?.removeEventListener('auxclick', activate, true); dom?.removeEventListener('keydown', activate, true)
      dom = null
    }
    const attach = () => {
      detach()
      // EditorContent may retain an editor before its view mounts or while moving
      // between workfaces. Mount/unmount events own this disposable DOM binding.
      if (editor.isDestroyed) return
      dom = editor.view.dom
      dom.addEventListener('click', activate, true); dom.addEventListener('auxclick', activate, true); dom.addEventListener('keydown', activate, true)
    }
    editor.on('mount', attach); editor.on('unmount', detach); attach()
    return () => { active = false; editor.off('mount', attach); editor.off('unmount', detach); detach() }
  }, [editor, open, resource?.hostId, resource?.workspaceId, resource?.workspacePath, resource?.path])
  return issue ? <p className="note-knowledge-notice" role="status">{issue} <button type="button" onClick={() => setIssue(null)}>Dismiss</button></p> : null
}
