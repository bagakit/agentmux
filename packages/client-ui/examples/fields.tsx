import { useId, useState } from 'react'
import { FormRow } from '@agentmux/client-ui/components/FormRow'
import { ComposerTextarea, SearchInput, TextInput } from '@agentmux/client-ui/input'
import '@agentmux/client-ui/input/styles.css'

export default function Fields() {
  const [title, setTitle] = useState('')
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const matches = ['Design review', 'Release review'].filter(name => name.toLowerCase().includes(query.trim().toLowerCase()))
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
    <SearchInput aria-label="Find a review" clearLabel="Clear review filter" placeholder="Find a review…" value={query} onValueChange={setQuery} />
    {matches.length ? <ul>{matches.map(name => <li key={name}>{name}</li>)}</ul> : <p role="status">No matching reviews.</p>}
  </fieldset>
}
