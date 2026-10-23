import { useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { MOTE_FACE_PARTS, type MoteFace as MoteFaceChoice } from '../../../shared/mote-avatars'
import { MoteFace } from './MoteFace'
import { MoteIdentityMotion } from './MoteIdentityMotion'
import { SpaceObjectIcon } from './SpaceObjectIcon'

const ThemeStatusSelectedIcon = semanticIconComponent('status.selected')

const labels = { shape: 'Face', palette: 'Color', eyes: 'Eyes', brows: 'Brows', mouth: 'Mouth', accessory: 'Detail', nose: 'Nose', marking: 'Marks' } as const
type PartKey = keyof typeof MOTE_FACE_PARTS
type PartGroup = 'all' | 'base' | 'expr' | 'detail'
const partGroups: Record<PartKey, Exclude<PartGroup, 'all'>> = {
  shape: 'base', palette: 'base', eyes: 'expr', brows: 'expr', mouth: 'expr', nose: 'expr', accessory: 'detail', marking: 'detail'
}
const groupTabs: ReadonlyArray<{ id: PartGroup; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'base', label: 'Head & color' },
  { id: 'expr', label: 'Expression' },
  { id: 'detail', label: 'Details' }
]
const presets: ReadonlyArray<{ id: string; label: string; face: MoteFaceChoice }> = [
  { id: 'pmo', label: 'Calm PMO', face: { kind: 'face', shape: 'soft', palette: 'slate', eyes: 'oval', brows: 'straight', mouth: 'small', accessory: 'glasses', nose: 'bridge', marking: 'none' } },
  { id: 'geek', label: 'Geek', face: { kind: 'face', shape: 'round', palette: 'mint', eyes: 'spark', brows: 'curious', mouth: 'cat', accessory: 'antenna', nose: 'button', marking: 'freckles' } },
  { id: 'muse', label: 'Muse', face: { kind: 'face', shape: 'diamond', palette: 'lavender', eyes: 'wink', brows: 'arched', mouth: 'smirk', accessory: 'horns', nose: 'round', marking: 'blush' } }
]

