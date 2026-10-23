import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MoteAvatarSeriesCatalog, MoteAvatarSeriesLocator } from '@agentmux/core/mote-avatar-series'
import { api } from '../lib/api'
import { presentError } from '@agentmux/client-ui/error-presentation'

type Entry = MoteAvatarSeriesCatalog['series'][number]['entries'][number]
type ImageGroup = 'silhouette' | 'companion'
type ImageChoice = { key: string; group: ImageGroup; entry: Entry; source: MoteAvatarSeriesLocator; dataUrl: string | null; issue: string | null }
const choiceKey = (source: MoteAvatarSeriesLocator) => `${source.origin}:${source.seriesId}:${source.entryId}`

/** The original Host image catalog supplies artwork; this chooser owns only an unsaved preview. */
export function MoteAvatarImageGallery({ visible, disabled, selectedImage, onChoose, uploadAction }: {
  visible: boolean; disabled: boolean; selectedImage: string | null; onChoose(dataUrl: string): void; uploadAction?: ReactNode
}) {
  const [choices, setChoices] = useState<ImageChoice[]>([])
  const [issue, setIssue] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)
  async function readImage(choice: ImageChoice, request: number) {
    try {
      const value = await api.moteAvatars.preview({ source: choice.source })
      if (generation.current !== request) return
      if (value.payload.kind === 'image') setChoices(previous => previous.map(item => item.key === choice.key
        ? { ...item, dataUrl: value.payload.kind === 'image' ? value.payload.image.dataUrl : null, issue: null } : item))
    } catch (cause) {
      if (generation.current === request) setChoices(previous => previous.map(item => item.key === choice.key
        ? { ...item, issue: presentError(cause) } : item))
    }
  }
  async function readCatalog() {
    const request = ++generation.current
    setLoading(true); setIssue(null)
    try {
      const catalog = await api.moteAvatars.list()
      if (generation.current !== request) return
      const collect = (seriesId: string, group: ImageGroup): ImageChoice[] => {
        const collection = catalog.series.find(item => item.origin === 'builtin' && item.seriesId === seriesId)
        if (!collection) return []
        return collection.entries.filter(entry => entry.definition.kind === 'image').map(entry => {
          const source = { origin: collection.origin, seriesId: collection.seriesId, entryId: entry.entryId }
          return { key: choiceKey(source), group, entry, source, dataUrl: null, issue: null }
        })
      }
      const images = [...collect('mote-silhouettes', 'silhouette'), ...collect('lowpoly', 'companion')]
      if (!images.length) {
        setChoices([])
        setIssue('The built-in Mote images are unavailable. Your current avatar and other choices are kept.')
        return
      }
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
  const silhouettes = choices.filter(item => item.group === 'silhouette')
  const companions = choices.filter(item => item.group === 'companion')
  const renderChoice = (choice: ImageChoice, className: string) => (
    <button key={choice.key} type="button" className={className}
      aria-label={`${choice.entry.title} Mote image`} aria-pressed={Boolean(choice.dataUrl && selectedImage === choice.dataUrl)} disabled={disabled}
      title={choice.issue ?? choice.entry.title} onClick={() => {
        if (choice.dataUrl) onChoose(choice.dataUrl)
        else void readImage(choice, generation.current)
      }}>
      <span className="mote-avatar-gallery__thumb" aria-hidden="true">
        {choice.dataUrl ? <img src={choice.dataUrl} alt="" draggable={false} /> : <span className="mote-avatar-gallery__placeholder">{choice.issue ? 'Retry' : '…'}</span>}
      </span>
      <span>{choice.entry.title}</span>
    </button>
  )
  return <section className="mote-avatar-gallery" aria-label="Mote silhouette images">
    <div className="mote-avatar-gallery__header">
      <span className="space-icon-picker__description">Mote silhouettes</span>
      {uploadAction}
    </div>
    {silhouettes.length ? <div className="mote-avatar-gallery__choices" role="group" aria-label="Mote image choices">
      {silhouettes.map(choice => renderChoice(choice, 'mote-avatar-gallery__choice'))}
    </div> : null}
    {companions.length ? <>
      <div className="mote-avatar-gallery__subheader">
        <span className="space-icon-picker__description">Low-poly companions</span>
      </div>
      <div className="mote-avatar-gallery__companions" role="group" aria-label="Low-poly companion choices">
        {companions.map(choice => renderChoice(choice, 'mote-avatar-gallery__companion'))}
      </div>
    </> : null}
    {loading ? <p className="space-icon-picker__description" role="status">Reading Mote images…</p> : null}
    {issue ? <p className="space-icon-picker__description" role="status">{issue} <button type="button" className="small-button" disabled={disabled} onClick={() => void readCatalog()}>Retry images</button></p> : null}
  </section>
}
