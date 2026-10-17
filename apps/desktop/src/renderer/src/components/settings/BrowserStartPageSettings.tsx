import { TextInput } from '@agentmux/client-ui/input'
import type { ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { BROWSER_START_PAGE_TITLE_LIMIT, BROWSER_START_PAGE_SUBTITLE_LIMIT, resolveBrowserStartPage, validBrowserStartPageText, validBrowserStartPageImage, type BrowserStartPageConfig } from '../../../../shared/browser-start-page'
import { useSettingDraftRecord } from './use-setting-draft'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import '../../styles/settings-survey.css'

const SearchIcon = semanticIconComponent('action.search')

export function BrowserStartPageSettings({ config, onSave, onOpen, children }: {
  config?: Partial<BrowserStartPageConfig> | undefined
  onSave(value: Required<BrowserStartPageConfig>, expected: Required<BrowserStartPageConfig>): Promise<void>
  onOpen(): void
  children?: ReactNode
}) {
  const draft = useSettingDraftRecord(resolveBrowserStartPage(config))
  const save = useSettingsSave()
  async function submit(): Promise<void> {
    const submitted = draft.beginSave()
    submitted.finish(await save.run(async () => {
      const value = submitted.value
      if (!validBrowserStartPageText(value.title, BROWSER_START_PAGE_TITLE_LIMIT) || !validBrowserStartPageText(value.subtitle, BROWSER_START_PAGE_SUBTITLE_LIMIT))
        throw new Error(`Use a single-line title up to ${BROWSER_START_PAGE_TITLE_LIMIT} characters and subtitle up to ${BROWSER_START_PAGE_SUBTITLE_LIMIT} characters. Your draft is kept.`)
      if (!validBrowserStartPageImage(value.icon) || !validBrowserStartPageImage(value.backgroundImage))
        throw new Error('Use an HTTP(S) image URL or an inline PNG, JPEG, WebP, GIF or AVIF image. Leave the field empty to hide it. Your draft is kept.')
      await onSave(value, submitted.expected)
    }))
  }
  return <div className="settings-pane-stack settings-survey">
    <section className="settings-group">
      <header><span>Start page</span><button type="button" className="small-button" onClick={onOpen}>Open Survey</button></header>
      <div className="settings-survey__workspace"><div className="settings-survey__fields">
      <label className="browser-start-settings__field" data-settings-field="start-title"><span>Title</span><TextInput aria-label="Start page title" value={draft.value.title} maxLength={BROWSER_START_PAGE_TITLE_LIMIT} onChange={event => draft.setField('title', event.target.value)} /></label>
      <label className="browser-start-settings__field" data-settings-field="start-subtitle"><span>Subtitle</span><TextInput aria-label="Start page subtitle" value={draft.value.subtitle} maxLength={BROWSER_START_PAGE_SUBTITLE_LIMIT} onChange={event => draft.setField('subtitle', event.target.value)} /></label>
      <label className="browser-start-settings__field" data-settings-field="start-icon"><span>Icon image</span><TextInput aria-label="Start page icon" placeholder="Image URL · leave blank to hide" value={draft.value.icon} onChange={event => draft.setField('icon', event.target.value)} /></label>
      <label className="browser-start-settings__field" data-settings-field="start-background"><span>Background image</span><TextInput aria-label="Start page background image" placeholder="Image URL · leave blank to hide" value={draft.value.backgroundImage} onChange={event => draft.setField('backgroundImage', event.target.value)} /></label>
      <p className="settings-group-note">Use an image URL or inline image. Empty image fields turn them off.</p>
      <label className="browser-automation-toggle" data-settings-field="start-history"><input type="checkbox" aria-label="Show recent input cards" checked={draft.value.showHistory} onChange={event => draft.setField('showHistory', event.target.checked)} />
        <span><strong>Show recent addresses and searches</strong><small>Cards use this Browser's saved input history. Turning them off keeps your history.</small></span></label>
      </div>
      <aside className="settings-survey__preview" aria-label="Start page draft preview">
        <header><strong>Draft preview</strong><small>Text &amp; history layout</small></header>
        <div className="settings-survey__canvas">
          {draft.value.title && <h3>{draft.value.title}</h3>}
          {draft.value.subtitle && <p>{draft.value.subtitle}</p>}
          <div className="settings-survey__search" aria-hidden="true"><SearchIcon size={15} /><span>Search or enter an address</span></div>
          {draft.value.showHistory && <div className="settings-survey__history"><span>Example recent input</span><div><span>Documentation</span><span>Research notes</span></div></div>}
        </div>
        <p className="settings-survey__caption">Save to apply your changes. Images load in Survey; this preview does not read your browsing history.</p>
      </aside></div>
    </section>
    {children}
    <SettingsSaveBar save={save} dirty={draft.dirty} label="Save start page" onSave={() => void submit()} />
  </div>
}