function MoteFacePartGlyph({ part, value }: { part: PartKey; value: string }) {
  if (part === 'shape') {
    return <svg className="mote-face mote-face--part" viewBox="6 6 52 54" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinejoin="round">
      {value === 'slim' ? <path d="M18 10C22 10.6 25.5 13 28 15.5C30 15 33 14.8 35.5 15C45 15.5 50 23.5 50 35C50 47 42.5 55 32 55C21.5 55 14 47.2 14 35.5C14 30 15.2 25.5 17 22L18 10Z" />
        : value === 'diamond' ? <path d="M16 10L27.5 15L36 14.2L48 21L52.5 34.5L47.5 47.5L32 56L16.5 47.5L11.5 34.5L15 22Z" />
          : value === 'square' ? <path d="M14.5 10L26.5 15.5H44C49 15.5 53 19.5 53 24.5V44.5C53 49.8 48.8 54 43.5 54H20.5C15.2 54 11 49.8 11 44.5V24L13.5 19.5Z" />
            : value === 'round' ? <path d="M15.5 10.2C21 11 25.5 13.2 28.8 16C31 15.4 33.5 15 36 15.2C46.5 15.5 54 23.5 54 34.8C54 46.2 45.2 54 32 54C19 54 10 46.5 10 35.2C10 30 11.4 25.5 13.8 22Z" />
              : <path d="M14.5 9.8C20.2 10.5 25 13 28.4 16C31.2 15 34.2 14.6 37.5 14.8C48.2 15.2 54 23 54 34.2C54 46 45.2 54 31.8 54C18.5 54 10 46.2 10 35C10 30 11.5 25.5 13.6 22Z" />}
    </svg>
  }
  if (part === 'eyes') {
    return <svg className="mote-face mote-face--part" viewBox="14 26 36 18" aria-hidden="true">
      {value === 'spark' ? <><path d="M22 29L24 33L27 34L24 36L22 40L20 36L17 34L20 33Z" fill="currentColor" /><path d="M42 29L44 33L47 34L44 36L42 40L40 36L37 34L40 33Z" fill="currentColor" /></>
        : value === 'calm' ? <path d="M18 35Q22 38 26 35M38 35Q42 38 46 35" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          : <><ellipse cx="22" cy="35" rx={value === 'oval' ? 2.4 : 3.1} ry={value === 'oval' ? 4.3 : 3.3} fill="currentColor" />
            {value === 'wink' ? <path d="M38 36Q42 32 46 36" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /> : <ellipse cx="42" cy="35" rx={value === 'oval' ? 2.4 : 3.1} ry={value === 'oval' ? 4.3 : 3.3} fill="currentColor" />}
            {value === 'lashes' ? <path d="M18 33L16 31M21 32L20 29M39 32L38 29M45 33L48 31" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /> : null}</>}
    </svg>
  }
  if (part === 'brows') {
    const paths: Record<string, string> = {
      soft: 'M18 28Q22 25 26 28M38 28Q42 25 46 28',
      straight: 'M18 27H26M38 27H46',
      curious: 'M18 28Q22 24 26 27M38 26Q42 22 46 25',
      bold: 'M17 28Q22 25 27 28M37 28Q42 25 47 28',
      arched: 'M18 28Q22 21 26 27M38 27Q42 21 46 28',
      angled: 'M18 24L26 28M38 28L46 24'
    }
    return <svg className="mote-face mote-face--part" viewBox="14 19 36 14" aria-hidden="true">
      <path d={paths[value] ?? paths.soft} fill="none" stroke="currentColor" strokeWidth={value === 'bold' ? 3.5 : 2.2} strokeLinecap="round" />
    </svg>
  }
  if (part === 'mouth') {
    return <svg className="mote-face mote-face--part" viewBox="20 39 24 15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      {value === 'small' ? <path d="M28 46Q32 48.5 36 46" />
        : value === 'grin' ? <path d="M25 44H39Q37.5 50.5 32 50.5Q26.5 50.5 25 44Z" fill="currentColor" />
          : value === 'cat' ? <path d="M24 45.5Q28 50.5 32 45.5Q36 50.5 40 45.5" />
            : value === 'smirk' ? <path d="M26 47.5Q33 49.5 39 43" />
              : value === 'tooth' ? <><path d="M26 44.5Q32 49.5 38 44.5" /><rect x="30" y="46" width="4" height="3.2" fill="currentColor" stroke="none" /></>
                : <path d="M26 44.5Q32 49.5 38 44.5" />}
    </svg>
  }
  if (part === 'nose') {
    return <svg className="mote-face mote-face--part" viewBox="22 31 20 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      {value === 'button' ? <path d="M29 40Q32 43 35 40" />
        : value === 'bridge' ? <path d="M32 34L29.5 41.5H34.5" />
          : value === 'round' ? <ellipse cx="32" cy="39.5" rx="3.6" ry="2.6" fill="currentColor" stroke="none" />
            : <circle cx="32" cy="39" r="3.2" strokeDasharray="2 2" opacity=".55" />}
    </svg>
  }
  if (part === 'marking') {
    return <svg className="mote-face mote-face--part" viewBox="12 20 40 28" aria-hidden="true">
      {value === 'freckles' ? <g fill="currentColor"><circle cx="18" cy="36" r="1.4" /><circle cx="22" cy="39" r="1.4" /><circle cx="26" cy="36" r="1.4" /><circle cx="38" cy="36" r="1.4" /><circle cx="42" cy="39" r="1.4" /><circle cx="46" cy="36" r="1.4" /></g>
        : value === 'blush' ? <g fill="currentColor" opacity=".75"><ellipse cx="20" cy="36" rx="5.5" ry="3" /><ellipse cx="44" cy="36" rx="5.5" ry="3" /></g>
          : value === 'scar' ? <path d="M35 24L29 42M27 30L36 35" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            : <circle cx="32" cy="34" r="5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeDasharray="2.5 2.5" opacity=".55" />}
    </svg>
  }
  return <svg className="mote-face mote-face--part" viewBox="6 2 52 38" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {value === 'tuft' ? <path d="M24 25Q24 11 34 11Q29 18 37 20Q40 16 42 14Q44 26 32 27Z" fill="currentColor" stroke="none" />
      : value === 'antenna' ? <><path d="M32 28V11" /><circle cx="32" cy="8" r="4" fill="currentColor" /></>
        : value === 'swept' ? <path d="M12 28Q8 11 29 10Q46 8 52 23Q40 19 37 17Q28 30 12 28Z" fill="currentColor" stroke="none" />
          : value === 'curls' ? <g fill="currentColor" stroke="none"><circle cx="16" cy="23" r="6" /><circle cx="23" cy="17" r="6" /><circle cx="32" cy="15" r="7" /><circle cx="41" cy="17" r="6" /><circle cx="48" cy="23" r="6" /></g>
            : value === 'glasses' ? <><rect x="13" y="15" width="15" height="12" rx="3.5" /><rect x="36" y="15" width="15" height="12" rx="3.5" /><path d="M28 19Q32 17 36 19M9 18H13M51 18H55" /></>
              : value === 'ears' ? <path d="M14 28Q6 16 12 11L25 24M39 24L52 11Q58 16 50 28" />
                : value === 'horns' ? <path d="M16 27Q8 20 13 8Q16 20 26 21M38 21Q48 20 51 8Q56 20 48 27" fill="currentColor" stroke="none" />
                  : value === 'beard' ? <path d="M14 14Q21 20 27 19L32 23L37 19Q43 20 50 14L46 26Q32 36 18 26Z" fill="currentColor" stroke="none" />
                    : <circle cx="32" cy="21" r="6" strokeDasharray="2.5 2.5" opacity=".55" />}
  </svg>
}

