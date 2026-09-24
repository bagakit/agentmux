import { ChevronRight, LoaderCircle, SlidersHorizontal } from 'lucide-react'
import type { BrowserToolbarConfig } from '../../../shared/contracts'
import { BROWSER_TOOLBAR_ITEM_ORDER, type BrowserToolbarItem } from '../../../shared/browser-toolbar'
import { BROWSER_TOOLBAR_ITEM_LABELS } from '../lib/browser-toolbar'
import { useSettingDraftRecord } from './settings/use-setting-draft'
import { useSettingsSave } from './settings/SettingsSaveBar'

export function BrowserToolbarPreferences({
  toolbar,
  saving,
  onSave
}: {
  toolbar: BrowserToolbarConfig
  saving: boolean
  onSave(toolbar: BrowserToolbarConfig, expected: BrowserToolbarConfig): Promise<void>
}) {
  const draft = useSettingDraftRecord(toolbar)
  const saveState = useSettingsSave()
  const busy = saving || saveState.saving

  function setItem(item: BrowserToolbarItem, shown: boolean): void {
    draft.setField(item, shown)
  }

  async function save(): Promise<void> {
    const submitted = draft.beginSave()
    submitted.finish(await saveState.run(() => onSave(submitted.value, submitted.expected)))
  }

  return (
    <section className="browser-tools-preferences" aria-label="Browser bar visibility">
      <details>
        <summary aria-label="Browser bar settings">
          {busy ? <LoaderCircle className="spin" size={14} /> : <SlidersHorizontal size={14} />}
          <strong>Browser bar</strong>{draft.dirty ? <small>Unsaved</small> : null}<ChevronRight size={13} />
        </summary>
        <div className="browser-tools-preferences__body">
          <p>External open is always visible. Narrow panes keep More available.</p>
          <div className="browser-tools-preferences__items">
            {BROWSER_TOOLBAR_ITEM_ORDER.map((item) => (
              <label key={item}>
                <input
                  type="checkbox"
                  checked={draft.value[item]}
                  disabled={busy}
                  onChange={(event) => setItem(item, event.target.checked)}
                />
                <span>{BROWSER_TOOLBAR_ITEM_LABELS[item]}</span>
              </label>
            ))}
          </div>
          <button
            className="small-button"
            type="button"
            disabled={!draft.dirty || busy}
            onClick={() => void save()}
          >
            {busy ? <LoaderCircle className="spin" size={12} /> : null}
            {busy ? 'Saving…' : 'Save Browser bar'}
          </button>
        </div>
      </details>
      {saveState.error ? <p className="settings-inline-error" role="alert">{saveState.error}</p> : null}
    </section>
  )
}
