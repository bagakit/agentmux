import { useId } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { resolveComposerInputConfig, validateComposerInputConfig, type ComposerInputConfig } from '@agentmux/client-ui/composer-input-config'
import './message-tool-settings.css'
import { MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT, MESSAGE_TOOL_INITIAL_LAYOUT_IDS, type MessageToolInitialLayout } from '../../../../shared/contracts'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraft, useSettingDraftRecord } from './use-setting-draft'
import { KeyboardShortcutsPane } from './KeyboardShortcutsPane'

const completionFields = [
  { key: 'command', label: 'Commands', detail: 'Agent commands and saved prompts' },
  { key: 'skill', label: 'Skills', detail: 'Available skills' },
  { key: 'reference', label: 'Agents & files', detail: 'Agent cards, files and folders' }
] as const

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
    <figure className="message-tool-preview" aria-label="Input preview">
      <figcaption><span>Input preview</span><span>{draft.dirty || inputDraft.dirty ? 'Unsaved preview' : 'Saved settings'}</span></figcaption>
      <div className="message-tool-preview__composer" data-layout={draft.value}>
        <span className="message-tool-preview__text">Review these changes<span aria-hidden="true" className="message-tool-preview__caret" /></span>
        <div className="message-tool-preview__tools">
          {completionFields.map(field => <span key={field.key} title={`${field.label}: ${inputDraft.value[field.key] || 'Off'}`} data-preview-prefix={field.key} data-disabled={!inputDraft.value[field.key] || undefined}>
            <kbd>{inputDraft.value[field.key] || 'Off'}</kbd><small>{field.label}</small>
          </span>)}
          <span className="message-tool-preview__send" aria-label="Send example">↑</span>
        </div>
      </div>
      <p>{draft.value === 'one-line' ? 'Input and tools share one row.' : 'A separate tool row leaves more room for your message.'} Empty prefixes turn off shortcuts; toolbar menus remain available.</p>
    </figure>
    <section className="settings-group" data-settings-field="initial-layout">
      <header><span>Initial layout</span><small>Saved: {saved === 'one-line' ? 'One line' : 'Two lines'}</small></header>
      <fieldset className="settings-reading-width message-tool-layouts">
        <legend>New Message Tools start with</legend>
        {MESSAGE_TOOL_INITIAL_LAYOUT_IDS.map(layout => <label key={layout} data-selected={draft.value === layout}>
          <input type="radio" name={layoutGroup} value={layout} checked={draft.value === layout}
            onChange={() => draft.setValue(layout)} />
          <span className="message-tool-layout-option"><strong>{layout === 'one-line' ? 'One line' : 'Two lines'}</strong><small>{layout === 'one-line' ? 'Tools beside the input' : 'A separate tool row'}</small></span>
        </label>)}
      </fieldset>
      <p className="settings-workflows__note">Applies to newly opened inputs. Your current layout and drafts stay as you left them.</p>
      <SettingsSaveBar save={saveState} dirty={draft.dirty} label="Save layout" onSave={() => void save()} />
    </section>
    <section className="settings-group" aria-label="Shortcut input" data-message-tool-completion>
      <header><span>Shortcut input</span></header>
      <p className="settings-workflows__note">Choose the symbols that open each menu. Leave a field empty to turn off its shortcut; toolbar menus stay available.</p>
      <div className="message-tool-prefixes">
        {completionFields.map(field => <label key={field.key} data-settings-field={`completion-${field.key}`}>
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
    <details className="message-tool-shortcuts" data-settings-field="message-shortcuts">
      <summary>Message Tool keyboard shortcuts <span>Sending, steering and suggestions</span></summary>
      <KeyboardShortcutsPane group="message-tool" />
    </details>
  </div>
}
