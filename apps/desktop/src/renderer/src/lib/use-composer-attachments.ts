import { useRef, type RefObject } from 'react'
import type { ComposerInsert, ComposerInsertionHandle } from '@agentmux/client-ui/composer-insertion'
import { appendFileReferences, appendSelectedFileReferences } from '@agentmux/client-ui/composer-file-reference'
import { PASTED_IMAGE_MIME_TYPES } from '@agentmux/client-ui/pasted-images'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { WorkbenchWindowDocument } from '../../../shared/workbench-windows'
import type { useComposerFeedback } from '../components/ComposerFeedback'
import { api } from './api'

/** Host resource IO only. The maintained editor owns insertion, selection, Undo and the draft. */
export function useComposerAttachments({ scope, hostId, workspacePath, disabled, insertion, feedback, document, onRemoteFiles }: {
  scope: string; hostId: string | undefined; workspacePath: string | undefined; disabled: boolean
  insertion: RefObject<ComposerInsertionHandle | null>; feedback: ReturnType<typeof useComposerFeedback>
  document?: WorkbenchWindowDocument | undefined; onRemoteFiles?: (() => void) | undefined
}) {
  const latest = useRef({ scope, disabled })
  if (latest.current.scope !== scope) latest.current = { scope, disabled }
  else latest.current.disabled = disabled
  const target = latest.current
  const isCurrent = () => latest.current === target && !target.disabled && feedback.isCurrent()
  function requireLocal() {
    if (hostId !== 'local') throw new Error('This resource has not been transferred to the selected machine. Your draft is kept; use Files to reference a resource in that project.')
  }
  async function insertResolved(resolve: () => string | null | Promise<string | null>, insert?: ComposerInsert) {
    if (!isCurrent()) return
    const editor = insertion.current
    if (!editor) throw new Error('The original message editor is unavailable. Your draft is kept.')
    await (insert ?? editor.insert)(async () => {
      const value = await resolve()
      return isCurrent() && insertion.current === editor ? value : null
    }, { separate: true })
  }
  async function imageReference(file: File): Promise<string> {
    requireLocal()
    const extension = Object.entries(PASTED_IMAGE_MIME_TYPES).find(([, mime]) => mime === file.type)?.[0]
    if (!extension) throw new Error(`Image format ${file.type || 'unknown'} is not supported by the image saver.`)
    const path = await api.ui.savePastedImage({ bytes: new Uint8Array(await file.arrayBuffer()), extension })
    return appendFileReferences('', [path])
  }
  const pasteImage = (file: File, insert: ComposerInsert) => {
    void feedback.run(() => insertResolved(() => imageReference(file), insert))
  }
  const dropFiles = (files: readonly File[], insert: ComposerInsert) => {
    // Partial success has no whole-batch Retry: a retry must not insert successful files twice.
    feedback.dismiss()
    void (async () => {
      const failures: string[] = []
      try {
        await insertResolved(async () => {
          requireLocal()
          const references: string[] = []
          for (const file of files) {
            if (!isCurrent()) return null
            try {
              if (file.type.startsWith('image/')) references.push(await imageReference(file))
              else {
                const path = api.ui.pathForFile(file)
                if (!path) throw new Error('The original local file path is unavailable. Use Files to reference the original file.')
                references.push(appendSelectedFileReferences('', [path], workspacePath))
              }
            } catch (error) { failures.push(`${file.name || 'Resource'}: ${presentError(error)}`) }
          }
          return references.join(' ')
        }, insert)
        if (failures.length && isCurrent()) feedback.report(new Error(failures.join('\n')))
      } catch (error) { if (isCurrent()) feedback.report(error) }
    })()
  }
  const chooseFiles = () => feedback.run(async () => {
    if (hostId !== 'local') {
      if (onRemoteFiles) { onRemoteFiles(); return }
      requireLocal()
    }
    await insertResolved(async () => {
      const paths = await api.ui.chooseFiles(workspacePath ? { defaultPath: workspacePath } : undefined, document)
      return paths?.length ? appendSelectedFileReferences('', paths, workspacePath) : null
    })
  })
  const capture = () => insertResolved(async () => {
    requireLocal()
    const path = await api.ui.captureScreenshot()
    return path ? appendFileReferences('', [path]) : null
  })
  const referencePaths = (paths: readonly string[]) => feedback.run(() => insertResolved(() => appendSelectedFileReferences('', paths, workspacePath)))
  return { pasteImage, dropFiles, chooseFiles, capture, referencePaths }
}
