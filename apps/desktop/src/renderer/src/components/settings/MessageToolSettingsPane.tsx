import { useId } from 'react'
import { MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT, MESSAGE_TOOL_INITIAL_LAYOUT_IDS, type MessageToolInitialLayout } from '../../../../shared/contracts'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraft } from './use-setting-draft'

export function MessageToolSettingsPane({ initialLayout, onSave }: {
  initialLayout?: MessageToolInitialLayout
  onSave(value: MessageToolInitialLayout, expected: MessageToolInitialLayout): Promise<void>
}) {
  const saved = initialLayout ?? MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT
  const draft = useSettingDraft(saved)
  const layoutGroup = useId()
  const saveState = useSettingsSave()

  async function save(): Promise<void> {
    const submitted = draft.beginSave()
    submitted.finish(await saveState.run(() => onSave(submitted.value, submitted.expected)))
  }

  return <div className="settings-pane-stack" data-message-tool-settings>
    <section className="settings-group">
      <header><span>Initial layout</span><small>Saved: {saved === 'one-line' ? 'One line' : 'Two lines'}</small></header>
      <fieldset className="settings-reading-width">
        <legend>New Message Tools start with</legend>
        {MESSAGE_TOOL_INITIAL_LAYOUT_IDS.map(layout => <label key={layout} data-selected={draft.value === layout}>
          <input type="radio" name={layoutGroup} value={layout} checked={draft.value === layout}
            onChange={() => draft.setValue(layout)} />
          <span><strong>{layout === 'one-line' ? 'One line' : 'Two lines'}</strong><small>{layout === 'one-line' ? 'Keep tools compact beside the input' : 'Show a separate tool row below the input'}</small></span>
        </label>)}
      </fieldset>
      <p className="settings-workflows__note">Applies to newly opened inputs. Your current layout and drafts stay as you left them.</p>
    </section>
    <section className="settings-group" aria-label="Mailbox">
      <header><span>Mailbox</span></header>
      <p className="settings-workflows__note">Open the mailbox beside Send to read replies, manage queued messages, or search this Agent’s input history. Each Agent keeps its own records; history shows the source when recorded.</p>
    </section>
    <SettingsSaveBar save={saveState} dirty={draft.dirty} label="Save layout" onSave={() => void save()} />
  </div>
}
