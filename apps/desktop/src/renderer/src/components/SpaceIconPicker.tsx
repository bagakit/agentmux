import * as Dialog from '@radix-ui/react-dialog'
import { useLayoutEffect, useRef, useState } from 'react'
import { Check, ImagePlus, RotateCcw, Smile, Shapes } from 'lucide-react'
import { SPACE_ICON_CATALOG, type SpaceIconChoice, type SpaceIconId, type SpaceIconTarget } from '../lib/space-object-appearance'
import { DEFAULT_MOTE_FACE, isMoteFace, MOTE_AVATAR_INPUT_MAX_BYTES, type MoteAvatarInput } from '../../../shared/mote-avatars'
import { api } from '../lib/api'
import { presentError } from '../lib/error-presentation'
import { useAppStore } from '../store'
import { MoteAvatarCrop } from './MoteAvatarCrop'
import { MoteFaceEditor } from './MoteFaceEditor'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { LiquidSelectionSurface } from './settings/LiquidSelectionSurface'
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
  const [editingFace, setEditingFace] = useState(false)
  const [faceDraft, setFaceDraft] = useState(DEFAULT_MOTE_FACE)
  const [alternativeDraft, setAlternativeDraft] = useState<SpaceIconChoice | null>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const returnKey = useRef<string | null>(null)
  const editor = useRef<object>({}), inputRequest = useRef<object>({})
  const currentTarget = useRef(target); currentTarget.current = target
  useLayoutEffect(() => {
    editor.current = {}; inputRequest.current = {}
    if (target) returnKey.current = target.key
    const saved = target ? useAppStore.getState().spaceObjectIcons[target.key] ?? null : null
    const face = isMoteFace(saved) ? saved : { ...DEFAULT_MOTE_FACE }
    setFaceDraft(face); setAlternativeDraft(isMoteFace(saved) ? null : saved)
    setDraft(target?.avatarTarget ? face : saved)
    setEditingFace(Boolean(target?.avatarTarget))
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
      if (current()) { setEditingFace(false); setPreviewReady(false); setPreview(previous => ({ dataUrl: value.dataUrl, revision: (previous?.revision ?? 0) + 1 })) }
    } catch (cause) { if (current()) { setErrorStep('prepare'); setError(presentError(cause)) } }
    finally { if (current()) setPreparing(false) }
  }
  async function save(): Promise<void> {
    if (!target || busy || preparing || !editingFace && preview && !previewReady) return
    const original = target, session = editor.current
    const current = () => editor.current === session && currentTarget.current?.key === original.key
    setBusy(true); setError(null)
    try {
      let choice = draft
      if (!editingFace && preview && original.avatarTarget) {
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
    inputRequest.current = {}; setPreparing(false); setDraft(choice); setError(null)
    if (isMoteFace(choice)) setFaceDraft(choice)
    else { setAlternativeDraft(choice); setPreview(null); setPreviewReady(false) }
  }
  const source = (face: boolean) => {
    inputRequest.current = {}; setPreparing(false); setError(null); setEditingFace(face)
    setDraft(face ? faceDraft : alternativeDraft)
  }
  return <Dialog.Root open={target !== null} onOpenChange={open => { if (!open && !busy) onClose() }}>
    <Dialog.Portal container={resolveOverlayContainer()}>
      <Dialog.Overlay className="space-icon-picker__overlay dialog-scrim" />
      <Dialog.Content className={`space-icon-picker dialog-surface${target?.avatarTarget ? ' space-icon-picker--avatar' : ''}`} onEscapeKeyDown={event => { if (busy) event.preventDefault() }}
        onInteractOutside={event => { if (busy) event.preventDefault() }}
        onCloseAutoFocus={event => {
          event.preventDefault()
          const row = returnFocus?.() ?? [...document.querySelectorAll<HTMLElement>('[data-space-icon-target]')]
            .find(node => node.dataset.spaceIconTarget === returnKey.current)
          row?.focus()
        }}>
        <header className="space-icon-picker__header">
          <Dialog.Title className="space-icon-picker__title">{target?.avatarTarget ? 'Change avatar' : 'Change icon'}</Dialog.Title>
          <Dialog.Description className="space-icon-picker__description">{target?.name}</Dialog.Description>
        </header>
        {target?.avatarTarget ? <>
          <div className="mote-avatar-source" role="group" aria-label="Mote avatar style">
            <LiquidSelectionSurface selected={editingFace ? 'face' : 'alternative'} active={target !== null} targetAttribute="data-avatar-source" />
            <button type="button" data-avatar-source="face" aria-pressed={editingFace} disabled={busy} onClick={() => source(true)}><Smile size={15} />Make a face<Check size={12} className="mote-avatar-selection-mark" aria-hidden="true" /></button>
            <button type="button" data-avatar-source="alternative" aria-pressed={!editingFace} disabled={busy} onClick={() => source(false)}><Shapes size={15} />Icon or image<Check size={12} className="mote-avatar-selection-mark" aria-hidden="true" /></button>
          </div>
          <MoteFaceEditor face={faceDraft} visible={editingFace} disabled={busy} onChange={select} />
          <div className="mote-avatar-alternative" hidden={editingFace}>
            {preview ? <MoteAvatarCrop key={preview.revision} source={preview.dataUrl} canvasRef={canvas} disabled={busy || preparing}
              onReady={() => setPreviewReady(true)} onError={cause => { setErrorStep('prepare'); setError(cause) }} /> : <div className="mote-avatar-preview" role="img" aria-label="Your Mote avatar preview">
              <SpaceObjectIcon kind="mote" name={target.name} manualIcon={alternativeDraft} avatarWorkspaceId={target.avatarTarget.workspaceId}
                avatarTopicId={target.avatarTarget.topicId} avatarObjectKey={target.key} />
            </div>}
            <label className="small-button mote-avatar-file"><ImagePlus size={15} />Upload image
              <input aria-label="Choose Mote image" type="file" accept="image/png,image/jpeg" disabled={busy}
                onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void prepare(file) }} />
              <span>PNG or JPG · up to 8 MB</span>
            </label>
            {preparing ? <p className="space-icon-picker__description" role="status">Preparing image…</p> : null}
          </div>
        </> : null}
        {!editingFace ? <div className="space-icon-picker__choices" role="group" aria-label="Icon choices">
          {(Object.entries(SPACE_ICON_CATALOG) as Array<[SpaceIconId, typeof SPACE_ICON_CATALOG[SpaceIconId]]>).map(([id, { Icon, label }]) =>
            <button key={id} type="button" className="space-icon-picker__choice" aria-label={`${label} icon`}
              title={label} aria-pressed={!preview && draft === id} data-space-icon-choice={id} disabled={busy}
              onClick={() => select(id)}><Icon size={18} /></button>)}
        </div> : null}
        <button type="button" className="small-button space-icon-picker__automatic" aria-pressed={!editingFace && !preview && draft === null}
          disabled={busy} onClick={() => { select(null); setEditingFace(false) }}><RotateCcw size={13} />Restore automatic</button>
        {error ? <p className="space-icon-picker__error" role="alert">{errorStep === 'save' ? 'Saving is unconfirmed. Your choice is kept; retry saving.' : 'Image preparation failed. Your current avatar is unchanged; choose image again.'} {error}</p> : null}
        <footer>
          <button type="button" className="small-button" disabled={busy} onClick={onClose}>{error && errorStep === 'save' ? 'Close' : 'Cancel'}</button>
          <button type="button" className={`${target?.avatarTarget ? 'primary-button' : 'small-button'} space-icon-picker__save`} aria-label={target?.avatarTarget ? editingFace ? 'Save face' : 'Save avatar' : 'Save icon'} disabled={busy || preparing || Boolean(!editingFace && preview && !previewReady)} onClick={() => void save()}>
            {busy ? 'Saving…' : error && errorStep === 'save' ? 'Retry saving' : target?.avatarTarget ? editingFace ? 'Save face' : 'Save avatar' : 'Save icon'}
          </button>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
