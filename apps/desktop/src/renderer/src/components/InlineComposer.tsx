import { useEffect, useMemo, useRef } from 'react'
import { Node, type JSONContent } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { encodeSemanticReference, parseComposerDraft, type ComposerSemanticReference } from '../lib/composer-semantic-reference'

export function draftDocument(value: string): JSONContent {
  return { type: 'doc', content: value.split('\n').map((line) => ({
    type: 'paragraph', content: parseComposerDraft(line).map((part) => 'text' in part
      ? { type: 'text', text: part.text }
      : { type: 'toolReference', attrs: part.reference })
  })) }
}

export function documentDraft(doc: JSONContent): string {
  if (doc.type === 'text') return doc.text ?? ''
  if (doc.type === 'toolReference') return encodeSemanticReference(doc.attrs as ComposerSemanticReference)
  if (doc.type === 'hardBreak') return '\n'
  return (doc.content ?? []).map(documentDraft).join(doc.type === 'doc' ? '\n' : '')
}

/** ProseMirror owns selection, composition and undo. Only our draft codec and reference node are custom. */
export function composerExtensions(onActivate?: (reference: ComposerSemanticReference) => void) {
  return [StarterKit.configure({
    blockquote: false, bold: false, bulletList: false, code: false, codeBlock: false,
    dropcursor: false, gapcursor: false, heading: false, horizontalRule: false,
    italic: false, link: false, listItem: false, listKeymap: false, orderedList: false,
    strike: false, underline: false, trailingNode: false
  }), Node.create({
    name: 'toolReference', group: 'inline', inline: true, atom: true, selectable: true,
    addAttributes() { return { token: { default: '' }, label: { default: '' }, kind: { default: 'skill' }, reference: { default: '' } } },
    renderHTML({ node }) { return ['span', { 'data-tool-reference': '', class: `composer-semantic-token composer-semantic-token--${node.attrs.kind}` }, node.attrs.label] },
    renderText({ node }) { return encodeSemanticReference(node.attrs as ComposerSemanticReference) },
    addNodeView() {
      return ({ node, editor, getPos }) => {
        const reference = node.attrs as ComposerSemanticReference
        const dom = document.createElement('button')
        dom.type = 'button'
        dom.contentEditable = 'false'
        dom.className = `composer-semantic-token composer-semantic-token--${reference.kind}`
        dom.dataset.toolReference = reference.kind
        dom.textContent = `${reference.kind === 'component' ? '◇' : reference.kind === 'subcommand' ? '›' : '$'} ${reference.label}`
        dom.title = `${reference.kind === 'subcommand' ? 'Expand prompt' : 'Open reference'}: ${reference.reference}`
        dom.setAttribute('aria-label', dom.title)
        dom.addEventListener('click', () => {
          if (reference.kind === 'subcommand') {
            const pos = getPos()
            if (typeof pos === 'number') editor.chain().focus().insertContentAt({ from: pos, to: pos + node.nodeSize }, draftDocument(reference.reference).content ?? []).run()
          } else onActivate?.(reference)
        })
        return { dom, stopEvent: (event) => event.type === 'click' }
      }
    }
  })]
}

export type InlineComposerProps = {
  value: string
  onValueChange(value: string): void
  disabled: boolean
  placeholder: string
  'aria-label': string
  onKeyDown(event: KeyboardEvent, caret: number): void
  onPasteImage?: (image: { bytes: Uint8Array; extension: string }) => void
  onActivateReference?: (reference: ComposerSemanticReference) => void
}

export function InlineComposer(props: InlineComposerProps) {
  const latest = useRef(props)
  latest.current = props
  const extensions = useMemo(() => composerExtensions((reference) => latest.current.onActivateReference?.(reference)), [])
  const editorProps = useMemo(() => ({
    attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-label': latest.current['aria-label'], 'data-placeholder': latest.current.placeholder },
    handleKeyDown: (view: any, event: KeyboardEvent) => {
      if (view.composing || event.isComposing || event.keyCode === 229) return false
      const before = view.state.doc.cut(0, view.state.selection.from)
      latest.current.onKeyDown(event, documentDraft(before.toJSON()).length)
      return event.defaultPrevented
    },
    handlePaste: (_view: any, event: ClipboardEvent) => {
      const callback = latest.current.onPasteImage
      const file = [...(event.clipboardData?.items ?? [])].find((item) => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile()
      if (file && callback) { event.preventDefault(); void file.arrayBuffer().then((buffer) => callback({ bytes: new Uint8Array(buffer), extension: file.type.slice(6).split('+')[0] ?? 'png' })); return true }
      const text = event.clipboardData?.getData('text/plain')
      if (text !== undefined) { latest.current.onValueChange(text); return true }
      return false
    },
    clipboardTextSerializer: (slice: any) => documentDraft({ type: 'doc', content: slice.content.toJSON() })
  }), [])
  const onUpdate = useMemo(() => ({ editor }: { editor: any }) => { const value = documentDraft(editor.getJSON()); if (value !== latest.current.value) latest.current.onValueChange(value) }, [])
  const editor = useEditor({
    immediatelyRender: false,
    extensions,
    content: draftDocument(''),
    editable: !props.disabled,
    onUpdate,
    editorProps
  })
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    if (documentDraft(editor.getJSON()) !== props.value && !editor.view.composing) editor.commands.setContent(draftDocument(props.value), { emitUpdate: false })
  }, [editor, props.value])
  return <div className="composer__editor" data-placeholder={props.placeholder} data-disabled={props.disabled}>
    <EditorContent editor={editor} />
    {!editor && props.value ? <span className="composer__editor-fallback">{props.value}</span> : null}
  </div>
}
