import { TextInput } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useRef, useState } from 'react'
import { BROWSER_START_PAGE_IMAGE_LIMIT, validBrowserStartPageImage } from '../../../../shared/browser-start-page'

const ImageIcon = semanticIconComponent('object.image')
const AddImageIcon = semanticIconComponent('action.add-image')
const ReplaceImageIcon = semanticIconComponent('action.replace')
const ClearImageIcon = semanticIconComponent('action.clear')
const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']

/** A local selection edits the original start-page draft; it does not publish an asset. */
export function StartPageImageField({ kind, value, preview, revision, onChange }: {
  kind: 'icon' | 'background'
  value: string
  preview: string
  revision: number
  onChange(value: string): void
}) {
  const upload = useRef<HTMLInputElement>(null), choose = useRef<HTMLButtonElement>(null), request = useRef(0)
  const [notice, setNotice] = useState(''), [reading, setReading] = useState(false)
  const [failedPreview, setFailedPreview] = useState<string | null>(null)
  const label = kind === 'icon' ? 'Icon image' : 'Background image'
  const inline = value.startsWith('data:')
  const previewKey = `${revision}:${preview}`
  useEffect(() => { request.current++; setReading(false); setNotice('') }, [value])
  useEffect(() => () => { request.current++ }, [])

  function change(value: string): void {
    request.current++
    setReading(false); setNotice(''); onChange(value)
  }
  async function select(file: File | undefined): Promise<void> {
    const selected = ++request.current
    setNotice('')
    if (!file) { setReading(false); return }
    // This is the existing configuration string budget, including the data URL envelope.
    if (!imageTypes.includes(file.type) || Math.ceil(file.size / 3) * 4 + `data:${file.type};base64,`.length > BROWSER_START_PAGE_IMAGE_LIMIT) {
      setReading(false)
      setNotice('Choose a smaller PNG, JPEG, WebP, GIF or AVIF image, or use an image URL. Your current image is kept.')
      return
    }
    setReading(true)
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('This image could not be read. Choose it again. Your current image is kept.'))
        reader.readAsDataURL(file)
      })
      if (selected !== request.current) return
      if (!validBrowserStartPageImage(data)) throw new Error('This image could not be used. Choose another image. Your current image is kept.')
      onChange(data)
    } catch (error) {
      if (selected === request.current) setNotice(error instanceof Error ? error.message : String(error))
    } finally { if (selected === request.current) setReading(false) }
  }

  return <div className="settings-survey__image-field" data-settings-field={`start-${kind}`}>
    <div className="settings-survey__image-row">
      <div className="settings-survey__thumbnail" data-image-kind={kind}>
        {preview && failedPreview !== previewKey
          ? <img key={previewKey} src={preview} alt={`${label} thumbnail`} referrerPolicy="no-referrer" onError={() => setFailedPreview(previewKey)} />
          : <ImageIcon size={21} aria-hidden="true" />}
      </div>
      <div className="settings-survey__image-content">
        <strong>{label}</strong>
        <small>{reading ? 'Reading image…' : value ? (inline ? 'Image selected' : 'Image URL selected') : 'No image'}</small>
        <div className="settings-survey__image-buttons">
          <button ref={choose} type="button" className="small-button" aria-label={`${value ? 'Replace' : 'Choose'} ${kind} image`}
            onClick={() => { request.current++; setReading(false); upload.current?.click() }}>{value ? <ReplaceImageIcon size={14} aria-hidden="true" /> : <AddImageIcon size={14} aria-hidden="true" />}{value ? 'Replace image' : 'Choose image'}</button>
          {value && <button type="button" className="small-button" aria-label={`Clear ${kind} image`} onClick={() => { change(''); choose.current?.focus() }}><ClearImageIcon size={14} aria-hidden="true" />Clear</button>}
        </div>
      </div>
    </div>
    <input ref={upload} hidden type="file" accept={imageTypes.join(',')} aria-label={`Select ${kind} image file`}
      onChange={event => { void select(event.currentTarget.files?.[0]); event.currentTarget.value = '' }} />
    <details className="settings-survey__image-url"><summary>Use image URL</summary>
      <TextInput aria-label={kind === 'icon' ? 'Start page icon' : 'Start page background image'}
        placeholder={inline ? 'Paste a URL to replace this image' : 'https://…'} value={inline ? '' : value}
        onChange={event => change(event.currentTarget.value)} />
    </details>
    {notice && <p className="settings-survey__field-notice" role="status">{notice}</p>}
    {preview && failedPreview === previewKey && <p className="settings-survey__field-notice" role="status">Image preview unavailable. Your selection is kept; replace it or try Preview images again.</p>}
  </div>
}
