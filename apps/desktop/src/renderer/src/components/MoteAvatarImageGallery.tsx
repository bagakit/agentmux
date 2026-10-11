import { useEffect, useRef, useState } from 'react'
import type { MoteAvatarSeriesCatalog, MoteAvatarSeriesLocator } from '@agentmux/core/mote-avatar-series'
import { api } from '../lib/api'
import { presentError } from '@agentmux/client-ui/error-presentation'

type Entry = MoteAvatarSeriesCatalog['series'][number]['entries'][number]
type ImageChoice = { entry: Entry; source: MoteAvatarSeriesLocator; dataUrl: string | null; issue: string | null }

/** The original Host image catalog supplies artwork; this chooser owns only an unsaved preview. */
export function MoteAvatarImageGallery({ visible, disabled, selectedImage, onChoose }: {
  visible: boolean; disabled: boolean; selectedImage: string | null; onChoose(dataUrl: string): void
}) {
  const [choices, setChoices] = useState<ImageChoice[]>([])
  const [issue, setIssue] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)
  async function readImage(choice: ImageChoice, request: number) {
    try {
      const value = await api.moteAvatars.preview({ source: choice.source })
      if (generation.current !== request) return
      if (value.payload.kind === 'image') setChoices(previous => previous.map(item => item.entry.entryId === choice.entry.entryId
        ? { ...item, dataUrl: value.payload.kind === 'image' ? value.payload.image.dataUrl : null, issue: null } : item))
    } catch (cause) {
      if (generation.current === request) setChoices(previous => previous.map(item => item.entry.entryId === choice.entry.entryId
        ? { ...item, issue: presentError(cause) } : item))
    }
  }
  async function readCatalog() {
    const request = ++generation.current
    setLoading(true); setIssue(null)
    try {
      const catalog = await api.moteAvatars.list()
      if (generation.current !== request) return
      const collection = catalog.series.find(item => item.origin === 'builtin' && item.seriesId === 'mote-silhouettes')
      if (!collection) { setIssue('The built-in Mote images are unavailable. Your current avatar and other choices are kept.'); return }
      const images = collection.entries.filter(entry => entry.definition.kind === 'image').map(entry => ({ entry,
        source: { origin: collection.origin, seriesId: collection.seriesId, entryId: entry.entryId }, dataUrl: null, issue: null }))
      if (!images.length) setIssue('The built-in Mote images are unavailable. Your current avatar and other choices are kept.')
      setChoices(images)
      await Promise.all(images.map(choice => readImage(choice, request)))
    } catch (cause) { if (generation.current === request) setIssue(presentError(cause)) }
    finally { if (generation.current === request) setLoading(false) }
  }
  useEffect(() => {
    if (visible) void readCatalog()
    return () => { generation.current++ }
  }, [visible])
  if (!visible) return null
  return <section className="mote-avatar-gallery" aria-label="Mote silhouette images">
    <span className="space-icon-picker__description">Mote silhouettes</span>
    <div className="mote-avatar-gallery__choices" role="group" aria-label="Mote image choices">
      {choices.map(choice => <button key={choice.entry.entryId} type="button" className="mote-avatar-gallery__choice"
        aria-label={`${choice.entry.title} Mote image`} aria-pressed={Boolean(choice.dataUrl && selectedImage === choice.dataUrl)} disabled={disabled}
        title={choice.issue ?? choice.entry.title} onClick={() => {
          if (choice.dataUrl) onChoose(choice.dataUrl)
          else void readImage(choice, generation.current)
        }}>
        {choice.dataUrl ? <img src={choice.dataUrl} alt="" draggable={false} /> : <span className="mote-avatar-gallery__placeholder">{choice.issue ? 'Retry' : '…'}</span>}
        <span>{choice.entry.title}</span>
      </button>)}
    </div>
    {loading ? <p className="space-icon-picker__description" role="status">Reading Mote images…</p> : null}
    {issue ? <p className="space-icon-picker__description" role="status">{issue} <button type="button" className="small-button" disabled={disabled} onClick={() => void readCatalog()}>Retry images</button></p> : null}
  </section>
}
