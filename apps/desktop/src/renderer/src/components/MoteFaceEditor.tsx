import { Check } from 'lucide-react'
import { MOTE_FACE_PARTS, type MoteFace as MoteFaceChoice } from '../../../shared/mote-avatars'
import { MoteFace } from './MoteFace'
import { MoteIdentityMotion } from './MoteIdentityMotion'

const labels = { shape: 'Face', palette: 'Color', eyes: 'Eyes', brows: 'Brows', mouth: 'Mouth', accessory: 'Detail' } as const
export function MoteFaceEditor({ face, disabled, onChange, visible = true }: { face: MoteFaceChoice; visible?: boolean; disabled: boolean; onChange(face: MoteFaceChoice): void }) {
  return <div className="mote-face-editor" hidden={!visible}>
    <div className="mote-face-editor__preview" role="img" aria-label="Your Mote face preview"><MoteIdentityMotion visible={visible}>{expression => <MoteFace face={face} expression={expression} />}</MoteIdentityMotion></div>
    {(Object.keys(MOTE_FACE_PARTS) as Array<keyof typeof MOTE_FACE_PARTS>).map(part => <fieldset key={part}>
      <legend>{labels[part]}</legend>
      <div>{MOTE_FACE_PARTS[part].map(value => <button type="button" className={`small-button${face[part] === value ? ' small-button--active' : ''}`} key={value}
        aria-label={`${labels[part]} · ${value}`} aria-pressed={face[part] === value} disabled={disabled}
        data-mote-face-part={part} data-mote-face-value={value} onClick={() => onChange({ ...face, [part]: value })}>
        {part !== 'palette' ? <span className="mote-face-editor__sample" aria-hidden="true"><MoteFace face={{ ...face, [part]: value }} /></span> : <span className="mote-face-editor__color" data-palette={value} aria-hidden="true" /> }<span className="mote-face-editor__label">{value}</span>
        <Check size={12} className="mote-avatar-selection-mark" aria-hidden="true" />
      </button>)}</div>
    </fieldset>)}
  </div>
}
