import { useEffect, useMemo, useRef, type RefObject } from 'react'
import type { ComposerInsert, ComposerInsertionHandle } from '@agentmux/client-ui/composer-insertion'
import { appendFileReferences, appendSelectedFileReferences } from '@agentmux/client-ui/composer-file-reference'
import { PASTED_IMAGE_MIME_TYPES } from '@agentmux/client-ui/pasted-images'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { WorkbenchWindowDocument } from '../../../shared/workbench-windows'
import type { useComposerFeedback } from '../components/ComposerFeedback'
import { api } from './api'
import { focusWorkbenchWindow } from './workbench-windows'
import { selectScreenshotTarget, releaseScreenshotTarget } from './screenshot-shortcut-target'

/** Host resource IO only. The maintained editor owns insertion, selection, Undo and the draft. */
export function useComposerAttachments({ scope, hostId, workspacePath, disabled, insertion, feedback, document, onRemoteFiles, shortcutActive = true }: {
  scope: string; hostId: string | undefined; workspacePath: string | undefined; disabled: boolean
  insertion: RefObject<ComposerInsertionHandle | null>; feedback: ReturnType<typeof useComposerFeedback>
  document?: WorkbenchWindowDocument | undefined; onRemoteFiles?: (() => void) | undefined
  shortcutActive?: boolean
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
  const shortcutKey = JSON.stringify([scope, document?.windowId, document?.documentGeneration])
  const shortcutFocus = useRef<{ key: string; element: HTMLElement } | null>(null)
  async function captureImage(returnToDraft: boolean): Promise<void> {
    const originalEditor = insertion.current
    const originalFocus = shortcutFocus.current?.key === shortcutKey ? shortcutFocus.current.element : null
    if (returnToDraft && !originalFocus) throw new Error('Focus the intended Message Tool before taking a screenshot. Your draft is kept.')
    let savedPath: string | null = null
    await insertResolved(async () => {
      requireLocal()
      savedPath = await api.ui.captureScreenshot()
      if (savedPath && (!isCurrent() || insertion.current !== originalEditor)) {
        throw new Error(`The original message editor changed. The screenshot is saved at ${savedPath}; your drafts were not replaced. Reference this image from the intended Message Tool.`)
      }
      return savedPath ? appendFileReferences('', [savedPath]) : null
    })
    if (savedPath && returnToDraft && isCurrent() && insertion.current === originalEditor) {
      if (shortcut.current.key !== shortcutKey || !shortcut.current.enabled || !originalFocus?.isConnected) {
        throw new Error(`The screenshot was added to the original draft, but its workface is no longer selected. The image is saved at ${savedPath}. Return to that Message Tool to continue.`)
      }
      if (document) {
        if (!await focusWorkbenchWindow(document)) throw new Error(`The screenshot was added to the original draft, but returning to its window was not confirmed. The image is saved at ${savedPath}. Return to that Message Tool to continue.`)
        // The native receipt covers the window; return keyboard input to the same original control.
        if (shortcut.current.key !== shortcutKey || !shortcut.current.enabled || !originalFocus.isConnected) {
          throw new Error(`The screenshot is in the original draft, but the workface changed while returning. The image is saved at ${savedPath}. Return to that Message Tool to continue.`)
        }
        originalFocus.focus({ preventScroll: true })
        if (originalFocus.ownerDocument.activeElement !== originalFocus) throw new Error(`The screenshot is in the original draft, but its input focus was not confirmed. The image is saved at ${savedPath}. Return to that Message Tool to continue.`)
      }
      else throw new Error(`The screenshot was added to the original draft, but its window identity is unavailable. The image is saved at ${savedPath}. Return to that Message Tool to continue.`)
    }
  }
  const capture = () => captureImage(false)
  // A lease can follow rerenders of this same draft, but never a new scope or native document.
  const shortcut = useRef({ key: shortcutKey, enabled: false, capture: () => captureImage(true) })
  shortcut.current = { key: shortcutKey, enabled: shortcutActive && !disabled && hostId === 'local' && Boolean(document), capture: () => captureImage(true) }
  const shortcutTarget = useMemo(() => ({ capture(): Promise<void> {
    const current = shortcut.current
    if (current.key !== shortcutKey || !current.enabled) return Promise.reject(new Error('The original Message Tool is no longer available for this screenshot. Focus the intended local draft and try again.'))
    return current.capture()
  } }), [shortcutKey])
  useEffect(() => () => releaseScreenshotTarget(shortcutTarget), [shortcutTarget])
  useEffect(() => { if (!shortcut.current.enabled) releaseScreenshotTarget(shortcutTarget) }, [shortcutTarget, shortcutActive, disabled, hostId])
  const claimScreenshotTarget = (event?: { target: EventTarget | null }) => {
    const element = event?.target as HTMLElement | null | undefined
    if (shortcut.current.enabled && element?.nodeType === 1 && typeof element.focus === 'function') {
      shortcutFocus.current = { key: shortcutKey, element }
      selectScreenshotTarget(shortcutTarget)
    }
  }
  const referencePaths = (paths: readonly string[]) => feedback.run(() => insertResolved(() => appendSelectedFileReferences('', paths, workspacePath)))
  return { pasteImage, dropFiles, chooseFiles, capture, referencePaths, claimScreenshotTarget }
}
