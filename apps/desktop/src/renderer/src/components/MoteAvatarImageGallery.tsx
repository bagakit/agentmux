import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { MoteAvatarSeriesCatalog, MoteAvatarSeriesDefinition, MoteAvatarSeriesLocator, MoteAvatarSeriesSource } from '@agentmux/core/mote-avatar-series'
import { api } from '../lib/api'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { MoteSilhouetteArt } from './MoteSilhouetteArt'

export { MoteSilhouetteArt } from './MoteSilhouetteArt'

type Entry = MoteAvatarSeriesCatalog['series'][number]['entries'][number]
type ImageGroup = 'silhouette' | 'companion'
export type MoteGallerySelectionMeta = {
  title: string; tag: string; silhouetteId?: string | undefined
  source?: MoteAvatarSeriesSource | undefined; definition?: MoteAvatarSeriesDefinition | undefined
}
type ImageChoice = {
  key: string; group: ImageGroup; entry: Entry; source: MoteAvatarSeriesLocator
  preparedSource: MoteAvatarSeriesSource | null; dataUrl: string | null; issue: string | null
}
const choiceKey = (source: Pick<MoteAvatarSeriesLocator, 'origin' | 'seriesId' | 'entryId'>) => `${source.origin}:${source.seriesId}:${source.entryId}`

/** The original Host image catalog supplies artwork; this chooser owns only an unsaved preview. */
export function MoteAvatarImageGallery({ visible, disabled, selectedImage, selectedLocator, shuffleRevision = 0, onChoose, uploadAction }: {
  visible: boolean; disabled: boolean; selectedImage: string | null;
  selectedLocator?: Pick<MoteAvatarSeriesLocator, 'origin' | 'seriesId' | 'entryId'> | null | undefined;
  shuffleRevision?: number | undefined;
  onChoose(dataUrl: string, meta?: MoteGallerySelectionMeta): void; uploadAction?: ReactNode
}) {
  const [choices, setChoices] = useState<ImageChoice[]>([])
  const [issue, setIssue] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)
  const chooseRef = useRef(onChoose); chooseRef.current = onChoose
  function selectionMeta(choice: ImageChoice): MoteGallerySelectionMeta {
    return {
      title: choice.entry.title,
      tag: choice.group === 'silhouette' ? 'Mote silhouette' : 'Low-poly companion',
      ...(choice.group === 'silhouette' ? { silhouetteId: choice.entry.entryId } : {}),
      ...(choice.preparedSource ? { source: choice.preparedSource, definition: choice.entry.definition } : {})
    }
  }
  async function readImage(choice: ImageChoice, request: number) {
    try {
      const value = await api.moteAvatars.preview({ source: choice.source })
      if (generation.current !== request) return
      if (value.payload.kind === 'image') setChoices(previous => previous.map(item => item.key === choice.key
        ? { ...item, preparedSource: value.source, dataUrl: value.payload.kind === 'image' ? value.payload.image.dataUrl : null, issue: null } : item))
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
          return { key: choiceKey(source), group, entry, source, preparedSource: null, dataUrl: null, issue: null }
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
  useEffect(() => {
    if (!shuffleRevision) return
    const readyChoices = choices.filter(item => item.dataUrl !== null)
    if (!readyChoices.length) return
    const others = readyChoices.filter(item => item.dataUrl !== selectedImage)
    const picked = (others.length ? others : readyChoices)[Math.floor(Math.random() * (others.length || readyChoices.length))]!
    chooseRef.current(picked.dataUrl!, selectionMeta(picked))
  }, [shuffleRevision])
  if (!visible) return null
  const silhouettes = choices.filter(item => item.group === 'silhouette')
  const companions = choices.filter(item => item.group === 'companion')
  const selectedKey = !selectedImage && selectedLocator ? choiceKey(selectedLocator) : null
  const renderChoice = (choice: ImageChoice, index: number, className: string) => (
    <button key={choice.key} type="button" className={className}
      aria-label={`${choice.entry.title} Mote image`}
      aria-pressed={Boolean(choice.dataUrl && selectedImage === choice.dataUrl) || selectedKey === choice.key}
      disabled={disabled}
      style={{ '--mote-ambient-delay': `${-(index * 470)}ms` } as CSSProperties}
      title={choice.issue ?? choice.entry.title} onClick={() => {
        if (choice.dataUrl) onChoose(choice.dataUrl, selectionMeta(choice))
        else void readImage(choice, generation.current)
      }}>
      <span className="mote-avatar-gallery__thumb" aria-hidden="true">
        {choice.dataUrl ? <>
          <img className={choice.group === 'silhouette' ? 'mote-avatar-gallery__backing' : 'mote-live-breathe'} src={choice.dataUrl} alt="" draggable={false} />
          {choice.group === 'silhouette' ? <MoteSilhouetteArt id={choice.entry.entryId} interactive={false} /> : null}
        </> : <span className="mote-avatar-gallery__placeholder">{choice.issue ? 'Retry' : '…'}</span>}
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
      {silhouettes.map((choice, index) => renderChoice(choice, index, 'mote-avatar-gallery__choice'))}
    </div> : null}
    {companions.length ? <>
      <div className="mote-avatar-gallery__subheader">
        <span className="space-icon-picker__description">Low-poly companions</span>
      </div>
      <div className="mote-avatar-gallery__companions" role="group" aria-label="Low-poly companion choices">
        {companions.map((choice, index) => renderChoice(choice, index + 12, 'mote-avatar-gallery__companion'))}
      </div>
    </> : null}
    {loading ? <p className="space-icon-picker__description" role="status">Reading Mote images…</p> : null}
    {issue ? <p className="space-icon-picker__description" role="status">{issue} <button type="button" className="small-button" disabled={disabled} onClick={() => void readCatalog()}>Retry images</button></p> : null}
  </section>
}
