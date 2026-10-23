import { mintObjectId } from '@agentmux/core/object-id'
import { useWorkbenchDocument } from '../lib/workbench-document'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { useLayoutEffect, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { SPACE_ICON_CATALOG, type SpaceIconChoice, type SpaceIconId, type SpaceIconTarget } from '../lib/space-object-appearance'
import { DEFAULT_MOTE_FACE, isMoteFace, MOTE_AVATAR_INPUT_MAX_BYTES, type MoteAvatarInput } from '../../../shared/mote-avatars'
import { api } from '../lib/api'
import { isMoteAvatarSeriesChoice, type MoteAvatarSeriesChoice } from '@agentmux/core/mote-avatar-series'
import type { MoteAvatarRead, MoteAvatarSave } from '@agentmux/core/mote-avatar-write'
import { isSpaceIconChoice } from '../../../shared/space-object-appearance'
import { MoteAvatarSeriesEditor, type MoteAvatarSeriesDraft } from './MoteAvatarSeriesEditor'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useAppStore } from '../store'
import { MoteAvatarCrop, type MoteAvatarCropFrame } from './MoteAvatarCrop'
import { MoteAvatarImageGallery, MoteSilhouetteArt, type MoteGallerySelectionMeta } from './MoteAvatarImageGallery'
import { MoteFaceEditor } from './MoteFaceEditor'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { LiquidSelectionSurface } from './LiquidSelectionSurface'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { keepMoteAvatarSaveDraft, moteAvatarSaveRequestHash, readMoteAvatarSaveDraft, retireMoteAvatarSaveDraft } from '../lib/mote-avatar-save-draft'

type SeriesSaveAttempt = { request: MoteAvatarSave; state: 'unsent' | 'unknown' | 'refused' | 'saved'; issue: string }
const pickerIdentity = (target: SpaceIconTarget | null) => JSON.stringify([target?.key, target?.avatarTarget ?? null, target?.imageTarget ?? null])
function freezeSeriesSave(request: MoteAvatarSave): MoteAvatarSave {
  const frozen = structuredClone(request)
  const freeze = (value: object) => { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); Object.freeze(value) }
  freeze(frozen)
  return frozen
}

const ThemeObjectProfileIcon = semanticIconComponent('object.profile')
const ThemeObjectShapesIcon = semanticIconComponent('object.shapes')
const ThemeActionAddImageIcon = semanticIconComponent('action.add-image')
const ThemeActionRestoreDefaultsIcon = semanticIconComponent('action.restore-defaults')
const ThemeObjectLibraryIcon = semanticIconComponent('object.library')

