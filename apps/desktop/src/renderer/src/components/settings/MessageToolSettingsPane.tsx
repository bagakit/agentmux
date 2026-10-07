import { useId } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { resolveComposerInputConfig, validateComposerInputConfig, type ComposerInputConfig } from '@agentmux/client-ui/composer-input-config'
import './message-tool-settings.css'
import { MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT, MESSAGE_TOOL_INITIAL_LAYOUT_IDS, type MessageToolInitialLayout } from '../../../../shared/contracts'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraft, useSettingDraftRecord } from './use-setting-draft'
import { KeyboardShortcutsPane } from './KeyboardShortcutsPane'

export function MessageToolSettingsPane({ initialLayout, completion, onSave, onSaveCompletion }: {
  initialLayout?: MessageToolInitialLayout
  completion?: ComposerInputConfig
  onSaveCompletion(value: ComposerInputConfig, expected: ComposerInputConfig): Promise<void>
  onSave(value: MessageToolInitialLayout, expected: MessageToolInitialLayout): Promise<void>
}) {
  const saved = initialLayout ?? MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT
  const draft = useSettingDraft(saved)
  const layoutGroup = useId()
  const saveState = useSettingsSave()
  const inputConfig = resolveComposerInputConfig(completion)
  const inputDraft = useSettingDraftRecord({ command: inputConfig.command ?? '', skill: inputConfig.skill ?? '', reference: inputConfig.reference ?? '', keywords: inputConfig.keywords })
  const completionSave = useSettingsSave()
  const errorId = useId()
  const toConfig = (fields: typeof inputDraft.value): ComposerInputConfig => ({ command: fields.command || null, skill: fields.skill || null, reference: fields.reference || null, keywords: fields.keywords })
  const inputError = validateComposerInputConfig(toConfig(inputDraft.value))

  async function saveCompletion(): Promise<void> {
    if (inputError) return
    const submitted = inputDraft.beginSave()
    submitted.finish(await completionSave.run(() => onSaveCompletion(toConfig(submitted.value), toConfig(submitted.expected))))
  }

  async function save(): Promise<void> {
    const submitted = draft.beginSave()
    submitted.finish(await saveState.run(() => onSave(submitted.value, submitted.expected)))
  }

  return <div className="settings-pane-stack" data-message-tool-settings>
    <section className="settings-group" data-settings-field="initial-layout">
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
      <SettingsSaveBar save={saveState} dirty={draft.dirty} label="Save layout" onSave={() => void save()} />
    </section>
    <section className="settings-group" aria-label="Shortcut input" data-message-tool-completion>
      <header><span>Shortcut input</span></header>
      <p className="settings-workflows__note">Choose the symbols that open each menu. Leave a field empty to turn off its shortcut; toolbar menus stay available.</p>
      <div className="message-tool-prefixes">
        {([{ key: 'command', label: 'Commands', detail: 'Agent commands and saved prompts' }, { key: 'skill', label: 'Skills', detail: 'Available skills' }, { key: 'reference', label: 'Agents & files', detail: 'Agent cards, files and folders' }] as const).map(field => <label key={field.key} data-settings-field={`completion-${field.key}`}>
          <span>{field.label}</span>
          <TextInput aria-label={`${field.label} prefix`} aria-describedby={inputError ? errorId : undefined} aria-invalid={!!inputError}
            value={inputDraft.value[field.key]} placeholder="Off" spellCheck={false} autoComplete="off"
            onChange={event => inputDraft.setField(field.key, event.target.value)} />
          <small>{field.detail}</small>
        </label>)}
      </div>
      <label className="message-tool-keywords" data-settings-field="completion-keywords"><input type="checkbox" checked={inputDraft.value.keywords}
        onChange={event => inputDraft.setField('keywords', event.target.checked)} />Suggest saved prompts by keyword</label>
      {inputError && <p id={errorId} className="settings-inline-error" role="alert">{inputError}</p>}
      <SettingsSaveBar save={completionSave} dirty={inputDraft.dirty} disabled={!!inputError} label="Save shortcut input" onSave={() => void saveCompletion()} />
    </section>
    <section className="settings-group" aria-label="Message Tool keyboard shortcuts" data-settings-field="message-shortcuts">
      <header><span>Keyboard shortcuts</span></header>
      <KeyboardShortcutsPane group="message-tool" />
    </section>
    <section className="settings-group" aria-label="Mailbox" data-settings-field="mailbox">
      <header><span>Mailbox</span></header>
      <p className="settings-workflows__note">Open the mailbox beside Send to read replies, manage queued messages, or search this Agent’s input history. Each Agent keeps its own records; history shows the source when recorded.</p>
    </section>
  </div>
}
