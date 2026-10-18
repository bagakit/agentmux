import { mintObjectId } from '@agentmux/core/object-id'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor, EditorEvents } from '@tiptap/core'
import type { NoteResource } from '@agentmux/core/notebook-catalog'
import { FILE_IMPORT_MAX_BYTES, fileUploadRevision, parseFileImportResult, parseFileReadResult } from '@agentmux/core/files'
import { api } from './api'
import { noteResourceReadParams } from './note-history-target'
import { scratchTopicsForConfig } from './scratch-topic-snapshots'
import { useAppStore } from '../store'
import { workspaceFilePreviewFormat } from '../../../shared/workspace-file-preview'

function base64(bytes: Uint8Array): string {
  let text = ''
  for (let offset = 0; offset < bytes.length; offset += 32768) text += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
  return btoa(text)
}

/** Files owns durable bytes; this hook only places confirmed relative references in the current draft. */
export function useNoteAttachments(resource: NoteResource | undefined) {
  const [issue, setIssue] = useState<string | null>(null), [pending, setPending] = useState(false)
  const active = useRef(true), busy = useRef(false), currentKey = useRef(''), generation = useRef(0)
  const key = JSON.stringify(resource ?? null)
  if (currentKey.current !== key) { currentKey.current = key; generation.current += 1 }
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const importFiles = useCallback((files: readonly File[], editor: Editor): void => {
    if (!files.length) return
    if (busy.current) { setIssue('An attachment import is still running. Keep this new selection and choose it again when the current import finishes. Other editing remains available.'); return }
    if (!resource || editor.isDestroyed || !editor.isEditable) { setIssue('The original Note file is unavailable. Keep your selected files; the draft is retained.'); return }
    busy.current = true; setPending(true); setIssue(null)
    const originalGeneration = generation.current
    let bookmark = editor.state.selection.getBookmark(), valid = true
    const map = ({ transaction }: EditorEvents['transaction']) => { bookmark = bookmark.map(transaction.mapping) }
    editor.on('transaction', map)
    const unsubscribe = useAppStore.subscribe((next, previous) => {
      if (next.config === previous.config) return
      const workspace = next.config?.workspaces.find(item => item.id === resource.workspaceId)
      if (!workspace || workspace.hostId !== resource.hostId || workspace.path !== resource.workspacePath) valid = false
    })
    const current = () => valid && active.current && generation.current === originalGeneration && currentKey.current === key && !editor.isDestroyed && editor.isEditable
    void (async () => {
      const problems: string[] = []
      for (const file of files) {
        let targetPath = '', operationId = ''
        try {
          if (!current()) throw Error('The original Note changed before insertion. Its draft is retained.')
          if (file.size > FILE_IMPORT_MAX_BYTES) throw Error('The selected file exceeds the 4 MiB Files transfer budget.')
          operationId = mintObjectId()
          // A sibling needs no invented directory, and keeps the original file extension.
          const name = file.name.replace(/[\u0000-\u001f\u007f/\\]/gu, '_').slice(-120) || 'attachment'
          const filename = `attachment-${operationId}-${name}`
          const slash = resource.path.lastIndexOf('/')
          targetPath = `${slash < 0 ? '' : resource.path.slice(0, slash + 1)}${filename}`
          const state = useAppStore.getState()
          const target = noteResourceReadParams(state, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots) ?? [], { ...resource, path: targetPath })
          const observed = parseFileReadResult(await api.files.readPublic(target), target)
          if (observed.result.status !== 'deleted' || !observed.resource || observed.resource.path !== targetPath)
            throw Error('The exact attachment destination is not confirmed absent. No import was requested.')
          const bytes = new Uint8Array(await file.arrayBuffer())
          if (!current()) throw Error('The original Note changed before import. The selected file is retained.')
          const input = { ...target, expectedResource: observed.resource, expectedRevision: null, operationId,
            byteLength: bytes.byteLength, revision: fileUploadRevision(bytes), dataBase64: base64(bytes) } as const
          const receipt = parseFileImportResult(await api.files.importPublic(input), input)
          if (receipt.result.status !== 'written') throw Error(receipt.result.status === 'conflict'
            ? 'The attachment destination is occupied; its existing bytes were kept.' : receipt.result.message)
          if (!current()) throw Error('The file was imported, but the original Note changed. No reference was inserted.')
          const href = './' + encodeURIComponent(filename), selection = bookmark.resolve(editor.state.doc)
          const node = workspaceFilePreviewFormat(name)?.kind === 'image'
            ? editor.schema.nodes.image!.create({ src: href, alt: file.name, title: null })
            : editor.schema.text(file.name || 'Attachment', [editor.schema.marks.link!.create({ href })])
          editor.view.dispatch(editor.state.tr.setSelection(selection).replaceSelectionWith(node, false))
          // The transaction handler advances the bookmark for the next selected file.
        } catch (error) {
          problems.push(`${file.name || 'Attachment'}: ${error instanceof Error ? error.message : String(error)}${targetPath ? ` Target: ${targetPath}. Operation: ${operationId}.` : ''}`)
        }
      }
      if (active.current && problems.length) setIssue(problems.join('\n'))
    })().finally(() => { editor.off('transaction', map); unsubscribe(); busy.current = false; if (active.current) setPending(false) })
  }, [resource, key])
  return { importFiles, issue, pending, dismiss: () => setIssue(null) }
}
