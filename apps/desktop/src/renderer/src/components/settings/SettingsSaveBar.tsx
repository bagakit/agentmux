import { ActionFeedback } from '@agentmux/client-ui/components/ActionFeedback'
import { Button } from '@agentmux/client-ui/components/Button'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useRef, useState, type Ref } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'

const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeStatusSavedIcon = semanticIconComponent('status.saved')


export function useSettingsSave() {
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const inFlight = useRef(false)

  async function run(operation: () => Promise<void>): Promise<boolean> {
    if (inFlight.current) return false
    inFlight.current = true
    setState('saving')
    setError('')
    setConflict(false)
    try {
      await operation()
      setState('saved')
      return true
    } catch (cause) {
      setError(presentError(cause))
      // Recovery is offered from the owner's code, never from the wording of its message.
      setConflict((cause as { code?: unknown } | null)?.code === 'CONFIG_CONFLICT')
      setState('error')
      return false
    } finally {
      inFlight.current = false
    }
  }
  /** The person chose how to resolve the conflict; the bar returns to the draft's own state. */
  function resolve() { setConflict(false); setError(''); setState('idle') }

  return { state, error, conflict, saving: state === 'saving', run, resolve }
}

/**
 * `dirty` says whether the draft differs from what is saved; `blocked` says why it cannot be saved
 * yet. They are separate facts: an unsaved draft that cannot be saved is still unsaved, never
 * "All changes saved".
 */
/** A draft that can resolve a same-field conflict in place. */
export type SettingsConflictResolution = { useSaved(): void; keepMine(): void }

export function SettingsSaveBar({ save, dirty, label = 'Save changes', scopeLabel, onSave, blocked, resolution, saveButtonRef, shortcut }: {
  save: Pick<ReturnType<typeof useSettingsSave>, 'state' | 'error' | 'saving'> & Partial<Pick<ReturnType<typeof useSettingsSave>, 'conflict' | 'resolve'>>
  dirty: boolean
  label?: string
  scopeLabel?: string
  onSave: () => void
  blocked?: string | undefined
  saveButtonRef?: Ref<HTMLButtonElement>
  shortcut?: string
  /** Present when the draft can adopt the saved value or keep itself over it after a conflict. */
  resolution?: SettingsConflictResolution | undefined
}) {
  const reason = dirty ? blocked?.trim() : undefined
  const resolvable = Boolean(save.conflict && resolution && !save.saving)
  const choose = (pick: (resolution: SettingsConflictResolution) => void) => { pick(resolution!); save.resolve?.() }
  return (
    <div className="settings-pane-actions" data-settings-save-bar data-settings-save-blocked={reason ? '' : undefined} data-settings-conflict={resolvable ? '' : undefined}>
      <ActionFeedback bounded className="settings-save-feedback" role={save.error ? 'alert' : 'status'} tabIndex={save.error ? 0 : undefined}>
        {save.error ? save.error : save.saving ? <><ThemeStatusLoadingIcon animation="spin" size={13} /> {scopeLabel ? `Saving ${scopeLabel}…` : 'Saving changes…'}</> : reason ? `Can’t save yet — ${reason}` : dirty ? scopeLabel ? `${scopeLabel}: unsaved changes` : 'Unsaved changes' : save.state === 'saved' ? <><ThemeStatusSavedIcon size={13} /> {scopeLabel ? `${scopeLabel} saved` : 'Changes saved'}</> : scopeLabel ? `${scopeLabel} saved` : 'All changes saved'}
      </ActionFeedback>
      <Button ref={saveButtonRef} variant="primary" aria-keyshortcuts={shortcut} aria-busy={save.saving} disabled={save.saving || !dirty || Boolean(reason)} onClick={onSave}>{label}</Button>
      {resolvable ? <span className="settings-conflict-actions">
        <Button data-settings-conflict-action="use-saved" onClick={() => choose(item => item.useSaved())}>Use saved</Button>
        <Button data-settings-conflict-action="keep-mine" onClick={() => choose(item => item.keepMine())}>Keep mine</Button>
      </span> : null}
    </div>
  )
}
