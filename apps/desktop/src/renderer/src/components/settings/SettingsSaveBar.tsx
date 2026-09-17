import { Check, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import { presentError } from '../../lib/error-presentation'

export function useSettingsSave() {
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState('')

  async function run(operation: () => Promise<void>): Promise<boolean> {
    setState('saving')
    setError('')
    try {
      await operation()
      setState('saved')
      return true
    } catch (cause) {
      setError(presentError(cause))
      setState('error')
      return false
    }
  }

  return { state, error, saving: state === 'saving', run }
}

export function SettingsSaveBar({ save, dirty, label = 'Save changes', onSave, disabled = false }: {
  save: ReturnType<typeof useSettingsSave>
  dirty: boolean
  label?: string
  onSave: () => void
  disabled?: boolean
}) {
  return (
    <div className="settings-pane-actions">
      <span className={`settings-save-feedback ${save.error ? 'settings-inline-error' : ''}`} role={save.error ? 'alert' : 'status'}>
        {save.error ? save.error : save.saving ? <><LoaderCircle className="spin" size={13} /> Saving changes…</> : dirty ? 'Unsaved changes' : save.state === 'saved' ? <><Check size={13} /> Changes saved</> : 'All changes saved'}
      </span>
      <button className="primary-button" disabled={save.saving || !dirty || disabled} onClick={onSave}>{save.saving ? 'Saving…' : label}</button>
    </div>
  )
}
