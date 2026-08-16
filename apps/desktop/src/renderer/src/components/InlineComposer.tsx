import { insertComposerContent, replaceComposerRange, type ComposerInsertionHandle, type ComposerPasteImage } from '../lib/composer-insertion'
import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from 'react'
import { Decoration, Extension, Node, type Editor, type JSONContent } from '@tiptap/core'
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { ConversationImage, type ReadPastedImage } from './ConversationImage'
import { splitPastedImageReferences } from '../lib/pasted-image-reference'
import { composerKeywordMatches } from '../../../shared/composer-shortcut-library'
import { encodeSemanticReference, parseComposerDraft, type ComposerSemanticReference } from '../lib/composer-semantic-reference'

export function draftDocument(value: string): JSONContent {
  return { type: 'doc', content: value.split('\n').map((line) => ({
    type: 'paragraph', content: parseComposerDraft(line).flatMap((part): JSONContent[] => 'text' in part
      ? splitPastedImageReferences(part.text).map((segment) => segment.kind === 'image'
        ? { type: 'pastedImage', attrs: { text: segment.text, path: segment.path } }
        : { type: 'text', text: segment.text })
      : [{ type: 'toolReference', attrs: part.reference }])
  })) }
}

export function documentDraft(doc: JSONContent): string {
  if (doc.type === 'text') return doc.text ?? ''
  if (doc.type === 'pastedImage') return doc.attrs?.text ?? ''
  if (doc.type === 'toolReference') return encodeSemanticReference(doc.attrs as ComposerSemanticReference)
  if (doc.type === 'hardBreak') return '\n'
  return (doc.content ?? []).map(documentDraft).join(doc.type === 'doc' ? '\n' : '')
}

/**
 * 识别词的下划线。命中 keyword 的裸词在正文**原位**获得装饰，不改文档内容。
 *
 * `keywords` 是一个 **getter 而不是数组**：扩展只在编辑器构造时装一次（`useMemo(…, [])`），传数组等于
 * 把当时的配置冻在闭包里，用户在设置页加一条 keyword 后编辑器永远不认它。这正是本仓「替身写成常量
 * 会藏起被测性质」同一族——快照与实时读在开发时表现完全一样，只有改过配置才分岔。
 *
 * 走 `addDecorations` 而不是自己写 ProseMirror 插件：已装的 @tiptap/core 自带这个钩子，装饰是纯派生
 * 的视图状态，不进文档、不进 undo 栈、不进草稿字符串。
 */
export function keywordUnderlineExtension(keywords: () => readonly string[]) {
  return Extension.create({
    name: 'promptKeywordUnderline',
    addDecorations() {
      return {
        create: ({ state }) => {
          const current = keywords()
          if (current.length === 0) return []
          const decorations: Decoration[] = []
          state.doc.descendants((node, pos) => {
            if (!node.isText || !node.text) return
            for (const match of composerKeywordMatches(node.text, current)) {
              decorations.push(Decoration.Inline(pos + match.from, pos + match.to, {
                class: 'composer-keyword-hit',
                'data-composer-keyword': match.keyword
              }))
            }
          })
          return decorations
        }
      }
    }
  })
}

/** ProseMirror owns selection, composition and undo. Only our draft codec and reference node are custom. */
export function composerExtensions(
  onActivate?: (reference: ComposerSemanticReference) => void,
  keywords: () => readonly string[] = () => [],
  readPastedImage: ReadPastedImage = async () => null
) {
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
  }), Node.create({
    name: 'pastedImage', group: 'inline', inline: true, atom: true, selectable: true,
    addAttributes() { return { text: { default: '' }, path: { default: '' } } },
    renderHTML({ node }) { return ['span', { 'data-pasted-image': node.attrs.path }, node.attrs.text] },
    renderText({ node }) { return node.attrs.text },
    addNodeView() {
      return ReactNodeViewRenderer(({ node }) => <NodeViewWrapper as="span" className="composer-image" contentEditable={false}>
        <ConversationImage text={node.attrs.text} path={node.attrs.path} readPastedImage={readPastedImage} />
      </NodeViewWrapper>)
    }
  }), keywordUnderlineExtension(keywords)]
}

