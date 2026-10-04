import { memo } from 'react'
import type { MoteFace as MoteFaceChoice } from '../lib/mote-face.js'

export type MoteExpression = 'identity' | 'sleep' | 'idle' | 'thinking' | 'tool' | 'starting' | 'waiting' | 'error' | 'unknown' | 'stopped'
const palettes = {
  mint: ['#b9e3cb', '#79b59a', '#193e38'], peach: ['#f1cbb5', '#cc987f', '#533a38'],
  lavender: ['#d6ccec', '#a69bc8', '#3f3855'], sky: ['#c0d9ea', '#89b4ce', '#254654'],
  cocoa: ['#b77f5a', '#754936', '#2f2527'], sand: ['#ead6a3', '#ba9157', '#4a3c2a'],
  rose: ['#edb5ca', '#b77b9b', '#533545'], slate: ['#bcc9d1', '#7e929e', '#283e4b']
} as const
const eyebrows = {
  soft: ['M18 28 Q22 26 26 28', 'M38 28 Q42 26 46 28'],
  straight: ['M18 27H26', 'M38 27H46'], curious: ['M18 28 Q22 24 26 27', 'M38 26 Q42 23 46 25'],
  bold: ['M17 28Q22 25 27 28', 'M37 28Q42 25 47 28'],
  arched: ['M18 28Q22 22 26 27', 'M38 27Q42 22 46 28'],
  angled: ['M18 25L26 28', 'M38 28L46 25']
} as const

