import { TextInput } from '@agentmux/client-ui/input'
import { BROWSER_START_PAGE_TITLE_LIMIT, BROWSER_START_PAGE_SUBTITLE_LIMIT, resolveBrowserStartPage, validBrowserStartPageText, validBrowserStartPageImage, type BrowserStartPageConfig } from '../../../../shared/browser-start-page'
import { useSettingDraftRecord } from './use-setting-draft'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'

export function BrowserStartPageSettings({ config, onSave, onOpen }: {
  config?: Partial<BrowserStartPageConfig> | undefined
  onSave(value: Required<BrowserStartPageConfig>, expected: Required<BrowserStartPageConfig>): Promise<void>
  onOpen(): void
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
  return <div className="settings-pane-stack">
    <section className="settings-group">
      <header><span>Browser start page</span><small>Survey</small></header>
      <label className="browser-start-settings__field"><span>Title</span><TextInput aria-label="Start page title" value={draft.value.title} maxLength={BROWSER_START_PAGE_TITLE_LIMIT} onChange={event => draft.setField('title', event.target.value)} /></label>
      <label className="browser-start-settings__field"><span>Subtitle</span><TextInput aria-label="Start page subtitle" value={draft.value.subtitle} maxLength={BROWSER_START_PAGE_SUBTITLE_LIMIT} onChange={event => draft.setField('subtitle', event.target.value)} /></label>
      <label className="browser-start-settings__field"><span>Icon image</span><TextInput aria-label="Start page icon" placeholder="Image URL · leave blank to hide" value={draft.value.icon} onChange={event => draft.setField('icon', event.target.value)} /></label>
      <label className="browser-start-settings__field"><span>Background image</span><TextInput aria-label="Start page background image" placeholder="Image URL · leave blank to hide" value={draft.value.backgroundImage} onChange={event => draft.setField('backgroundImage', event.target.value)} /></label>
      <p className="settings-group-note">Use an image URL or inline image. Empty image fields turn them off.</p>
      <label className="browser-automation-toggle"><input type="checkbox" aria-label="Show recent input cards" checked={draft.value.showHistory} onChange={event => draft.setField('showHistory', event.target.checked)} />
        <span><strong>Show recent addresses and searches</strong><small>Cards use this Browser's saved input history. Turning them off keeps your history.</small></span></label>
    </section>
    <SettingsSaveBar save={save} dirty={draft.dirty} label="Save start page" onSave={() => void submit()} />
    <div className="settings-workflows__inline-action"><button type="button" className="small-button" onClick={onOpen}>Open Survey</button></div>
  </div>
}
