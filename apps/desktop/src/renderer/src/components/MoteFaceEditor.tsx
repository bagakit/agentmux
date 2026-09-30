import { MOTE_FACE_PARTS, type MoteFace as MoteFaceChoice } from '../../../shared/mote-avatars'
import { MoteFace } from './MoteFace'

const labels = { shape: 'Face', palette: 'Color', eyes: 'Eyes', brows: 'Brows', mouth: 'Mouth', accessory: 'Detail' } as const
export function MoteFaceEditor({ face, disabled, onChange }: { face: MoteFaceChoice; disabled: boolean; onChange(face: MoteFaceChoice): void }) {
  return <div className="mote-face-editor">
    <div className="mote-face-editor__preview" role="img" aria-label="Your Mote face preview"><MoteFace face={face} /></div>
    {(Object.keys(MOTE_FACE_PARTS) as Array<keyof typeof MOTE_FACE_PARTS>).map(part => <fieldset key={part}>
      <legend>{labels[part]}</legend>
      <div>{MOTE_FACE_PARTS[part].map(value => <button type="button" className="small-button" key={value}
        aria-label={`${labels[part]} · ${value}`} aria-pressed={face[part] === value} disabled={disabled}
        data-mote-face-part={part} data-mote-face-value={value} onClick={() => onChange({ ...face, [part]: value })}>
        {part === 'palette' ? <span className="mote-face-editor__color" data-palette={value} aria-hidden="true" /> : null}{value}
      </button>)}</div>
    </fieldset>)}
  </div>
}