export function MoteFaceEditor({ face, automatic = false, disabled, onChange, visible = true }: {
  face: MoteFaceChoice; automatic?: boolean | undefined; visible?: boolean; disabled: boolean; onChange(face: MoteFaceChoice): void
}) {
  const [group, setGroup] = useState<PartGroup>('all')
  const shuffle = () => {
    const pick = <T extends string>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!
    onChange({
      kind: 'face',
      shape: pick(MOTE_FACE_PARTS.shape),
      palette: pick(MOTE_FACE_PARTS.palette),
      eyes: pick(MOTE_FACE_PARTS.eyes),
      brows: pick(MOTE_FACE_PARTS.brows),
      mouth: pick(MOTE_FACE_PARTS.mouth),
      accessory: pick(MOTE_FACE_PARTS.accessory),
      nose: pick(MOTE_FACE_PARTS.nose),
      marking: pick(MOTE_FACE_PARTS.marking)
    })
  }
  return <div className="mote-face-editor" hidden={!visible}>
    <div className="mote-avatar-stage">
      {automatic ? <div className="mote-avatar-preview" role="img" aria-label="Your Mote automatic avatar preview">
        <SpaceObjectIcon kind="mote" name="Mote" manualIcon={null} visible={visible} />
      </div> : <div className="mote-face-editor__preview" role="img" aria-label="Your Mote face preview">
        <MoteIdentityMotion visible={visible}>{expression => <MoteFace face={face} expression={expression} />}</MoteIdentityMotion>
      </div>}
      <div className="mote-avatar-stage__aside">
        <div className="mote-avatar-stage__header">
          <span className="mote-avatar-stage__source">
            <strong>{automatic ? 'Automatic companion' : `Face · ${face.palette}`}</strong>
            <small>{automatic ? 'Default Mote' : '2D Face'}</small>
          </span>
          <button type="button" disabled={disabled} aria-label="Shuffle face" className="small-button mote-avatar-stage__shuffle" onClick={shuffle}>Shuffle</button>
        </div>
        <div className="mote-avatar-stage__sizes" aria-label="Actual face sizes">
          <div className="mote-avatar-stage__chip">
            <span className="mote-avatar-stage__slot mote-avatar-stage__slot--45" aria-hidden="true">
              {automatic ? <SpaceObjectIcon kind="mote" name="Mote" manualIcon={null} visible={false} /> : <MoteFace face={face} rendering="static" />}
            </span>
            <span className="mote-avatar-stage__chip-meta"><strong>45 px</strong><small>Directory</small></span>
          </div>
          <div className="mote-avatar-stage__chip">
            <span className="mote-avatar-stage__slot mote-avatar-stage__slot--24" aria-hidden="true">
              {automatic ? <SpaceObjectIcon kind="mote" name="Mote" manualIcon={null} visible={false} /> : <MoteFace face={face} rendering="static" />}
            </span>
            <span className="mote-avatar-stage__chip-meta"><strong>24 px</strong><small>Chat</small></span>
          </div>
        </div>
        <div className="mote-avatar-stage__hint"><span>{automatic ? 'Automatic default staged · Pick any part to customize' : 'Move pointer to preview gaze · Articulated 2D rig'}</span></div>
      </div>
    </div>
    <div className="mote-face-editor__toolbar">
      <div className="mote-face-editor__groups" role="group" aria-label="Face part groups">
        {groupTabs.map(tab => <button key={tab.id} type="button" disabled={disabled} aria-pressed={group === tab.id} className="mote-face-editor__group-tab"
          onClick={() => setGroup(tab.id)}>{tab.label}</button>)}
      </div>
      <div className="mote-face-editor__presets" role="group" aria-label="Face presets">
        {presets.map(preset => <button key={preset.id} type="button" disabled={disabled} className="mote-face-editor__preset"
          onClick={() => onChange({ ...preset.face })}>{preset.label}</button>)}
      </div>
    </div>
    {(Object.keys(MOTE_FACE_PARTS) as PartKey[]).map(part => <fieldset key={part} data-mote-face-part={part} hidden={group !== 'all' && partGroups[part] !== group}>
      <legend>{labels[part]}</legend>
      <div>{MOTE_FACE_PARTS[part].map(value => <button type="button" className={`small-button${(face[part] ?? 'none') === value ? ' small-button--active' : ''}`} key={value}
        aria-label={`${labels[part]} · ${value}`} title={`${labels[part]} · ${value}`} aria-pressed={(face[part] ?? 'none') === value} disabled={disabled}
        data-mote-face-part={part} data-mote-face-value={value} onClick={() => onChange({ ...face, [part]: value })}>
        {part !== 'palette' ? <span className="mote-face-editor__sample" aria-hidden="true"><MoteFacePartGlyph part={part} value={value} /></span> : <span className="mote-face-editor__color" data-palette={value} aria-hidden="true" /> }
        <ThemeStatusSelectedIcon size={12} className="mote-avatar-selection-mark" aria-hidden="true" />
      </button>)}</div>
    </fieldset>)}
  </div>
}
