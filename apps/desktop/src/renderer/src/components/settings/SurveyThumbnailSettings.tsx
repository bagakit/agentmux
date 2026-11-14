import type { CSSProperties } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { DEFAULT_SURVEY_THUMBNAIL_LAYOUT, SURVEY_THUMBNAIL_HEIGHT, SURVEY_THUMBNAIL_COLUMNS, resolveSurveyThumbnailLayout, surveyThumbnailStyle, type SurveyThumbnailLayout } from '../../../../shared/survey-thumbnail-layout'
import { useSettingDraftRecord } from './use-setting-draft'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'

const BrowserIcon = semanticIconComponent('object.browser')
const CloseIcon = semanticIconComponent('action.close')
const examples = ['Documentation', 'Working notes', 'Source library', 'Research draft', 'Reference', 'Open question']

/** A local density sample. It neither reads nor mounts a real Browser or draggable Tab. */
export function SurveyThumbnailSettings({ preferences, navigationWidth, onSave }: {
  preferences?: Partial<SurveyThumbnailLayout> | undefined
  navigationWidth: number
  onSave(value: SurveyThumbnailLayout, expected: SurveyThumbnailLayout): Promise<void>
}) {
  const draft = useSettingDraftRecord(resolveSurveyThumbnailLayout(preferences)), save = useSettingsSave()
  async function commit(): Promise<void> {
    const submitted = draft.beginSave()
    submitted.finish(await save.run(() => onSave(submitted.value, submitted.expected)))
  }
  return <section className="settings-group settings-survey-thumbnails" aria-label="Research thumbnail layout">
    <header><span>Research thumbnails</span><small>Navigation only</small></header>
    <div className="settings-survey-thumbnails__workspace">
      <div className="settings-survey-thumbnails__controls">
        <label data-settings-field="thumbnail-height"><span>Thumbnail height<output>{draft.value.height} px</output></span>
          <input aria-label="Research thumbnail height" type="range" min={SURVEY_THUMBNAIL_HEIGHT.min} max={SURVEY_THUMBNAIL_HEIGHT.max} step={1} value={draft.value.height} onChange={event => draft.setField('height', Number(event.target.value))} />
          <small>The image area, without changing the original page.</small></label>
        <label data-settings-field="thumbnail-columns"><span>Maximum per row<output>{draft.value.maxColumns}</output></span>
          <input aria-label="Maximum thumbnails per row" type="range" min={SURVEY_THUMBNAIL_COLUMNS.min} max={SURVEY_THUMBNAIL_COLUMNS.max} step={1} value={draft.value.maxColumns} onChange={event => draft.setField('maxColumns', Number(event.target.value))} />
          <small>A narrow sidebar shows fewer columns to keep each card readable.</small></label>
        <div className="settings-survey-thumbnails__reset"><button type="button" className="small-button" onClick={() => { draft.setField('height', DEFAULT_SURVEY_THUMBNAIL_LAYOUT.height); draft.setField('maxColumns', DEFAULT_SURVEY_THUMBNAIL_LAYOUT.maxColumns) }}>Use default sizes</button>
          {draft.dirty ? <button type="button" className="small-button" disabled={draft.saving} onClick={draft.useSaved}>Discard layout changes</button> : null}</div>
      </div>
      <aside className="survey-thumbnail-preview" aria-label="Research thumbnail draft preview" style={{ ...surveyThumbnailStyle(draft.value), '--survey-preview-navigation-width': `${navigationWidth}px` } as CSSProperties}>
        <header><strong>Example navigation</strong><small>{draft.dirty ? 'Unsaved preview' : 'Saved settings'}</small></header>
        <div className="survey-thumbnail-preview__viewport" tabIndex={0} role="region" aria-label="Scroll thumbnail sample"><div className="survey-thumbnail-preview__rail" aria-hidden="true"><div className="survey-thumbnail-preview__items">
          <div className="survey-item-row" data-multi-tab="true"><div className="survey-item-tabs">{examples.map((name, index) => <div className="survey-tab-cell" key={name}>
            <div className="survey-tab-column" aria-current={index === 0 ? 'true' : undefined}>
              <span className="survey-tab-preview"><span className="survey-tab-preview__placeholder" /><span className="survey-tab-column__marks"><BrowserIcon size={14} /></span></span>
              <span className="survey-tab-label"><span>{name}</span></span>{index === 0 ? <span className="survey-tab-status">Unconfirmed</span> : null}
            </div><span className="survey-tab-close"><CloseIcon size={12} /></span>
          </div>)}</div></div>
        </div></div></div>
        <p>Sample content at saved sidebar width. Narrow windows may show fewer columns. Save to apply the layout.</p>
      </aside>
    </div>
    <SettingsSaveBar save={save} dirty={draft.dirty} resolution={draft} scopeLabel="Thumbnail layout" label="Save thumbnail layout" onSave={() => void commit()} />
  </section>
}
