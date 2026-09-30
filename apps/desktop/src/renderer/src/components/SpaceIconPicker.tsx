import * as Dialog from '@radix-ui/react-dialog'
import { useLayoutEffect, useRef, useState } from 'react'
import { ImagePlus, RotateCcw } from 'lucide-react'
import { SPACE_ICON_CATALOG, type SpaceIconChoice, type SpaceIconId, type SpaceIconTarget } from '../lib/space-object-appearance'
import { MOTE_AVATAR_INPUT_MAX_BYTES, type MoteAvatarInput } from '../../../shared/mote-avatars'
import { api } from '../lib/api'
import { presentError } from '../lib/error-presentation'
import { useAppStore } from '../store'
import { MoteAvatarCrop } from './MoteAvatarCrop'
import { resolveOverlayContainer } from './WindowOverlayHost'

/** Shared chooser; drafts stay local until Save, authored metadata has the existing store owner. */
export function SpaceIconPicker({ target, onClose, returnFocus }: {
  target: SpaceIconTarget | null; onClose(): void; returnFocus?: () => HTMLElement | null
}) {
  const [draft, setDraft] = useState<SpaceIconChoice | null>(null)
  const [preview, setPreview] = useState<{ dataUrl: string; revision: number } | null>(null)
  const [previewReady, setPreviewReady] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorStep, setErrorStep] = useState<'prepare' | 'save'>('save')
  const canvas = useRef<HTMLCanvasElement>(null)
  const returnKey = useRef<string | null>(null)
  const editor = useRef<object>({}), inputRequest = useRef<object>({})
  const currentTarget = useRef(target); currentTarget.current = target
  useLayoutEffect(() => {
    editor.current = {}; inputRequest.current = {}
    if (target) returnKey.current = target.key
    setDraft(target ? useAppStore.getState().spaceObjectIcons[target.key] ?? null : null)
    setPreview(null); setPreviewReady(false); setPreparing(false); setBusy(false); setError(null)
    return () => { editor.current = {}; inputRequest.current = {} }
  }, [target?.key])

  async function prepare(file: File): Promise<void> {
    const original = target, session = editor.current, request = {}; inputRequest.current = request
    if (!original?.avatarTarget) return
    setPreparing(true); setError(null)
    const current = () => editor.current === session && inputRequest.current === request && currentTarget.current?.key === original.key
    try {
      if (file.size === 0 || file.size > MOTE_AVATAR_INPUT_MAX_BYTES) throw new Error('Choose an image up to 8 MB.')
      if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('Choose a static PNG or JPEG image.')
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onerror = () => reject(new Error('This image could not be read.'))
        reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(file)
      })
      const value = await api.scratch.previewMoteAvatar(original.avatarTarget.workspaceId, original.avatarTarget.topicId, { mimeType: file.type, dataUrl } as MoteAvatarInput, original.avatarTarget.objectKey)
      if (current()) { setPreviewReady(false); setPreview(previous => ({ dataUrl: value.dataUrl, revision: (previous?.revision ?? 0) + 1 })) }
    } catch (cause) { if (current()) { setErrorStep('prepare'); setError(presentError(cause)) } }
    finally { if (current()) setPreparing(false) }
  }
  async function save(): Promise<void> {
    if (!target || busy || preparing || preview && !previewReady) return
    const original = target, session = editor.current
    const current = () => editor.current === session && currentTarget.current?.key === original.key
    setBusy(true); setError(null)
    try {
      let choice = draft
      if (preview && original.avatarTarget) {
        if (!canvas.current) throw new Error('The avatar preview is not ready. Select the image again.')
        choice = await api.scratch.saveMoteAvatar(original.avatarTarget.workspaceId, original.avatarTarget.topicId, { mimeType: 'image/png', dataUrl: canvas.current.toDataURL('image/png') }, original.avatarTarget.objectKey)
      }
      // A completed asset belongs to the submitted object, but a replaced editor cannot publish it.
      if (!current()) return
      await useAppStore.getState().setSpaceObjectIcon(original.key, choice)
      if (current()) onClose()
    } catch (cause) { if (current()) { setErrorStep('save'); setError(presentError(cause)) } }
    finally { if (current()) setBusy(false) }
  }
  const select = (choice: SpaceIconChoice | null) => {
    inputRequest.current = {}; setPreparing(false); setDraft(choice); setPreview(null); setPreviewReady(false); setError(null)
  }
  return <Dialog.Root open={target !== null} onOpenChange={open => { if (!open && !busy) onClose() }}>
    <Dialog.Portal container={resolveOverlayContainer()}>
      <Dialog.Overlay className="space-icon-picker__overlay dialog-scrim" />
      <Dialog.Content className="space-icon-picker dialog-surface" onEscapeKeyDown={event => { if (busy) event.preventDefault() }}
        onInteractOutside={event => { if (busy) event.preventDefault() }}
        onCloseAutoFocus={event => {
          event.preventDefault()
          const row = returnFocus?.() ?? [...document.querySelectorAll<HTMLElement>('[data-space-icon-target]')]
            .find(node => node.dataset.spaceIconTarget === returnKey.current)
          row?.focus()
        }}>
        <Dialog.Title className="space-icon-picker__title">{target?.avatarTarget ? 'Avatar' : 'Icon'} for {target?.name}</Dialog.Title>
        <Dialog.Description className="space-icon-picker__description">{target?.avatarTarget ? 'Choose an image or icon. Your current avatar stays until you save.' : 'Choose an icon. Restore automatic to use the default.'}</Dialog.Description>
        {target?.avatarTarget ? <>
          <label className="small-button mote-avatar-file"><ImagePlus size={14} />Choose image
            <input aria-label="Choose Mote image" type="file" accept="image/png,image/jpeg" disabled={busy}
              onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void prepare(file) }} />
          </label>
          {preparing ? <p className="space-icon-picker__description" role="status">Preparing image…</p> : null}
          {preview ? <MoteAvatarCrop key={preview.revision} source={preview.dataUrl} canvasRef={canvas} disabled={busy || preparing}
            onReady={() => setPreviewReady(true)} onError={cause => { setErrorStep('prepare'); setError(cause) }} /> : null}
        </> : null}
        <div className="space-icon-picker__choices" role="group" aria-label="Icon choices">
          {(Object.entries(SPACE_ICON_CATALOG) as Array<[SpaceIconId, typeof SPACE_ICON_CATALOG[SpaceIconId]]>).map(([id, { Icon, label }]) =>
            <button key={id} type="button" className="space-icon-picker__choice" aria-label={`${label} icon`}
              title={label} aria-pressed={!preview && draft === id} data-space-icon-choice={id} disabled={busy}
              onClick={() => select(id)}><Icon size={18} /></button>)}
        </div>
        <button type="button" className="small-button space-icon-picker__automatic" aria-pressed={!preview && draft === null}
          disabled={busy} onClick={() => select(null)}><RotateCcw size={13} />Restore automatic</button>
        {error ? <p className="space-icon-picker__error" role="alert">{errorStep === 'save' ? 'Saving is unconfirmed. Your choice is kept; retry saving.' : 'Image preparation failed. Your current avatar is unchanged; choose image again.'} {error}</p> : null}
        <footer>
          <button type="button" className="small-button" disabled={busy} onClick={onClose}>{error && errorStep === 'save' ? 'Close' : 'Cancel'}</button>
          <button type="button" className="small-button space-icon-picker__save" disabled={busy || preparing || Boolean(preview && !previewReady)} onClick={() => void save()}>
            {busy ? 'Saving…' : error && errorStep === 'save' ? 'Retry saving' : target?.avatarTarget ? 'Save avatar' : 'Save icon'}
          </button>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
