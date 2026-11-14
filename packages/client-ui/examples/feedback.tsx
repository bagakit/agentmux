import { useState } from 'react'
import { ActionFeedback } from '@agentmux/client-ui/components/ActionFeedback'
import { Notice } from '@agentmux/client-ui/components/Notice'
import { InlineRenameField } from '@agentmux/client-ui/components/InlineRenameField'
import '@agentmux/client-ui/input/styles.css'
import '@agentmux/client-ui/styles/buttons.css'
import '@agentmux/client-ui/styles/semantic-icons.css'
import '@agentmux/client-ui/styles/inline-rename-field.css'
import '@agentmux/client-ui/styles/notice.css'

export default function Feedback() {
  const [value, setValue] = useState('Draft review')
  const [saved, setSaved] = useState(value)
  const [finish, setFinish] = useState<(() => void) | null>(null)
  const [error, setError] = useState<string | null>(null)
  return <fieldset>
    <legend>Rename a review</legend>
    <InlineRenameField label="Review name" value={value} pending={finish !== null} error={error}
      onValueChange={next => { setValue(next); setError(null) }}
      onCancel={() => { setValue(saved); setError(null) }}
      onCommit={() => new Promise<void>(resolve => { setError(null); setFinish(() => resolve) })} />
    <button disabled={!finish} onClick={() => { setSaved(value); finish?.(); setFinish(null) }}>Confirm save</button>
    <button disabled={!finish} onClick={() => { setError('This name is already in use.'); finish?.(); setFinish(null) }}>Reject save</button>
    <Notice density="compact" tone={error ? 'info' : 'success'}>
      <ActionFeedback bounded role="status"><output aria-live="off">Saved name {saved}</output></ActionFeedback>
    </Notice>
  </fieldset>
}
