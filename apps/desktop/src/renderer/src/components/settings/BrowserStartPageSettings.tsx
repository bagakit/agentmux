import { TextInput } from '@agentmux/client-ui/input'
import { useState, type ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { BROWSER_START_PAGE_TITLE_LIMIT, BROWSER_START_PAGE_SUBTITLE_LIMIT, BROWSER_START_PAGE_HISTORY_LIMIT, resolveBrowserStartPage, validBrowserStartPageText, validBrowserStartPageImage, validBrowserStartPageHistoryLimit, type BrowserStartPageConfig } from '../../../../shared/browser-start-page'
import { useSettingDraftRecord } from './use-setting-draft'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { StartPageImageField } from './StartPageImageField'
import '../../styles/settings-survey.css'

const SearchIcon = semanticIconComponent('action.search')
const PreviewIcon = semanticIconComponent('action.preview')

export function BrowserStartPageSettings({ config, onSave, onOpen, children }: {
  config?: Partial<BrowserStartPageConfig> | undefined
  onSave(value: Required<BrowserStartPageConfig>, expected: Required<BrowserStartPageConfig>): Promise<void>
  onOpen(): void
  children?: ReactNode
}) {
  const saved = resolveBrowserStartPage(config)
  // Keep the person's numeric text in the same draft, including an empty or invalid in-progress edit.
  const draft = useSettingDraftRecord({ ...saved, historyLimit: String(saved.historyLimit) })
  const save = useSettingsSave()
  const [imagePreview, setImagePreview] = useState<{ icon: string; backgroundImage: string; revision: number } | null>(null)
  const [imageNotice, setImageNotice] = useState('')
  const imagesCurrent = imagePreview?.icon === draft.value.icon && imagePreview?.backgroundImage === draft.value.backgroundImage
  const hasImages = Boolean(draft.value.icon || draft.value.backgroundImage)
  const previewSource = (value: string) => value.startsWith('data:image/') && validBrowserStartPageImage(value) || imagesCurrent ? value : ''
  const iconPreview = previewSource(draft.value.icon), backgroundPreview = previewSource(draft.value.backgroundImage)
  const unloadedImages = Boolean(draft.value.icon && !iconPreview || draft.value.backgroundImage && !backgroundPreview)
  function previewImages(): void {
    const { icon, backgroundImage } = draft.value
    if (validBrowserStartPageImage(icon) && validBrowserStartPageImage(backgroundImage)) {
      setImagePreview(current => ({ icon, backgroundImage, revision: (current?.revision ?? 0) + 1 }))
      setImageNotice('')
    } else {
      setImageNotice('Use an HTTP(S) image URL or an inline image before previewing. Your draft is kept.')
    }
  }
  async function submit(): Promise<void> {
    const submitted = draft.beginSave()
    submitted.finish(await save.run(async () => {
      const value = submitted.value
      if (!validBrowserStartPageText(value.title, BROWSER_START_PAGE_TITLE_LIMIT) || !validBrowserStartPageText(value.subtitle, BROWSER_START_PAGE_SUBTITLE_LIMIT))
        throw new Error(`Use a single-line title up to ${BROWSER_START_PAGE_TITLE_LIMIT} characters and subtitle up to ${BROWSER_START_PAGE_SUBTITLE_LIMIT} characters. Your draft is kept.`)
      if (!validBrowserStartPageImage(value.icon) || !validBrowserStartPageImage(value.backgroundImage))
        throw new Error('Use an HTTP(S) image URL or an inline PNG, JPEG, WebP, GIF or AVIF image. Leave the field empty to hide it. Your draft is kept.')
      const historyLimit = Number(value.historyLimit)
      if (String(historyLimit) !== value.historyLimit || !validBrowserStartPageHistoryLimit(historyLimit))
        throw new Error(`Use a whole number from ${BROWSER_START_PAGE_HISTORY_LIMIT.min} to ${BROWSER_START_PAGE_HISTORY_LIMIT.max} for cards on first view. Your draft is kept.`)
      await onSave({ ...value, historyLimit }, { ...submitted.expected, historyLimit: Number(submitted.expected.historyLimit) })
    }))
  }
  return <div className="settings-pane-stack settings-survey">
    <section className="settings-group">
      <header><span>Start page</span><button type="button" className="small-button" onClick={onOpen}>Open Survey</button></header>
      <div className="settings-survey__workspace"><div className="settings-survey__fields">
      <label className="browser-start-settings__field" data-settings-field="start-title"><span>Title</span><TextInput aria-label="Start page title" value={draft.value.title} maxLength={BROWSER_START_PAGE_TITLE_LIMIT} onChange={event => draft.setField('title', event.target.value)} /></label>
      <label className="browser-start-settings__field" data-settings-field="start-subtitle"><span>Subtitle</span><TextInput aria-label="Start page subtitle" value={draft.value.subtitle} maxLength={BROWSER_START_PAGE_SUBTITLE_LIMIT} onChange={event => draft.setField('subtitle', event.target.value)} /></label>
      <div className="settings-survey__images" role="group" aria-label="Icon and background">
      <div className="settings-survey__image-actions"><strong>Icon and background</strong>{hasImages && <button type="button" className="small-button" aria-label="Preview icon and background images" onClick={previewImages}><PreviewIcon size={14} aria-hidden="true" />Preview images</button>}</div>
      <StartPageImageField kind="icon" value={draft.value.icon} preview={iconPreview} revision={imagePreview?.revision ?? 0} onChange={value => { draft.setField('icon', value); setImageNotice('') }} />
      <StartPageImageField kind="background" value={draft.value.backgroundImage} preview={backgroundPreview} revision={imagePreview?.revision ?? 0} onChange={value => { draft.setField('backgroundImage', value); setImageNotice('') }} />
      </div>
      <label className="browser-automation-toggle" data-settings-field="start-interactive-background"><input type="checkbox" aria-label="Interactive start page background" checked={draft.value.interactiveBackground} onChange={event => draft.setField('interactiveBackground', event.target.checked)} />
        <span><strong>Interactive background</strong><small>Light follows your pointer. Reduced motion keeps it still.</small></span></label>
      <label className="browser-automation-toggle" data-settings-field="start-history"><input type="checkbox" aria-label="Show recent input cards" checked={draft.value.showHistory} onChange={event => draft.setField('showHistory', event.target.checked)} />
        <span><strong>Show recent addresses and searches</strong><small>Cards use this Browser's saved input history. Turning them off keeps your history.</small></span></label>
      <label className="browser-start-settings__field settings-survey__count" data-settings-field="start-history-limit"><span>Cards on first view</span>
        <TextInput aria-label="Cards on first view" inputMode="numeric" value={draft.value.historyLimit} onChange={event => draft.setField('historyLimit', event.target.value)} />
        <small>Choose 1–50. Show all still reveals the rest of your saved history.</small></label>
      </div>
      <aside className="settings-survey__preview" aria-label="Start page draft preview">
        <header><strong>Draft preview</strong><small>{draft.dirty ? 'Unsaved changes' : 'Saved settings'}</small></header>
        <div className="settings-survey__canvas">
          {backgroundPreview && <img key={`background-${backgroundPreview}-${imagePreview?.revision ?? 0}`} className="settings-survey__background" src={backgroundPreview} alt="" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true; setImageNotice('An image could not load. Check its address or try Preview images again.') }} />}
          {iconPreview && <img key={`icon-${iconPreview}-${imagePreview?.revision ?? 0}`} className="settings-survey__icon" src={iconPreview} alt="Start page icon preview" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true; setImageNotice('An image could not load. Check its address or try Preview images again.') }} />}
          {draft.value.title && <h3>{draft.value.title}</h3>}
          {draft.value.subtitle && <p>{draft.value.subtitle}</p>}
          <div className="settings-survey__search" aria-hidden="true"><SearchIcon size={15} /><span>Search or enter an address</span></div>
          {draft.value.showHistory && <div className="settings-survey__history"><span>Example recent input · up to {draft.value.historyLimit || '…'} on first view</span><div><span>Documentation</span><span>Research notes</span></div></div>}
        </div>
        <p className="settings-survey__caption">{unloadedImages ? 'Choose Preview images to load the image addresses. ' : ''}Example history only. Interactive background {draft.value.interactiveBackground ? 'on' : 'off'}. Save to apply your changes.</p>
        {imageNotice && <p role="status" className="settings-survey__image-notice">{imageNotice}</p>}
      </aside></div>
    </section>
    {children}
    <SettingsSaveBar save={save} dirty={draft.dirty} label="Save start page" onSave={() => void submit()} />
  </div>
}
