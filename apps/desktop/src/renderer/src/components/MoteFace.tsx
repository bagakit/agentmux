import { memo } from 'react'
import type { MoteFace as MoteFaceChoice } from '../../../shared/mote-avatars'

export type MoteExpression = 'identity' | 'sleep' | 'idle' | 'thinking' | 'tool' | 'starting' | 'waiting' | 'error' | 'unknown' | 'stopped'
const palettes = {
  mint: ['#b9e3cb', '#79b59a', '#193e38'], peach: ['#f1cbb5', '#cc987f', '#533a38'],
  lavender: ['#d6ccec', '#a69bc8', '#3f3855'], sky: ['#c0d9ea', '#89b4ce', '#254654']
} as const

/** Product illustration made from fixed parts; state never edits the saved choice. */
export const MoteFace = memo(function MoteFace({ face, expression = 'identity' }: { face: MoteFaceChoice; expression?: MoteExpression | undefined }) {
  const [skin, shade, ink] = palettes[face.palette]
  const sleepy = expression === 'sleep', uncertain = expression === 'unknown' || expression === 'error'
  return <svg className="mote-face" viewBox="0 0 64 64" aria-hidden="true" data-mote-face-shape={face.shape} data-mote-face-palette={face.palette}
    data-mote-face-eyes={face.eyes} data-mote-face-brows={face.brows} data-mote-face-mouth={face.mouth} data-mote-face-accessory={face.accessory}>
    <circle cx="32" cy="32" r="31" fill={shade} opacity=".2" />
    <g className="mote-face__neck"><g className="mote-face__head">
      {face.accessory === 'antenna' ? <g stroke={ink} strokeWidth="2" strokeLinecap="round"><path d="M32 17V8" /><circle cx="32" cy="6" r="3" fill={shade} /></g> : null}
      <rect x="9" y="17" width="46" height="41" rx={face.shape === 'round' ? 23 : face.shape === 'soft' ? 17 : 11} fill={skin} />
      <path d="M14 45 Q20 55 32 55 Q45 55 51 45 Q48 59 32 59 Q17 59 14 45" fill={shade} opacity=".28" />
      {face.accessory === 'tuft' ? <path d="M24 19 Q24 9 34 9 Q29 15 37 17 Q40 14 41 12 Q44 22 32 23" fill={shade} /> : null}
      <g className="mote-face__brow-follow"><g className="mote-face__brows" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round">
        <path d={face.brows === 'curious' ? 'M18 28 Q22 24 26 27' : face.brows === 'straight' ? 'M18 27H26' : 'M18 28 Q22 26 26 28'} />
        <path d={face.brows === 'curious' ? 'M38 26 Q42 23 46 25' : face.brows === 'straight' ? 'M38 27H46' : 'M38 28 Q42 26 46 28'} />
      </g>
      </g><g className="mote-face__eyes" fill={ink}>
        {sleepy ? <g className="mote-face__sleep-eyes" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round"><path d="M18 35Q22 38 26 35M38 35Q42 38 46 35" /></g> : null}
          <g className="mote-face__awake-eyes"><g className="mote-face__gaze-follow"><g className="mote-face__gaze">
            {face.eyes === 'spark' ? <><path d="M22 30L24 34L27 35L24 37L22 41L20 37L17 35L20 34Z" /><path d="M42 30L44 34L47 35L44 37L42 41L40 37L37 35L40 34Z" /></> : <><ellipse cx="22" cy="35" rx={face.eyes === 'oval' ? 2.5 : 3.2} ry={face.eyes === 'oval' ? 4.5 : 3.5} /><ellipse cx="42" cy="35" rx={face.eyes === 'oval' ? 2.5 : 3.2} ry={face.eyes === 'oval' ? 4.5 : 3.5} /></>}
            <circle cx="23" cy="34" r=".8" fill="#fff" /><circle cx="43" cy="34" r=".8" fill="#fff" />
          </g></g></g>
      </g>
      <g className="mote-face__mouth-follow"><g className="mote-face__mouth" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round">
        {sleepy ? <ellipse cx="32" cy="45" rx="2.5" ry="2" /> : uncertain ? <path d="M28 46H36" /> : face.mouth === 'small' ? <path d="M29 45Q32 47 35 45" /> : face.mouth === 'grin' ? <path d="M26 44H38Q37 50 32 50Q27 50 26 44Z" fill="#fff" /> : <path d="M27 44Q32 49 37 44" />}
      </g>
      </g><circle cx="16" cy="42" r="3" fill={shade} opacity=".35" /><circle cx="48" cy="42" r="3" fill={shade} opacity=".35" />
    </g></g>
  </svg>
})
