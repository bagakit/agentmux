import { ComposerTextarea } from '@agentmux/client-ui/input'
import type { NoteShape, NoteTemplate } from './drawing-model'

const templates = [
  { id: '', label: 'Free note', hint: 'What should the Agent notice?' },
  { id: 'observation', label: 'Observation', hint: 'What happens here?' },
  { id: 'expected', label: 'Expected', hint: 'What should happen instead?' },
  { id: 'request', label: 'Request', hint: 'What should the Agent change or check?' }
] as const

export function AnnotationNotes({ notes, selected, draft, busy, onSelect, onDraft, onCommit, onTemplate, onLocate }: {
  notes: NoteShape[]; selected: NoteShape | null; draft: string; busy: boolean
  onSelect(note: NoteShape): void; onDraft(text: string): void; onCommit(): void
  onTemplate(template: NoteTemplate | undefined): void; onLocate(): void
}) {
  if (!notes.length) return null
  return <aside className="image-annotation-editor__notes" aria-label="Numbered annotations">
    <header><strong>Notes</strong><small>{notes.length}</small></header>
    <div className="image-annotation-editor__note-list">{notes.map(note => <button type="button" key={note.id}
      className={note.id === selected?.id ? 'selected' : ''} aria-label={'Note ' + note.number} disabled={busy} onClick={() => onSelect(note)}>
      <b>{note.number}</b><span>{note.note || 'Add a note…'}</span>
    </button>)}</div>
    {selected ? <>
      <div className="image-annotation-editor__note-actions"><label>Intent<select aria-label="Note template" value={selected.template ?? ''}
        disabled={busy} onChange={event => onTemplate((event.target.value || undefined) as NoteTemplate | undefined)}>
        {templates.map(template => <option value={template.id} key={template.id}>{template.label}</option>)}
      </select></label><button type="button" onClick={onLocate}>Locate</button></div>
      <label><span>{'Note ' + selected.number}</span><ComposerTextarea aria-label="Note text" value={draft} disabled={busy}
        placeholder={templates.find(template => template.id === (selected.template ?? ''))!.hint} onValueChange={onDraft} onBlur={onCommit} /></label>
    </> : <span className="image-annotation-editor__hint">Select a number to add context</span>}
  </aside>
}