/** Shared chooser; drafts stay local until Save, authored metadata has the existing store owner. */
export function SpaceIconPicker({ target, onClose, returnFocus }: {
  target: SpaceIconTarget | null; onClose(): void; returnFocus?: () => HTMLElement | null
}) {
  const ownerDocument = useWorkbenchDocument()
  const [draft, setDraft] = useState<SpaceIconChoice | null>(null)
  const [preview, setPreview] = useState<({ dataUrl: string; revision: number } & Partial<MoteGallerySelectionMeta>) | null>(null)
  const [cropFrame, setCropFrame] = useState<MoteAvatarCropFrame>({ zoom: 1, offsetX: 0, offsetY: 0 })
  const [shuffleRevision, setShuffleRevision] = useState(0)
  const [previewReady, setPreviewReady] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorStep, setErrorStep] = useState<'prepare' | 'save'>('save')
  const [mode, setMode] = useState<'face' | 'alternative' | 'series'>('alternative')
  const editingFace = mode === 'face', editingSeries = mode === 'series'
  const [seriesDraft, setSeriesDraft] = useState<MoteAvatarSeriesDraft | null>(null)
  const [seriesSeed, setSeriesSeed] = useState<Pick<MoteAvatarSeriesChoice, 'source' | 'definition' | 'parameters'> | null>(null)
  const [seriesPreparing, setSeriesPreparing] = useState(false)
  const [avatarBaseline, setAvatarBaseline] = useState<MoteAvatarRead | null>(null)
  const [avatarReading, setAvatarReading] = useState(false)
  const [avatarReadIssue, setAvatarReadIssue] = useState<string | null>(null)
  const [seriesImage, setSeriesImage] = useState<string | null>(null)
  const [seriesImageConfirmed, setSeriesImageConfirmed] = useState(false)
  const [seriesSeedReady, setSeriesSeedReady] = useState(false)
  const [seriesAttempt, setSeriesAttempt] = useState<SeriesSaveAttempt | null>(null)
  const [seriesStorageIssue, setSeriesStorageIssue] = useState<string | null>(null)
  const [faceDraft, setFaceDraft] = useState(DEFAULT_MOTE_FACE)
  const [alternativeDraft, setAlternativeDraft] = useState<SpaceIconChoice | null>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const returnKey = useRef<string | null>(null)
  const editor = useRef<object>({}), inputRequest = useRef<object>({})
  const avatarReadRequest = useRef<object>({}), avatarSeeded = useRef(false), localIntent = useRef(false)
  // These are submitted GUI requests, never another saved-choice or operation-fact owner.
  const unresolvedSeriesSaves = useRef(new Map<string, MoteAvatarSave>())
  const currentTarget = useRef(target); currentTarget.current = target
  const targetIdentity = pickerIdentity(target)
  useLayoutEffect(() => {
    editor.current = {}; inputRequest.current = {}; avatarReadRequest.current = {}; avatarSeeded.current = false; localIntent.current = false
    if (target) returnKey.current = target.key
    const saved = target ? useAppStore.getState().spaceObjectIcons[target.key] ?? null : null
    const face = isMoteFace(saved) ? saved : { ...DEFAULT_MOTE_FACE }
    const originalSaved: unknown = saved
    const series = isMoteAvatarSeriesChoice(originalSaved) ? originalSaved : null
    setFaceDraft(face); setAlternativeDraft(isMoteFace(saved) || series ? null : saved)
    setDraft(saved)
    setSeriesSeed(series); setSeriesDraft(null); setSeriesPreparing(false)
    setAvatarBaseline(null); setAvatarReadIssue(null); setSeriesImage(null); setSeriesImageConfirmed(false); setSeriesSeedReady(!target?.avatarTarget); setAvatarReading(false)
    const unresolved = target?.avatarTarget ? retainedSeriesRequest(target) : null
    setSeriesAttempt(unresolved ? { request: unresolved, state: 'unknown', issue: 'The original save is still unconfirmed.' } : null)
    if (unresolved) { setSeriesSeed(unresolved); setSeriesImage(unresolved.pngDataUrl) }
    setMode(unresolved || target?.avatarTarget && series ? 'series' : target?.avatarTarget && isMoteFace(saved) ? 'face' : 'alternative')
    setPreview(null); setCropFrame({ zoom: 1, offsetX: 0, offsetY: 0 }); setShuffleRevision(0); setPreviewReady(false); setPreparing(false); setBusy(false); setError(null)
    if (target?.avatarTarget) void readAvatarBaseline(target)
    return () => { editor.current = {}; inputRequest.current = {}; avatarReadRequest.current = {} }
  }, [targetIdentity])

  function retainedSeriesRequest(original: SpaceIconTarget): MoteAvatarSave | null {
    if (!original.avatarTarget) return null
    const identity = pickerIdentity(original)
    try {
      const stored = readMoteAvatarSaveDraft(original.avatarTarget)
      if (stored) unresolvedSeriesSaves.current.set(identity, freezeSeriesSave(stored))
      setSeriesStorageIssue(null)
    } catch (cause) { setSeriesStorageIssue(presentError(cause)) }
    return unresolvedSeriesSaves.current.get(identity) ?? null
  }

  async function retireSeriesRequest(request: MoteAvatarSave, original: SpaceIconTarget): Promise<string | null> {
    try {
      await retireMoteAvatarSaveDraft(request)
      const identity = pickerIdentity(original)
      if (unresolvedSeriesSaves.current.get(identity)?.operationId === request.operationId) unresolvedSeriesSaves.current.delete(identity)
      return null
    } catch (cause) { return presentError(cause) }
  }

  async function readAvatarBaseline(original: SpaceIconTarget, review = false): Promise<void> {
    if (!original.avatarTarget) return
    const session = editor.current, request = {}; avatarReadRequest.current = request
    const identity = pickerIdentity(original), submitted = retainedSeriesRequest(original)
    const current = () => editor.current === session && avatarReadRequest.current === request && pickerIdentity(currentTarget.current) === identity
    setAvatarReading(true)
    try {
      const value = await api.moteAvatars.read({ target: structuredClone(original.avatarTarget), ...(submitted ? { operationId: submitted.operationId } : {}) })
      if (!current()) return
      setAvatarBaseline(value); setAvatarReadIssue(value.issues.length ? value.issues.join('\n') : null)
      if (!avatarSeeded.current) {
        avatarSeeded.current = true
        const series = isMoteAvatarSeriesChoice(value.choice) ? value.choice : null
        setSeriesSeed(submitted ?? series); setSeriesImage(submitted?.pngDataUrl ?? value.image?.dataUrl ?? null)
        setSeriesImageConfirmed(!submitted && Boolean(series && value.image))
        if (submitted && !localIntent.current) setMode('series')
        else if (!localIntent.current && (isSpaceIconChoice(value.choice) || value.choice === null)) {
          const choice = value.choice as SpaceIconChoice | null
          const face = isMoteFace(choice) ? choice : { ...DEFAULT_MOTE_FACE }
          setDraft(choice); setFaceDraft(face); setAlternativeDraft(isMoteFace(choice) || series ? null : choice)
          setMode(series ? 'series' : isMoteFace(choice) ? 'face' : 'alternative')
        }
      }
      if (submitted && value.operation?.phase === 'published' && value.operation.durability === 'confirmed') {
        const requestHash = await moteAvatarSaveRequestHash(submitted)
        if (!current()) return
        if (requestHash !== value.operation.requestHash) {
          setSeriesAttempt({ request: submitted, state: 'unknown', issue: 'This receipt belongs to a different request body. Your original kept bytes and draft are retained.' })
          return
        }
        const issue = await retireSeriesRequest(submitted, original)
        if (!current()) return
        setSeriesStorageIssue(issue)
        setSeriesAttempt({ request: submitted, state: 'saved', issue: '' })
        await refreshSavedConfig(original, session, false)
      } else if (submitted) {
        setSeriesAttempt({ request: submitted, state: 'unknown', issue: value.operation?.issue ?? 'The original save is still unconfirmed.' })
      } else if (review) setSeriesAttempt(null)
    } catch (cause) { if (current()) setAvatarReadIssue(presentError(cause)) }
    finally {
      if (current()) { avatarSeeded.current = true; setSeriesSeedReady(true); setAvatarReading(false) }
    }
  }

  async function refreshSavedConfig(original: SpaceIconTarget, session: object, close: boolean): Promise<void> {
    const identity = pickerIdentity(original)
    const current = () => editor.current === session && pickerIdentity(currentTarget.current) === identity
    try {
      const config = await api.config.get()
      if (!current()) return
      // The current owner can already contain a later choice. Never publish the receipt's old choice again.
      useAppStore.getState().setConfig(config)
      if (close) onClose()
    } catch (cause) {
      if (current()) setSeriesAttempt(previous => previous ? { ...previous, state: 'saved', issue: presentError(cause) } : previous)
    }
  }

  async function submitSeriesSave(request: MoteAvatarSave, original: SpaceIconTarget): Promise<void> {
    const session = editor.current, identity = pickerIdentity(original)
    const current = () => editor.current === session && pickerIdentity(currentTarget.current) === identity
    unresolvedSeriesSaves.current.set(identity, request)
    setSeriesAttempt({ request, state: 'unsent', issue: '' }); setBusy(true); setError(null)
    try {
      try { await keepMoteAvatarSaveDraft(request) }
      catch (cause) {
        if (current()) { setSeriesStorageIssue(presentError(cause)); setSeriesAttempt({ request, state: 'unsent', issue: '' }) }
        return
      }
      if (current()) { setSeriesStorageIssue(null); setSeriesAttempt({ request, state: 'unknown', issue: '' }) }
      const value = await api.moteAvatars.save(request)
      if (value.state === 'saved' && value.operation?.requestHash !== await moteAvatarSaveRequestHash(request)) {
        if (current()) setSeriesAttempt({ request, state: 'unknown', issue: 'This receipt belongs to a different request body. Your original kept bytes and draft are retained.' })
        return
      }
      const storageIssue = value.state !== 'unknown' ? await retireSeriesRequest(request, original) : null
      if (!current()) return
      setSeriesStorageIssue(storageIssue)
      if (value.state === 'saved') {
        setSeriesAttempt({ request, state: 'saved', issue: '' })
        await refreshSavedConfig(original, session, !storageIssue)
      } else {
        setSeriesAttempt({ request, state: value.state, issue: value.issue ?? value.operation?.issue ?? (value.state === 'refused' ? 'Review the current avatar before saving this draft.' : 'The original save is still unconfirmed.') })
      }
    } catch (cause) { if (current()) setSeriesAttempt({ request, state: 'unknown', issue: presentError(cause) }) }
    finally { if (current()) setBusy(false) }
  }

  const supportsImages = Boolean(target?.avatarTarget || target?.imageTarget)
  async function prepare(file: File): Promise<void> {
    const original = target, session = editor.current, request = {}; inputRequest.current = request
    if (!original || !original.avatarTarget && !original.imageTarget) return
    localIntent.current = true
    setPreparing(true); setError(null)
    const current = () => editor.current === session && inputRequest.current === request && currentTarget.current?.key === original.key
    try {
      if (file.size === 0 || file.size > MOTE_AVATAR_INPUT_MAX_BYTES) throw new Error('Choose an image up to 8 MB.')
      if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('Choose a static PNG or JPEG image.')
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onerror = () => reject(new Error('This image could not be read.'))
        reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(file)
      })
      const input = { mimeType: file.type, dataUrl } as MoteAvatarInput
      const value = original.imageTarget ? await api.spaceObjects.previewAvatar(original.imageTarget, input)
        : await api.scratch.previewMoteAvatar(original.avatarTarget!.workspaceId, original.avatarTarget!.topicId, input, original.avatarTarget!.objectKey)
      if (current()) { setMode('alternative'); setPreviewReady(false); setCropFrame({ zoom: 1, offsetX: 0, offsetY: 0 }); setPreview(previous => ({ dataUrl: value.dataUrl, revision: (previous?.revision ?? 0) + 1, title: 'Uploaded image', tag: 'PNG · 256 px' })) }
    } catch (cause) { if (current()) { setErrorStep('prepare'); setError(presentError(cause)) } }
    finally { if (current()) setPreparing(false) }
  }
  async function save(): Promise<void> {
    if (!target || busy || preparing || seriesPreparing || (seriesAttempt && seriesAttempt.state !== 'saved' && (editingSeries || seriesAttempt.state !== 'unsent')) || editingSeries && seriesStorageIssue || (!editingFace && preview && !previewReady)) return
    if (editingSeries) {
      if (!target.avatarTarget || !avatarBaseline || !seriesDraft || avatarReading) return
      const request = freezeSeriesSave({ target: target.avatarTarget, operationId: mintObjectId(), beforeRevision: avatarBaseline.revision,
        source: seriesDraft.source, definition: seriesDraft.definition, parameters: seriesDraft.parameters, pngDataUrl: seriesDraft.pngDataUrl })
      await submitSeriesSave(request, target)
      return
    }
    const original = target, session = editor.current
    const current = () => editor.current === session && currentTarget.current?.key === original.key
    setBusy(true); setError(null)
    try {
      let choice = draft
      if (!editingFace && preview && (original.avatarTarget || original.imageTarget)) {
        if (!canvas.current) throw new Error('The avatar preview is not ready. Select the image again.')
        const input = { mimeType: 'image/png' as const, dataUrl: canvas.current.toDataURL('image/png') }
        choice = original.imageTarget ? await api.spaceObjects.saveAvatar(original.imageTarget, input)
          : await api.scratch.saveMoteAvatar(original.avatarTarget!.workspaceId, original.avatarTarget!.topicId, input, original.avatarTarget!.objectKey)
      }
      // A completed asset belongs to the submitted object, but a replaced editor cannot publish it.
      if (!current()) return
      await useAppStore.getState().setSpaceObjectIcon(original.key, choice)
      if (current()) onClose()
    } catch (cause) { if (current()) { setErrorStep('save'); setError(presentError(cause)) } }
    finally { if (current()) setBusy(false) }
  }
  const select = (choice: SpaceIconChoice | null) => {
    localIntent.current = true
    inputRequest.current = {}; setPreparing(false); setDraft(choice); setError(null)
    if (isMoteFace(choice)) setFaceDraft(choice)
    else { setAlternativeDraft(choice); setPreview(null); setPreviewReady(false) }
  }
  const source = (next: typeof mode) => {
    localIntent.current = true
    inputRequest.current = {}; setPreparing(false); setSeriesPreparing(false); setError(null); setMode(next)
    if (next !== 'series') setDraft(next === 'face' ? faceDraft : alternativeDraft)
  }
  const saveButtonLabel = busy ? 'Saving…' : seriesAttempt?.state === 'unknown' ? 'Save unconfirmed'
    : editingSeries && seriesAttempt?.state === 'refused' ? 'Review current avatar'
      : editingSeries && seriesAttempt?.state === 'unsent' ? 'Save not sent'
        : editingSeries && seriesStorageIssue ? 'Request unconfirmed'
          : error && errorStep === 'save' ? 'Retry saving' : supportsImages ? editingFace ? 'Save face' : 'Save avatar' : 'Save icon'
  const stageSourceTitle = preview ? (preview.title ?? 'Uploaded image') : alternativeDraft === null ? 'Automatic companion'
    : typeof alternativeDraft === 'string' && alternativeDraft in SPACE_ICON_CATALOG ? SPACE_ICON_CATALOG[alternativeDraft].label : 'Saved image'
  const stageSourceTag = preview ? (preview.tag ?? 'PNG · 256 px') : alternativeDraft === null ? 'Default Mote'
    : typeof alternativeDraft === 'string' ? 'Symbol icon' : 'Mote avatar'
  const clampedCropX = Math.max(-(cropFrame.zoom - 1) * 50, Math.min((cropFrame.zoom - 1) * 50, (cropFrame.offsetX / 256) * 100))
  const clampedCropY = Math.max(-(cropFrame.zoom - 1) * 50, Math.min((cropFrame.zoom - 1) * 50, (cropFrame.offsetY / 256) * 100))
  const renderLiveChipContent = () => {
    if (!target?.avatarTarget) return null
    if (preview) {
      const style = { transform: `translate(${clampedCropX.toFixed(2)}%, ${clampedCropY.toFixed(2)}%) scale(${cropFrame.zoom})` }
      return preview.silhouetteId
        ? <span className="mote-avatar-stage__live-crop" style={style}><MoteSilhouetteArt id={preview.silhouetteId} /></span>
        : <img className="space-object-icon__avatar mote-live-breathe" src={preview.dataUrl} alt="" draggable={false} style={style} />
    }
    return <SpaceObjectIcon kind={target.kind} name={target.name} manualIcon={alternativeDraft} avatarWorkspaceId={target.avatarTarget.workspaceId}
      avatarTopicId={target.avatarTarget.topicId} avatarObjectKey={target.key} visible={false} />
  }
  const uploadControl = supportsImages && target ? <label className="small-button mote-avatar-file"><ThemeActionAddImageIcon size={14} />Upload image
    <input aria-label={target.avatarTarget ? 'Choose Mote image' : `Choose image for ${target.name}`} type="file" accept="image/png,image/jpeg" disabled={busy}
      onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void prepare(file) }} />
    <span>PNG or JPG · up to 8 MB</span>
  </label> : null
  return <Dialog.Root recoveryCloseDisabled={busy} open={target !== null} onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DocumentOverlayPortal component={Dialog.Portal}>
      <Dialog.Overlay className="space-icon-picker__overlay dialog-scrim" />
      <Dialog.Content ref={content} data-series-draft-ready={Boolean(seriesDraft)} data-avatar-baseline-ready={Boolean(avatarBaseline)} data-avatar-save-state={busy && seriesAttempt ? 'saving' : seriesAttempt?.state} data-avatar-operation={seriesAttempt?.request.operationId} className={`space-icon-picker dialog-surface${editingSeries ? ' space-icon-picker--series' : ''}${supportsImages ? ' space-icon-picker--avatar' : ''}`} onEscapeKeyDown={event => { if (busy) event.preventDefault() }}
        onInteractOutside={event => { if (busy) event.preventDefault() }}
        onPointerMove={event => {
          const dialog = content.current
          if (!dialog || event.pointerType === 'touch') return
          const anchor = dialog.querySelector<HTMLElement>('.mote-avatar-alternative:not([hidden]) .mote-avatar-crop__stage, .mote-avatar-alternative:not([hidden]) .mote-avatar-preview, .mote-face-editor:not([hidden]) .mote-face-editor__preview')
          const rect = anchor?.getBoundingClientRect()
          if (!rect || rect.width <= 0) return
          const dx = Math.max(-2.6, Math.min(2.6, (event.clientX - (rect.left + rect.width / 2)) / 38))
          const dy = Math.max(-2.0, Math.min(2.0, (event.clientY - (rect.top + rect.height / 2)) / 38))
          const turn = Math.max(-3.5, Math.min(3.5, (event.clientX - (rect.left + rect.width / 2)) / 34))
          dialog.style.setProperty('--mote-stage-gaze-x', `${dx.toFixed(2)}px`)
          dialog.style.setProperty('--mote-stage-gaze-y', `${dy.toFixed(2)}px`)
          dialog.style.setProperty('--mote-stage-turn', `${turn.toFixed(2)}deg`)
        }}
        onPointerLeave={() => {
          const dialog = content.current
          if (!dialog) return
          dialog.style.removeProperty('--mote-stage-gaze-x')
          dialog.style.removeProperty('--mote-stage-gaze-y')
          dialog.style.removeProperty('--mote-stage-turn')
        }}
        onCloseAutoFocus={event => {
          event.preventDefault()
          const row = returnFocus ? returnFocus() : [...ownerDocument.querySelectorAll<HTMLElement>('[data-space-icon-target]')]
            .find(node => node.dataset.spaceIconTarget === returnKey.current)
          const active = ownerDocument.activeElement
          if (row?.isConnected && (active === ownerDocument.body || active === row || !active?.isConnected || content.current?.contains(active))) row.focus({ preventScroll: true })
        }}>
        <header className="space-icon-picker__header">
          <Dialog.Title className="space-icon-picker__title">{supportsImages ? 'Change avatar' : 'Change icon'}</Dialog.Title>
          <Dialog.Description className="space-icon-picker__description">{target?.name}</Dialog.Description>
        </header>
        {supportsImages && target ? <>
          {target.avatarTarget ? <><div className="mote-avatar-source mote-avatar-source--series" role="group" aria-label="Mote avatar style">
            <LiquidSelectionSurface selected={mode} active={target !== null} targetAttribute="data-avatar-source" />
            <button type="button" data-avatar-source="alternative" aria-pressed={mode === 'alternative'} disabled={busy} onClick={() => source('alternative')}><ThemeObjectShapesIcon size={15} />Icon or image</button>
            <button type="button" data-avatar-source="face" aria-pressed={editingFace} disabled={busy} onClick={() => source('face')}><ThemeObjectProfileIcon size={15} />Make a face</button>
            <button type="button" data-avatar-source="series" aria-pressed={editingSeries} disabled={busy} onClick={() => source('series')}><ThemeObjectLibraryIcon size={15} />Series</button>
          </div>
          <MoteFaceEditor face={faceDraft} visible={editingFace} disabled={busy} onChange={select} />
          </> : null}
          {target.avatarTarget && seriesSeedReady ? <MoteAvatarSeriesEditor key={targetIdentity} targetKey={target.key} visible={editingSeries} disabled={busy}
            initialChoice={seriesSeed} initialImage={seriesImage} savedImageConfirmed={seriesImageConfirmed} onDraft={setSeriesDraft} onPreparing={setSeriesPreparing} /> : null}
          <div className="mote-avatar-alternative" hidden={mode !== 'alternative'}>
            <div className={`mote-avatar-stage${target.avatarTarget ? '' : ' mote-avatar-stage--single'}`}>
              {preview ? <MoteAvatarCrop key={preview.revision} source={preview.dataUrl} silhouetteId={preview.silhouetteId} canvasRef={canvas} disabled={busy || preparing}
                onReady={() => setPreviewReady(true)} onFrame={setCropFrame} onError={cause => { setErrorStep('prepare'); setError(cause) }} /> : <div className="mote-avatar-preview" role="img" aria-label={`Your ${target.kind} avatar preview`}>
                <SpaceObjectIcon kind={target.kind} name={target.name} manualIcon={alternativeDraft} imageTarget={target.imageTarget} avatarWorkspaceId={target.avatarTarget?.workspaceId}
                  avatarTopicId={target.avatarTarget?.topicId} avatarObjectKey={target.key} />
              </div>}
              {target.avatarTarget ? <div className="mote-avatar-stage__aside">
                <div className="mote-avatar-stage__header">
                  <span className="mote-avatar-stage__source"><strong>{stageSourceTitle}</strong><small>{stageSourceTag}</small></span>
                  <span role="button" tabIndex={busy ? -1 : 0} aria-disabled={busy} aria-label="Shuffle style" className="small-button mote-avatar-stage__shuffle"
                    onClick={() => { if (!busy) setShuffleRevision(value => value + 1) }}
                    onKeyDown={event => { if (!busy && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setShuffleRevision(value => value + 1) } }}>Shuffle</span>
                </div>
                <div className="mote-avatar-stage__sizes" aria-label="Actual avatar sizes">
                  <div className="mote-avatar-stage__chip">
                    <span className="mote-avatar-stage__slot mote-avatar-stage__slot--45" aria-hidden="true">
                      {renderLiveChipContent()}
                    </span>
                    <span className="mote-avatar-stage__chip-meta"><strong>45 px</strong><small>Directory</small></span>
                  </div>
                  <div className="mote-avatar-stage__chip">
                    <span className="mote-avatar-stage__slot mote-avatar-stage__slot--24" aria-hidden="true">
                      {renderLiveChipContent()}
                    </span>
                    <span className="mote-avatar-stage__chip-meta"><strong>24 px</strong><small>Chat</small></span>
                  </div>
                </div>
                {!preview ? <div className="mote-avatar-stage__hint"><span>Move pointer to preview gaze · Select any style below</span></div> : null}
              </div> : null}
            </div>
            {target.avatarTarget ? <MoteAvatarImageGallery key={targetIdentity} visible={mode === 'alternative'} disabled={busy}
              selectedImage={preview?.dataUrl ?? null} shuffleRevision={shuffleRevision} uploadAction={uploadControl} onChoose={(dataUrl, meta) => {
                localIntent.current = true; inputRequest.current = {}; setPreparing(false); setError(null); setPreviewReady(false)
                setCropFrame({ zoom: 1, offsetX: 0, offsetY: 0 })
                setPreview(previous => ({ dataUrl, revision: (previous?.revision ?? 0) + 1, ...meta }))
              }} /> : uploadControl}
            {preparing ? <p className="space-icon-picker__description" role="status">Preparing image…</p> : null}
          </div>
        </> : null}
        {mode === 'alternative' ? <div className="space-icon-picker__symbols">
          {supportsImages ? <span className="space-icon-picker__description">Symbol icons</span> : null}
          <div className="space-icon-picker__choices" role="group" aria-label="Icon choices">
            {(Object.entries(SPACE_ICON_CATALOG) as Array<[SpaceIconId, typeof SPACE_ICON_CATALOG[SpaceIconId]]>).map(([id, { Icon, label }]) =>
              <button key={id} type="button" className="space-icon-picker__choice" aria-label={`${label} icon`}
                title={label} aria-pressed={!preview && draft === id} data-space-icon-choice={id} disabled={busy}
                onClick={() => select(id)}><Icon size={18} /></button>)}
          </div>
        </div> : null}
        {error ? <p className="space-icon-picker__error" role="alert">{errorStep === 'save' ? 'Saving is unconfirmed. Your choice is kept; review the current avatar before saving again.' : 'Image preparation failed. Your current avatar is unchanged; choose image again.'} {error}</p> : null}
        {target?.avatarTarget && avatarReading ? <p className="space-icon-picker__description" role="status">Reading current avatar…</p> : null}
        {target?.avatarTarget && (avatarReadIssue || seriesAttempt || seriesStorageIssue) ? <div className="mote-series__notice" role="status" data-avatar-save-notice>
          <div><span>{seriesStorageIssue ? seriesAttempt?.state === 'saved' ? 'Save confirmed. Request cleanup is unconfirmed.' : seriesAttempt?.state === 'unsent' ? 'Save was not sent. Your draft is kept.' : 'Kept request is unreadable. Your draft is kept.' : seriesAttempt?.state === 'unknown' ? 'Save is unconfirmed. Your draft is kept.' : seriesAttempt?.state === 'refused' ? 'Save was refused. Your draft is kept.' : seriesAttempt?.state === 'saved' ? seriesAttempt.issue ? 'Save confirmed. Display refresh is unconfirmed.' : 'Original save confirmed.' : 'Current avatar is unconfirmed. Your draft is kept.'}</span></div>
          {seriesAttempt?.issue || avatarReadIssue || seriesStorageIssue ? <details><summary>Details</summary><p>{[...new Set([seriesAttempt?.issue, avatarReadIssue, seriesStorageIssue].filter(Boolean))].join('\n')}</p>
            {seriesAttempt ? <p>Save {seriesAttempt.request.operationId}</p> : null}</details> : null}
          <div>
            {seriesAttempt?.state === 'unknown' || seriesAttempt?.state === 'unsent' ? <><button type="button" className="small-button" data-avatar-inspect-save disabled={busy || avatarReading} onClick={() => void readAvatarBaseline(target)}>Inspect save</button>
              <button type="button" className="small-button" data-avatar-retry-save disabled={busy || avatarReading} onClick={() => void submitSeriesSave(seriesAttempt.request, target)}>Retry original save</button></>
              : seriesAttempt?.state === 'saved' && seriesAttempt.issue ? <button type="button" className="small-button" data-avatar-refresh-display disabled={busy || avatarReading} onClick={() => void refreshSavedConfig(target, editor.current, true)}>Refresh display</button>
                : <button type="button" className="small-button" data-avatar-review-current disabled={busy || avatarReading} onClick={() => void readAvatarBaseline(target, true)}>{seriesAttempt?.state === 'refused' ? 'Review current avatar' : 'Read current avatar'}</button>}
          </div>
        </div> : null}
        <footer>
          <button type="button" className="small-button space-icon-picker__automatic" aria-pressed={!editingSeries && !preview && draft === null}
            disabled={busy} onClick={() => { select(null); if (editingSeries) setMode('alternative') }}><ThemeActionRestoreDefaultsIcon size={13} />Restore automatic</button>
          <button type="button" className="small-button" disabled={busy} onClick={onClose}>{seriesAttempt || seriesStorageIssue || error && errorStep === 'save' ? 'Close' : 'Cancel'}</button>
          <button type="button" className={`${supportsImages ? 'primary-button' : 'small-button'} space-icon-picker__save`} aria-label={saveButtonLabel} disabled={busy || preparing || seriesPreparing || Boolean(seriesAttempt && seriesAttempt.state !== 'saved' && (editingSeries || seriesAttempt.state !== 'unsent')) || Boolean(editingSeries && (!avatarBaseline || avatarReading || !seriesDraft || seriesStorageIssue)) || Boolean(!editingFace && preview && !previewReady)} onClick={() => void save()}>
            {saveButtonLabel}
          </button>
        </footer>
      </Dialog.Content>
    </DocumentOverlayPortal>
  </Dialog.Root>
}
