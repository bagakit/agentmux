import { useId, useState } from 'react'
import { FormRow } from '@agentmux/client-ui/components/FormRow'
import { ComposerTextarea, TextInput } from '@agentmux/client-ui/input'
import '@agentmux/client-ui/input/styles.css'

export default function Fields() {
  const [title, setTitle] = useState('')
  const [draft, setDraft] = useState('')
  const error = useId()
  return <fieldset>
    <legend>Review draft</legend>
    <FormRow label="Title for people receiving the review" description="Use at least two characters.">
      {control => <TextInput {...control}
        aria-invalid={title.length === 1}
        aria-describedby={[control['aria-describedby'], title.length === 1 ? error : null].filter(Boolean).join(' ')}
        value={title} onChange={event => setTitle(event.currentTarget.value)} />}
    </FormRow>
    {title.length === 1 && <p id={error} role="alert">Add one more character.</p>}
    <FormRow label="Notes" description="Share the context for the review.">
      {control => <ComposerTextarea {...control} variant="compact" value={draft} onValueChange={setDraft} />}
    </FormRow>
    <TextInput aria-label="Reference" value="Review board" disabled readOnly />
  </fieldset>
}
