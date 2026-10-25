import { encodeSelectedImageReference } from '@agentmux/client-ui/composer-semantic-reference'
import type { AgentSessionControl } from '../../../shared/contracts'
import { useEffect, useMemo, useRef, type RefObject } from 'react'
import type { ComposerInsert, ComposerInsertionHandle } from '@agentmux/client-ui/composer-insertion'
import { appendFileReferences, appendSelectedFileReferences } from '@agentmux/client-ui/composer-file-reference'
import { PASTED_IMAGE_MIME_TYPES } from '@agentmux/client-ui/pasted-images'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { WorkbenchWindowDocument } from '../../../shared/workbench-windows'
import type { useComposerFeedback } from '../components/ComposerFeedback'
import { api } from './api'
import { selectScreenshotTarget, releaseScreenshotTarget } from './screenshot-attachment'

/** Host resource IO only. The maintained editor owns insertion, selection, Undo and the draft. */
export function useComposerAttachments({ scope, sessionControl, hostId, workspacePath, fileResource, disabled, insertion, feedback, document, onRemoteFiles, shortcutActive = true }: {
  sessionControl?: AgentSessionControl | undefined
  scope: string; hostId: string | undefined; workspacePath: string | undefined; disabled: boolean
  /** Omitted for a single-context Launcher; null preserves an unconfirmed original resource. */
  fileResource?: { hostId: string; workspacePath: string } | null
  insertion: RefObject<ComposerInsertionHandle | null>; feedback: ReturnType<typeof useComposerFeedback>
  document?: WorkbenchWindowDocument | undefined; onRemoteFiles?: (() => void) | undefined
  shortcutActive?: boolean
}) {
  const latest = useRef({ scope, disabled })
  if (latest.current.scope !== scope) latest.current = { scope, disabled }
  else latest.current.disabled = disabled
  const target = latest.current
  const isCurrent = () => latest.current === target && !target.disabled && feedback.isCurrent()
  const files = fileResource === undefined ? { hostId, workspacePath } : fileResource
  function requireFileResource() {
    if (!files) throw new Error('The original project file Workspace is unconfirmed. Your draft and Agent are kept; restore its registered project to use Files.')
    return files
  }
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
  async function selectedImage(text: string, bytes: Uint8Array, mimeType: string): Promise<string> {
    if (!sessionControl) return text
    try {
      const selected = await api.ui.retainInputImage({ session: sessionControl, bytes, mimeType })
      if (selected.observation === 'unavailable') feedback.report(new Error('This image is saved locally; external sharing is not confirmed. Your message can still be sent.'))
      return encodeSelectedImageReference(text, selected.upload)
    }
    catch (error) { feedback.report(error); return text }
  }
  async function imageReference(file: File): Promise<string> {
    requireLocal()
    const extension = Object.entries(PASTED_IMAGE_MIME_TYPES).find(([, mime]) => mime === file.type)?.[0]
    if (!extension) throw new Error(`Image format ${file.type || 'unknown'} is not supported by the image saver.`)
    const bytes = new Uint8Array(await file.arrayBuffer())
    const path = await api.ui.savePastedImage({ bytes, extension })
    return selectedImage(appendFileReferences('', [path]), bytes, file.type)
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
          const references: string[] = []
          for (const file of files) {
            if (!isCurrent()) return null
            try {
              if (file.type.startsWith('image/')) references.push(await imageReference(file))
              else {
                const resource = requireFileResource()
                if (resource.hostId !== 'local') throw new Error('This local file has not been transferred to the project machine. Your draft is kept; use Files to reference a file in that project.')
                const path = api.ui.pathForFile(file)
                if (!path) throw new Error('The original local file path is unavailable. Use Files to reference the original file.')
                references.push(appendSelectedFileReferences('', [path], resource.workspacePath))
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
    const resource = requireFileResource()
    if (resource.hostId !== 'local') {
      if (onRemoteFiles) { onRemoteFiles(); return }
      throw new Error('The original project file browser is unavailable. Your draft is kept.')
    }
    await insertResolved(async () => {
      const paths = await api.ui.chooseFiles(resource.workspacePath ? { defaultPath: resource.workspacePath } : undefined, document)
      return paths?.length ? appendSelectedFileReferences('', paths, resource.workspacePath) : null
    })
  })
  const shortcutKey = JSON.stringify([scope, document?.windowId, document?.documentGeneration])
  const shortcutFocus = useRef<{ key: string; element: HTMLElement; editor: ComposerInsertionHandle | null } | null>(null)
  async function attachCapture(resolve: () => Promise<string | null>, documentKey?: string): Promise<void> {
    const originalEditor = insertion.current
    let savedPath: string | null = null
    try {
      await insertResolved(async () => {
        requireLocal()
        savedPath = await resolve()
        if (savedPath && (!isCurrent() || insertion.current !== originalEditor || documentKey !== undefined && shortcut.current.key !== documentKey)) {
          throw new Error('The original message editor changed; your drafts were not replaced.')
        }
        if (!savedPath) return null
        const text = appendFileReferences('', [savedPath])
        if (!sessionControl) return text
        const data = await api.ui.readPastedImage(savedPath)
        const match = data?.dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/u)
        return match ? await selectedImage(text, Uint8Array.from(atob(match[2]!), char => char.charCodeAt(0)), match[1]!) : text
      })
    } catch (cause) {
      if (savedPath) throw new Error(`Screenshot insertion into the original draft was not confirmed. The image is saved at ${savedPath}. ${presentError(cause)} Check the original draft and reference this image there if needed.`, { cause })
      throw cause
    }
  }
  const capture = () => attachCapture(() => api.ui.captureScreenshot(), shortcutKey)
  const shortcut = useRef({ key: shortcutKey, enabled: false, document, attachCapture })
  shortcut.current = { key: shortcutKey, enabled: shortcutActive && !disabled && hostId === 'local' && Boolean(document), document, attachCapture }
  const shortcutTarget = useMemo(() => ({ prepare() {
    const current = shortcut.current, focus = shortcutFocus.current
    if (current.key !== shortcutKey || !current.enabled || !current.document || !focus || focus.key !== shortcutKey ||
      focus.editor !== insertion.current || !focus.element.isConnected || focus.element.getAttribute('contenteditable') !== 'true' ||
      !focus.element.ownerDocument.hasFocus() || !focus.element.contains(focus.element.ownerDocument.activeElement)) return null
    let deliver!: (path: string | null) => void
    const image = new Promise<string | null>(resolve => { deliver = resolve })
    // Calling insert now pins the maintained editor's bookmark before any native UI opens.
    const inserted = current.attachCapture(() => image, shortcutKey)
    void inserted.catch(() => {}) // Main consumes this same outcome in complete; never replay it.
    return { document: current.document, complete(path: string | null) { deliver(path); return inserted } }
  } }), [shortcutKey])
  useEffect(() => () => releaseScreenshotTarget(shortcutTarget), [shortcutTarget])
  useEffect(() => { if (!shortcut.current.enabled) releaseScreenshotTarget(shortcutTarget) }, [shortcutTarget, shortcutActive, disabled, hostId])
  const claimScreenshotTarget = (event?: { target: EventTarget | null }) => {
    const element = event?.target as HTMLElement | null | undefined
    if (element?.nodeType !== 1) return
    // HTML editing semantics identify the actual message input; toolbar focus is not input focus.
    const editable = element.closest<HTMLElement>('[contenteditable="true"]')
    if (editable && shortcut.current.enabled) {
      shortcutFocus.current = { key: shortcutKey, element: editable, editor: insertion.current }
      selectScreenshotTarget(shortcutTarget)
    } else selectScreenshotTarget(null)
  }
  const referencePaths = (paths: readonly string[]) => feedback.run(() => insertResolved(() => appendSelectedFileReferences('', paths, requireFileResource().workspacePath)))
  return { pasteImage, dropFiles, chooseFiles, capture, referencePaths, claimScreenshotTarget }
}