/** Product illustration made from fixed parts; state never edits the saved choice. */
export const MoteFace = memo(function MoteFace({ face, expression = 'identity' }: { face: MoteFaceChoice; expression?: MoteExpression | undefined }) {
  const [skin, shade, ink] = palettes[face.palette]
  const sleepy = expression === 'sleep', uncertain = expression === 'unknown' || expression === 'error'
  return <svg className="mote-face" viewBox="0 0 64 64" aria-hidden="true" data-mote-face-shape={face.shape} data-mote-face-palette={face.palette}
    data-mote-face-eyes={face.eyes} data-mote-face-brows={face.brows} data-mote-face-mouth={face.mouth} data-mote-face-accessory={face.accessory}
    data-mote-face-nose={face.nose} data-mote-face-marking={face.marking}>
    <circle cx="32" cy="32" r="31" fill={shade} opacity=".2" />
    <g className="mote-face__neck"><g className="mote-face__head">
      {face.accessory === 'antenna' ? <g stroke={ink} strokeWidth="2" strokeLinecap="round"><path d="M32 17V8" /><circle cx="32" cy="6" r="3" fill={shade} /></g> : null}
      {face.accessory === 'ears' ? <path d="M12 25Q2 14 9 10L23 22M41 22L55 10Q62 14 52 25" fill={skin} stroke={shade} strokeWidth="2" /> : null}
      {face.accessory === 'horns' ? <path d="M14 23Q6 17 11 6Q14 17 24 18M40 18Q50 17 53 6Q58 17 50 23" fill={shade} /> : null}
      {face.shape === 'slim' ? <ellipse cx="32" cy="37" rx="19" ry="23" fill={skin} /> : face.shape === 'diamond' ?
        <path d="M32 14Q47 14 53 29L50 45Q42 57 32 61Q22 57 14 45L11 29Q17 14 32 14" fill={skin} /> :
        <rect x="9" y="17" width="46" height="41" rx={face.shape === 'round' ? 23 : face.shape === 'soft' ? 17 : 11} fill={skin} />}
      <path d="M14 45 Q20 55 32 55 Q45 55 51 45 Q48 59 32 59 Q17 59 14 45" fill={shade} opacity=".28" />
      {face.accessory === 'tuft' ? <path d="M24 19 Q24 9 34 9 Q29 15 37 17 Q40 14 41 12 Q44 22 32 23" fill={shade} /> : null}
      {face.accessory === 'swept' ? <path d="M10 30Q6 11 29 10Q47 7 54 24Q41 19 38 17Q28 32 10 30" fill={shade} /> : null}
      {face.accessory === 'curls' ? <g fill={shade}><circle cx="14" cy="22" r="7" /><circle cx="21" cy="16" r="7" /><circle cx="32" cy="14" r="8" /><circle cx="43" cy="16" r="7" /><circle cx="50" cy="22" r="7" /></g> : null}
      <g className="mote-face__brow-follow"><g className="mote-face__brows" fill="none" stroke={ink} strokeWidth={face.brows === 'bold' ? 3.5 : 2} strokeLinecap="round">
        <path d={eyebrows[face.brows][0]} /><path d={eyebrows[face.brows][1]} />
      </g>
      </g><g className="mote-face__eyes" fill={ink}>
        {sleepy ? <g className="mote-face__sleep-eyes" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round"><path d="M18 35Q22 38 26 35M38 35Q42 38 46 35" /></g> : null}
          <g className="mote-face__awake-eyes"><g className="mote-face__gaze-follow"><g className="mote-face__gaze">
            {face.eyes === 'spark' ? <><path d="M22 30L24 34L27 35L24 37L22 41L20 37L17 35L20 34Z" /><path d="M42 30L44 34L47 35L44 37L42 41L40 37L37 35L40 34Z" /></> :
              face.eyes === 'calm' ? <path d="M18 35Q22 38 26 35M38 35Q42 38 46 35" fill="none" stroke={ink} strokeWidth="2.5" strokeLinecap="round" /> :
              <><ellipse cx="22" cy="35" rx={face.eyes === 'oval' ? 2.5 : 3.2} ry={face.eyes === 'oval' ? 4.5 : 3.5} />
                {face.eyes === 'wink' ? <path d="M38 36Q42 32 46 36" fill="none" stroke={ink} strokeWidth="2.5" strokeLinecap="round" /> : <ellipse cx="42" cy="35" rx={face.eyes === 'oval' ? 2.5 : 3.2} ry={face.eyes === 'oval' ? 4.5 : 3.5} />}
                {face.eyes === 'lashes' ? <path d="M18 33L16 31M21 32L20 29M39 32L38 29M45 33L48 31" fill="none" stroke={ink} strokeWidth="1.8" strokeLinecap="round" /> : null}</>}
            {face.eyes !== 'calm' ? <><circle cx="23" cy="34" r=".8" fill="#fff" />{face.eyes !== 'wink' ? <circle cx="43" cy="34" r=".8" fill="#fff" /> : null}</> : null}
          </g></g></g>
      </g>
      {face.accessory === 'glasses' ? <g fill="none" stroke={ink} strokeWidth="1.8"><rect x="14" y="30" width="15" height="12" rx="4" /><rect x="35" y="30" width="15" height="12" rx="4" /><path d="M29 34Q32 32 35 34M10 33H14M50 33H54" /></g> : null}
      {face.nose && face.nose !== 'none' ? <g className="mote-face__nose" fill="none" stroke={ink} strokeWidth="1.6" strokeLinecap="round" opacity=".6">
        {face.nose === 'button' ? <path d="M30 40Q32 42 34 40" /> : face.nose === 'bridge' ? <path d="M32 35L30 41H34" /> : <ellipse cx="32" cy="40" rx="2.8" ry="2" fill={shade} stroke="none" />}
      </g> : null}
      <g className="mote-face__mouth-follow"><g className="mote-face__mouth" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round">
        {sleepy ? <ellipse cx="32" cy="45" rx="2.5" ry="2" /> : uncertain ? <path d="M28 46H36" /> : face.mouth === 'small' ? <path d="M29 45Q32 47 35 45" /> : face.mouth === 'grin' ? <path d="M26 44H38Q37 50 32 50Q27 50 26 44Z" fill="#fff" /> :
          face.mouth === 'cat' ? <path d="M25 45Q28 50 32 45Q36 50 39 45" /> : face.mouth === 'smirk' ? <path d="M27 47Q33 49 38 43" /> : face.mouth === 'tooth' ? <><path d="M27 44Q32 49 37 44" /><path d="M30 46V49H34V46" fill="#fff" strokeWidth="1" /></> : <path d="M27 44Q32 49 37 44" />}
      </g>
      </g><circle cx="16" cy="42" r="3" fill={shade} opacity=".35" /><circle cx="48" cy="42" r="3" fill={shade} opacity=".35" />
      {face.accessory === 'beard' ? <path d="M14 44Q21 50 27 49L32 53L37 49Q43 50 50 44L46 55Q32 66 18 55Z" fill={shade} /> : null}
      {face.marking && face.marking !== 'none' ? <g className="mote-face__marking">
        {face.marking === 'freckles' ? <g fill={ink} opacity=".4"><circle cx="16" cy="40" r=".8" /><circle cx="20" cy="42" r=".8" /><circle cx="24" cy="40" r=".8" /><circle cx="40" cy="40" r=".8" /><circle cx="44" cy="42" r=".8" /><circle cx="48" cy="40" r=".8" /></g> :
          face.marking === 'blush' ? <g fill="#da7887" opacity=".5"><ellipse cx="17" cy="42" rx="5" ry="2.5" /><ellipse cx="47" cy="42" rx="5" ry="2.5" /></g> : <path d="M44 23L41 30M41 25L44 27" fill="none" stroke={shade} strokeWidth="1.8" strokeLinecap="round" />}
      </g> : null}
    </g></g>
  </svg>
})