export type InlineComposerProps = {
  autoFocus?: boolean
  readPastedImage?: ReadPastedImage
  value: string
  onValueChange(value: string): void
  disabled: boolean
  placeholder: string
  'aria-label': string
  onKeyDown(event: KeyboardEvent, caret: number): void
  onPasteImage?: ComposerPasteImage
  insertionRef?: Ref<ComposerInsertionHandle>
  onActivateReference?: (reference: ComposerSemanticReference) => void
  // 要在正文里加下划线的识别词。每次渲染都可能是新数组，而扩展只装一次——所以下面读的是
  // `latest.current`，绝不把它捕进闭包（否则改了设置编辑器不跟着变）。
  keywords?: readonly string[]
}

export function InlineComposer(props: InlineComposerProps) {
  const editorRef = useRef<Editor | null>(null)
  const latest = useRef(props)
  latest.current = props
  const extensions = useMemo(() => composerExtensions(
    (reference) => latest.current.onActivateReference?.(reference),
    () => latest.current.keywords ?? [],
    (path) => latest.current.readPastedImage?.(path) ?? Promise.resolve(null)
  ), [])
  const editorProps = useMemo(() => ({
    attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-label': latest.current['aria-label'], 'data-placeholder': latest.current.placeholder },
    handleKeyDown: (view: any, event: KeyboardEvent) => {
      if (view.composing || event.isComposing || event.keyCode === 229) return false
      const before = view.state.doc.cut(0, view.state.selection.from)
      latest.current.onKeyDown(event, documentDraft(before.toJSON()).length)
      return event.defaultPrevented
    },
    handlePaste: (_view: any, event: ClipboardEvent) => {
      const editor = editorRef.current
      if (!editor || latest.current.disabled) return false
      const insert: ComposerInsertionHandle['insert'] = (resolve, options) => insertComposerContent(editor, resolve, draftDocument, options)
      const callback = latest.current.onPasteImage
      const file = [...(event.clipboardData?.items ?? [])].find((item) => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile()
      if (file && callback) {
        event.preventDefault()
        callback(file, insert)
        return true
      }
      const text = event.clipboardData?.getData('text/plain')
      if (text) {
        event.preventDefault()
        replaceComposerRange(editor, draftDocument(text))
        return true
      }
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
  editorRef.current = editor
  useImperativeHandle(props.insertionRef, () => ({
    insert: async (resolve, options) => {
      if (editor && !editor.isDestroyed) await insertComposerContent(editor, resolve, draftDocument, options)
    }
  }), [editor])
  useEffect(() => {
    if (props.autoFocus && editor && !editor.isDestroyed) editor.commands.focus()
  }, [editor, props.autoFocus])
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    // React node views flush synchronously. Apply external drafts after this effect has committed.
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled && !editor.isDestroyed && documentDraft(editor.getJSON()) !== props.value && !editor.view.composing) {
        const wasEmpty = editor.isEmpty
        editor.chain().setMeta('addToHistory', false).setContent(draftDocument(props.value), { emitUpdate: false }).run()
        if (wasEmpty) editor.commands.setTextSelection(editor.state.doc.content.size - 1)
      }
    })
    return () => { cancelled = true }
  }, [editor, props.value])
  // 改了设置页的 keyword 之后重算装饰。默认的 `update: 'document'` 只在**文档**变化时重跑，而这里变的
  // 是配置：不推这一下，用户新加的 keyword 要等到下次打字才划线，看起来就是"加了没用"。
  // 依赖用 join 出来的字符串而不是数组本身：取值层每次筛选都产出新数组，挂数组等于每次渲染都重算。
  // 分隔符取 `\n` 而不是 NUL：keyword 只允许 [A-Za-z0-9_-]，两者都不可能出现在词里，但本仓有一条
  // 守卫按「含 NUL 即视为二进制」跳过文件，源码里放一个 NUL 会让这个文件被参考项目名扫描静默豁免。
  const keywordKey = (props.keywords ?? []).join('\n')
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.commands.updateDecorations()
  }, [editor, keywordKey])
  return <div className="composer__editor" data-placeholder={props.placeholder} data-disabled={props.disabled}>
    <EditorContent editor={editor} />
    {!editor && props.value ? <span className="composer__editor-fallback">{props.value}</span> : null}
  </div>
}
