import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState } from 'react'
import type { MoteAvatarSeriesCreateResult } from '@agentmux/core/mote-avatar-series'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../lib/api'
import { resolveOverlayContainer } from './WindowOverlayHost'

const AddIcon = semanticIconComponent('action.add-item')
const FolderIcon = semanticIconComponent('action.open-folder')
const CopyIcon = semanticIconComponent('action.copy')
const CloseIcon = semanticIconComponent('action.close')
const freshFolder = () => 'my-series-' + crypto.randomUUID().slice(0, 8)

export function MoteAvatarSeriesCreateDialog({ disabled, rootPath, onUse }: {
  disabled: boolean; rootPath?: string | undefined;
  onUse(series: MoteAvatarSeriesCreateResult): Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('My series'), [seriesId, setSeriesId] = useState(freshFolder)
  const [created, setCreated] = useState<MoteAvatarSeriesCreateResult | null>(null)
  const [busy, setBusy] = useState<'create' | 'reveal' | 'copy' | 'use' | null>(null)
  const [issue, setIssue] = useState<{ action: string; detail: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const creating = useRef(false)
  const alive = useRef(true), currentId = useRef(seriesId); currentId.current = seriesId
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const current = (id: string) => alive.current && currentId.current === id
  function changeOpen(next: boolean) {
    if (next && created) {
      setCreated(null); setTitle('My series'); setSeriesId(freshFolder()); setIssue(null); setCopied(false)
    }
    setOpen(next)
  }
  async function create() {
    if (creating.current || disabled || !title.trim() || !seriesId) return
    const request = { seriesId, title: title.trim() }
    creating.current = true; setBusy('create'); setIssue(null)
    try { const result = await api.moteAvatars.createSeries(request); if (current(request.seriesId)) setCreated(result) }
    catch (error) { if (current(request.seriesId)) setIssue({ action: 'Creation was not confirmed. Check this folder before trying again.', detail: presentError(error) }) }
    finally { creating.current = false; if (current(request.seriesId)) setBusy(null) }
  }
  async function chooseSeries() {
    if (!created) return
    setBusy('use'); setIssue(null)
    try { await onUse(created); if (current(created.seriesId)) setOpen(false) }
    catch (error) { if (current(created.seriesId)) setIssue({ action: 'This series is not ready to browse yet.', detail: presentError(error) }) }
    finally { if (current(created.seriesId)) setBusy(null) }
  }
  async function reveal() {
    if (!created) return
    setBusy('reveal'); setIssue(null)
    try { await api.moteAvatars.revealSeries({ seriesId: created.seriesId }) }
    catch (error) { if (current(created.seriesId)) setIssue({ action: 'The folder could not be opened.', detail: presentError(error) }) }
    finally { if (current(created.seriesId)) setBusy(null) }
  }
  async function copy() {
    if (!created) return
    setBusy('copy'); setIssue(null)
    try { await api.ui.writeClipboardText(created.path); if (current(created.seriesId)) setCopied(true) }
    catch (error) { if (current(created.seriesId)) setIssue({ action: 'The path could not be copied.', detail: presentError(error) }) }
    finally { if (current(created.seriesId)) setBusy(null) }
  }
  const location = created?.path ?? (rootPath ? rootPath.replace(/[/\\]$/u, '') + '/' + seriesId : '~/.agentmux/avatars/' + seriesId)
  return <Dialog.Root open={open} onOpenChange={changeOpen}>
    <Dialog.Trigger asChild><button type="button" className="small-button mote-series__add" disabled={disabled}
      aria-label="Add avatar series" title="Add your own series"><AddIcon size={15} /></button></Dialog.Trigger>
    <Dialog.Portal container={resolveOverlayContainer()}>
      <Dialog.Overlay className="dialog-scrim" />
      <Dialog.Content asChild onEscapeKeyDown={event => event.stopPropagation()}>
        <form className="dialog-surface mote-series-create" data-series-create-id={seriesId} data-series-created={created?.seriesId}
          onSubmit={event => { event.preventDefault(); if (!created) void create() }}>
        <header><div><Dialog.Title className="mote-series-create__title">{created ? 'Your series is ready' : 'Add a series'}</Dialog.Title>
          <Dialog.Description className="mote-series-create__description">{created ? 'Add your images, then choose an avatar from this collection.' : 'Bring your own avatars. Keep each series in its own folder.'}</Dialog.Description></div>
          <Dialog.Close asChild><button type="button" className="icon-button" aria-label="Close series tutorial"><CloseIcon size={15} /></button></Dialog.Close></header>
        {created ? <div className="mote-series-create__ready">
          <div className="mote-series-create__folder"><FolderIcon size={21} /><div><strong>{created.title}</strong><span>An image, an editable face, and a short README.</span></div></div>
          <code className="mote-series-create__path">{created.path}</code>
          <div className="mote-series-create__folder-actions"><button type="button" className="small-button" disabled={busy !== null} onClick={() => void reveal()}><FolderIcon size={14} />Open folder</button>
            <button type="button" className="small-button" disabled={busy !== null} onClick={() => void copy()}><CopyIcon size={14} />{copied ? 'Copied' : 'Copy path'}</button></div>
        </div> : <>
          <ol className="mote-series-create__steps">
            <li><strong>One folder, one series</strong><span>Give your collection a name. We can create its folder and a working example.</span></li>
            <li><strong>Add your images</strong><span>Drop PNG or JPG files into that folder. You can also ask your Agent to make a set.</span></li>
            <li><strong>Mix images and editable faces</strong><span>The example includes a <code>series.json</code> file and a README you can adapt.</span></li>
          </ol>
          <label className="mote-series-create__name">Series name<input aria-label="Series name" value={title} maxLength={120} disabled={busy === 'create'} autoFocus
            onChange={event => setTitle(event.currentTarget.value)} /></label>
          <details className="mote-series-create__details"><summary>Folder and format</summary>
            <label>Folder name<input aria-label="Series folder name" value={seriesId} maxLength={255} disabled={busy === 'create'} onChange={event => setSeriesId(event.currentTarget.value)} /></label>
            <code className="mote-series-create__path">{location}</code>
            <p>Images work without a declaration. Use <code>series.json</code> for editable faces or supported 3D models. Refresh the series list after editing files.</p>
          </details>
        </>}
        {issue ? <div className="mote-series-create__issue"><p role="alert">{issue.action}</p><details><summary>Details</summary><p>{issue.detail}</p></details></div> : null}
        <footer><Dialog.Close asChild><button type="button" className="small-button">{created ? 'Close' : 'Cancel'}</button></Dialog.Close>
          {created ? <button type="button" className="primary-button" disabled={busy !== null} onClick={() => void chooseSeries()}>{busy === 'use' ? 'Refreshing…' : 'Use series'}</button>
            : <button type="submit" className="primary-button" disabled={disabled || busy === 'create' || !title.trim() || !seriesId}>{busy === 'create' ? 'Creating…' : 'Create starter series'}</button>}</footer>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
