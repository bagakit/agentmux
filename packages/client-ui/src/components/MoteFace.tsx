import { memo, type ReactNode, type SVGProps } from 'react'
import type { MoteFace as MoteFaceChoice } from '../lib/mote-face.js'

export type MoteExpression = 'identity' | 'sleep' | 'idle' | 'thinking' | 'tool' | 'starting' | 'waiting' | 'error' | 'unknown' | 'stopped'

// [body, rimHighlight, deepShade, eyeInk] — crisp companion palette with visor contrast
const palettes = {
  mint: ['#8fd6b4', '#c9f2df', '#2d5c4e', '#112521'],
  peach: ['#ebb69a', '#fae0d1', '#6e4238', '#241615'],
  lavender: ['#c2b4e6', '#e6dff8', '#4b3f6b', '#1b1729'],
  sky: ['#9fc8e4', '#d8ecf9', '#2e556e', '#12222d'],
  cocoa: ['#b67d58', '#ddb496', '#4a2f22', '#1c1310'],
  sand: ['#e3c888', '#f6e9c6', '#6b532c', '#241c11'],
  rose: ['#e49fb9', '#f7d6e3', '#6b384e', '#26141d'],
  slate: ['#9fb2bf', '#d4dfe6', '#334654', '#131c24']
} as const

const eyebrows = {
  soft: ['M18.5 27.5 Q22.5 25.2 26.5 27.5', 'M37.5 27.5 Q41.5 25.2 45.5 27.5'],
  straight: ['M18.5 27H26.5', 'M37.5 27H45.5'],
  curious: ['M18.5 27.8 Q22.5 24 26.5 26.8', 'M37.5 25.8 Q41.5 22.5 45.5 24.8'],
  bold: ['M17.5 27.8Q22.5 24.6 27.5 27.8', 'M36.5 27.8Q41.5 24.6 46.5 27.8'],
  arched: ['M18.5 27.8Q22.5 21.8 26.5 26.8', 'M37.5 26.8Q41.5 21.8 45.5 27.8'],
  angled: ['M18.5 24.8L26.5 27.8', 'M37.5 27.8L45.5 24.8']
} as const

type Bounds = readonly [left: number, top: number, right: number, bottom: number]
type Origin = readonly [x: number, y: number]

// Neutral geometric bounds of the companion-family head & features in the 64-unit model.
const shapeBounds = {
  round: [8, 8, 56, 56],
  soft: [8, 8, 56, 56],
  square: [9, 9, 55, 56],
  slim: [12, 8, 52, 57],
  diamond: [10, 8, 54, 58]
} satisfies Record<MoteFaceChoice['shape'], Bounds>

const accessoryBounds = {
  none: null,
  tuft: [25, 7, 42, 18],
  antenna: [30, 3, 38, 15],
  swept: [11, 9, 54, 26],
  curls: [10, 7, 54, 24],
  glasses: [10, 29, 54, 42],
  ears: [6, 7, 58, 25],
  horns: [10, 5, 54, 22],
  beard: [16, 45, 48, 59]
} satisfies Record<MoteFaceChoice['accessory'], Bounds | null>

const eyeBounds = {
  round: [18.5, 31, 45.5, 39.5],
  oval: [19.5, 30, 44.5, 40],
  spark: [17, 30, 47, 40.5],
  calm: [18, 34.5, 46, 37],
  lashes: [16, 29, 48, 39.5],
  wink: [18.5, 31, 46, 39.5]
} satisfies Record<MoteFaceChoice['eyes'], Bounds>

const browBounds = {
  soft: [18.5, 25.2, 45.5, 27.5],
  straight: [18.5, 27, 45.5, 27],
  curious: [18.5, 22.5, 45.5, 27.8],
  bold: [17.5, 24.6, 46.5, 27.8],
  arched: [18.5, 21.8, 45.5, 27.8],
  angled: [18.5, 24.8, 45.5, 27.8]
} satisfies Record<MoteFaceChoice['brows'], Bounds>

const mouthBounds = {
  smile: [27.5, 44.5, 36.5, 47.5],
  small: [29.5, 45.5, 34.5, 46.8],
  grin: [26.5, 44, 37.5, 49.5],
  cat: [25.5, 45, 38.5, 48],
  smirk: [27.5, 43.5, 37.5, 47.5],
  tooth: [27.5, 44.5, 36.5, 49]
} satisfies Record<MoteFaceChoice['mouth'], Bounds>

const noseBounds = {
  none: null,
  button: [30.2, 39.8, 33.8, 41.2],
  bridge: [30.2, 35.5, 33.8, 41.2],
  round: [29.5, 38.5, 34.5, 42]
} satisfies Record<NonNullable<MoteFaceChoice['nose']>, Bounds | null>

const markingBounds = {
  none: null,
  freckles: [15.5, 39.5, 48.5, 43],
  blush: [13, 39.5, 51, 44],
  scar: [41, 22, 45, 29]
} satisfies Record<NonNullable<MoteFaceChoice['marking']>, Bounds | null>

const sleepEyeBounds: Bounds = [18, 34.5, 46, 37]
const sleepMouthBounds: Bounds = [29.5, 44, 34.5, 47.5]
const uncertainMouthBounds: Bounds = [28, 46, 36, 46]

function unionBounds(first: Bounds, ...parts: Array<Bounds | null>): Bounds {
  let [left, top, right, bottom] = first
  for (const part of parts) {
    if (part === null) continue
    left = Math.min(left, part[0]); top = Math.min(top, part[1])
    right = Math.max(right, part[2]); bottom = Math.max(bottom, part[3])
  }
  return [left, top, right, bottom]
}
function center([left, top, right, bottom]: Bounds): Origin {
  return [(left + right) / 2, (top + bottom) / 2]
}

function Articulation({ children }: { children: ReactNode }) {
  return <foreignObject className="mote-face__articulation" x="0" y="0" width="64" height="64">
    <div className="mote-face__model">{children}</div>
  </foreignObject>
}
function Bone({ className, origin, children }: { className: string; origin: Origin; children: ReactNode }) {
  return <div className={`mote-face__bone ${className}`} style={{ transformOrigin: `${origin[0]}px ${origin[1]}px` }}>{children}</div>
}
type DrawingProps = Pick<SVGProps<SVGSVGElement>, 'fill' | 'stroke' | 'strokeWidth' | 'strokeLinecap' | 'strokeLinejoin'> & { children: ReactNode }
function Drawing({ children, ...paint }: DrawingProps) {
  return <svg className="mote-face__drawing" viewBox="0 0 64 64" width="64" height="64" style={{ width: 64, height: 64 }} aria-hidden="true" {...paint}>{children}</svg>
}
function StaticArticulation({ children }: { children: ReactNode }) { return <>{children}</> }
function StaticBone({ children }: { className: string; origin: Origin; children: ReactNode }) { return <g>{children}</g> }
function StaticDrawing({ children, ...paint }: DrawingProps) { return <g {...paint}>{children}</g> }

/** Companion-family head silhouettes with the signature lifted left ear tip. */
function CompanionShell({ shape, skin, highlight, shade }: { shape: MoteFaceChoice['shape']; skin: string; highlight: string; shade: string }) {
  if (shape === 'slim') {
    return <>
      <path d="M16.5 8.5C21.5 9.2 25.5 11.8 28.2 14.6C30.5 14 33 13.8 35.5 14C46 14.5 52 23 52 35.5C52 48.5 43.5 57 32 57C20.5 57 12 48.8 12 36.2C12 30.5 13.4 25.5 15.5 21.8L16.5 8.5Z" fill={skin} />
      <path d="M16.5 8.5C21.5 9.2 25.5 11.8 28.2 14.6C35.5 13 43.5 15.5 48.2 22C41 18.2 29.5 18 15.6 22.8L16.5 8.5Z" fill={highlight} opacity=".5" />
      <path d="M14.5 44.5C19.5 51.5 26 53.5 32 53.5C38.5 53.5 45 51 49.5 44C46.5 52.5 40 57 32 57C23.5 57 17 52.5 14.5 44.5Z" fill={shade} opacity=".32" />
    </>
  }
  if (shape === 'diamond') {
    return <>
      <path d="M15 8.5L27.5 14.2L36 13.5L49 20.5L54 34.5L48.5 48.5L32 58L15.5 48.5L10 34.5L14 21.5Z" fill={skin} />
      <path d="M15 8.5L27.5 14.2L36 13.5L49 20.5L35 19.5L14 21.5Z" fill={highlight} opacity=".55" />
      <path d="M10 34.5L15.5 48.5L32 58L48.5 48.5L54 34.5L46.5 45.5L32 53.5L17.5 45.5Z" fill={shade} opacity=".34" />
    </>
  }
  if (shape === 'square') {
    return <>
      <path d="M13 8.5L26.5 14.5H45C50.5 14.5 55 19 55 24.5V45.5C55 51.3 50.3 56 44.5 56H19.5C13.7 56 9 51.3 9 45.5V23.5L12 18.5L13 8.5Z" fill={skin} />
      <path d="M13 8.5L26.5 14.5H45C49.5 14.5 53.2 17.4 54.5 21.5C47.5 18.8 34 18.5 12 20.5L13 8.5Z" fill={highlight} opacity=".5" />
      <path d="M9.8 45.5C12.5 50.8 18 52.5 32 52.5C46 52.5 51.5 50.8 54.2 45.5C53.5 51.5 49.5 56 44.5 56H19.5C14.5 56 10.5 51.5 9.8 45.5Z" fill={shade} opacity=".32" />
    </>
  }
  if (shape === 'round') {
    return <>
      <path d="M14.5 9C20.5 9.8 25.5 12.2 29 15.2C31.2 14.6 33.6 14.3 36.2 14.4C47.8 14.8 56 23.2 56 35.2C56 47.6 46.4 56 32.2 56C18.2 56 8 47.8 8 35.8C8 30.2 9.6 25.4 12.2 21.5L14.5 9Z" fill={skin} />
      <path d="M14.5 9C20.5 9.8 25.5 12.2 29 15.2C38.2 13.4 47.8 16.5 52.8 23.5C44.2 19.2 30.5 18.8 12.2 22.8L14.5 9Z" fill={highlight} opacity=".52" />
      <path d="M11 43.8C16.8 50.8 24.5 52.6 32.2 52.6C40.2 52.6 47.8 50.4 53 43.5C50 51.2 42.2 56 32.2 56C21.8 56 13.8 51.4 11 43.8Z" fill={shade} opacity=".3" />
    </>
  }
  // 'soft' — canonical Mote companion contour
  return <>
    <path d="M13.2 8.2C19.6 8.9 25 11.6 28.6 15C31.5 14 34.7 13.5 38.2 13.6C50.2 14 56 22.6 56 34.6C56 47.6 46.2 56 31.8 56C17.4 56 8 47.8 8 35.6C8 30.1 9.6 25.3 12 21.5L13.2 8.2Z" fill={skin} />
    <path d="M13.2 8.2C19.6 8.9 25 11.6 28.6 15C38.4 12.8 48.2 15.8 53 23.2C44.2 18.8 30.2 18.4 12 22.8L13.2 8.2Z" fill={highlight} opacity=".52" />
    <path d="M10.8 43.6C16.6 50.8 24.2 52.6 31.8 52.6C39.8 52.6 47.6 50.4 53.2 43.4C50.2 51.2 42.2 56 31.8 56C21.2 56 13.4 51.4 10.8 43.6Z" fill={shade} opacity=".3" />
  </>
}

/** Companion-family articulated Mote avatar; state never mutates the saved choice. */
export const MoteFace = memo(function MoteFace({ face, expression = 'identity', rendering = 'articulated' }: {
  face: MoteFaceChoice; expression?: MoteExpression | undefined; rendering?: 'articulated' | 'static' | undefined
}) {
  const Model = rendering === 'static' ? StaticArticulation : Articulation,
    Part = rendering === 'static' ? StaticBone : Bone,
    Paint = rendering === 'static' ? StaticDrawing : Drawing
  const [skin, highlight, shade, ink] = palettes[face.palette]
  const sleepy = expression === 'sleep', uncertain = expression === 'unknown' || expression === 'error'
  const eyes = sleepy ? sleepEyeBounds : eyeBounds[face.eyes]
  const mouth = sleepy ? sleepMouthBounds : uncertain ? uncertainMouthBounds : mouthBounds[face.mouth]
  const headOrigin = center(unionBounds(shapeBounds[face.shape],
    accessoryBounds[face.accessory], eyes, browBounds[face.brows], mouth,
    noseBounds[face.nose ?? 'none'], markingBounds[face.marking ?? 'none']))
  const browOrigin = center(browBounds[face.brows]), eyeOrigin = center(eyes)
  const gazeOrigin = center(eyeBounds[face.eyes]), mouthOrigin = center(mouth)

  return <svg xmlns={rendering === 'static' ? 'http://www.w3.org/2000/svg' : undefined} width={rendering === 'static' ? 64 : undefined} height={rendering === 'static' ? 64 : undefined}
    className="mote-face" viewBox="0 0 64 64" aria-hidden="true" data-mote-face-shape={face.shape} data-mote-face-palette={face.palette}
    data-mote-face-eyes={face.eyes} data-mote-face-brows={face.brows} data-mote-face-mouth={face.mouth} data-mote-face-accessory={face.accessory}
    data-mote-face-nose={face.nose} data-mote-face-marking={face.marking}>
    <circle cx="32" cy="32" r="30.5" fill={shade} opacity=".22" />
    <Model><Part className="mote-face__neck" origin={[32, 52]}><Part className="mote-face__gesture-head" origin={headOrigin}><Part className="mote-face__head" origin={headOrigin}>
      <Paint>
        {face.accessory === 'antenna' ? <g stroke={ink} strokeWidth="2.2" strokeLinecap="round"><path d="M34 15V6.5" /><circle cx="34" cy="5.5" r="3.2" fill={highlight} stroke={shade} strokeWidth="1.5" /></g> : null}
        {face.accessory === 'ears' ? <path d="M40 16L53 7.5Q59 12 50 24" fill={skin} stroke={shade} strokeWidth="1.8" strokeLinejoin="round" /> : null}
        {face.accessory === 'horns' ? <path d="M22 14Q17 6 24 5Q25 11 29 14M40 14.5Q46 6 52 7Q49 14 45 18" fill={shade} /> : null}
        <CompanionShell shape={face.shape} skin={skin} highlight={highlight} shade={shade} />
        {/* Soft visor pocket tying 2D face into the Mote companion family */}
        <rect x="13.5" y="28.5" width="37" height="13.5" rx="6.75" fill={shade} opacity=".18" />
        {face.accessory === 'tuft' ? <path d="M27 15.5Q29 7.5 37.5 8.5Q33.5 13 40.5 14.5Q36.5 18.5 27 15.5Z" fill={shade} /> : null}
        {face.accessory === 'swept' ? <path d="M12 22.5Q22 10.5 41 12.5Q50 14 53.5 23.5Q41 18.5 28 20.5Q19 22 12 22.5Z" fill={shade} opacity=".85" /> : null}
        {face.accessory === 'curls' ? <g fill={shade}><circle cx="24" cy="14.5" r="5" /><circle cx="33" cy="12.5" r="6" /><circle cx="42.5" cy="15" r="5.2" /><circle cx="49" cy="20" r="4.2" /></g> : null}
      </Paint>
      <Part className="mote-face__brow-follow" origin={browOrigin}><Part className="mote-face__gesture-brows" origin={browOrigin}><Part className="mote-face__brows" origin={browOrigin}>
        <Paint fill="none" stroke={ink} strokeWidth={face.brows === 'bold' ? 3.4 : 2.1} strokeLinecap="round">
          <path d={eyebrows[face.brows][0]} /><path d={eyebrows[face.brows][1]} />
        </Paint>
      </Part></Part></Part>
      <Part className="mote-face__gesture-eyes" origin={eyeOrigin}><Part className="mote-face__eyes" origin={eyeOrigin}>
        {sleepy ? <Paint fill="none" stroke={ink} strokeWidth="2.4" strokeLinecap="round"><g className="mote-face__sleep-eyes"><path d="M18.5 35Q22.5 38.2 26.5 35M37.5 34.6Q41.5 37.8 45.5 34.6" /></g></Paint> : null}
        <Part className="mote-face__awake-eyes" origin={gazeOrigin}><Part className="mote-face__gaze-follow" origin={gazeOrigin}><Part className="mote-face__gesture-gaze" origin={gazeOrigin}><Part className="mote-face__gaze" origin={gazeOrigin}>
          <Paint fill={ink}>
            {face.eyes === 'spark' ? <><path d="M22.5 29.8L24.3 33.8L27.5 35L24.3 36.6L22.5 40.5L20.7 36.6L17.5 35L20.7 33.8Z" /><path d="M41.5 29.4L43.3 33.4L46.5 34.6L43.3 36.2L41.5 40.1L39.7 36.2L36.5 34.6L39.7 33.4Z" /></> :
              face.eyes === 'calm' ? <path d="M18.5 35.2Q22.5 38 26.5 35.2M37.5 34.8Q41.5 37.6 45.5 34.8" fill="none" stroke={ink} strokeWidth="2.5" strokeLinecap="round" /> :
              <><ellipse cx="22.5" cy="35.2" rx={face.eyes === 'oval' ? 2.8 : 3.6} ry={face.eyes === 'oval' ? 4.8 : 4.1} />
                {face.eyes === 'wink' ? <path d="M37.5 35.6Q41.5 31.8 45.5 35.6" fill="none" stroke={ink} strokeWidth="2.6" strokeLinecap="round" /> : <ellipse cx="41.5" cy="34.6" rx={face.eyes === 'oval' ? 2.9 : 3.8} ry={face.eyes === 'oval' ? 5.0 : 4.3} />}
                {face.eyes === 'lashes' ? <path d="M18.2 32.8L16.2 30.8M21.2 31.5L20.2 29M38.8 31.2L37.8 28.8M44.8 32.4L47.2 30.5" fill="none" stroke={ink} strokeWidth="1.9" strokeLinecap="round" /> : null}</>}
            {face.eyes !== 'calm' ? <><circle cx="23.6" cy="33.8" r="1.05" fill="#fff" />{face.eyes !== 'wink' ? <circle cx="42.7" cy="33.2" r="1.1" fill="#fff" /> : null}</> : null}
          </Paint>
        </Part></Part></Part></Part>
      </Part></Part>
      <Paint>
        {face.accessory === 'glasses' ? <g fill="none" stroke={ink} strokeWidth="1.9"><rect x="14.5" y="29.5" width="15.5" height="11.5" rx="4.5" /><rect x="34" y="29" width="15.5" height="11.5" rx="4.5" /><path d="M30 34.2Q32 32.5 34 34.2M10.5 33.5H14.5M49.5 33H53.5" /></g> : null}
        {face.nose && face.nose !== 'none' ? <g className="mote-face__nose" fill="none" stroke={ink} strokeWidth="1.7" strokeLinecap="round" opacity=".68">
          {face.nose === 'button' ? <path d="M30.2 40Q32 41.8 33.8 40" /> : face.nose === 'bridge' ? <path d="M32 35.5L30.2 41H33.8" /> : <ellipse cx="32" cy="40.2" rx="2.6" ry="1.8" fill={shade} stroke="none" />}
        </g> : null}
      </Paint>
      <Part className="mote-face__mouth-follow" origin={mouthOrigin}><Part className="mote-face__gesture-mouth" origin={mouthOrigin}><Part className="mote-face__mouth" origin={mouthOrigin}>
        <Paint fill="none" stroke={ink} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
          {sleepy ? <ellipse cx="32" cy="45.8" rx="2.2" ry="1.8" /> : uncertain ? <path d="M28.2 46H35.8" /> : face.mouth === 'small' ? <path d="M29.5 45.5Q32 47.4 34.5 45.5" /> : face.mouth === 'grin' ? <path d="M26.5 44.2H37.5Q36.5 49.5 32 49.5Q27.5 49.5 26.5 44.2Z" fill="#fff" /> :
            face.mouth === 'cat' ? <path d="M25.8 45.2Q28.8 49.2 32 45.2Q35.2 49.2 38.2 45.2" /> : face.mouth === 'smirk' ? <path d="M27.5 46.8Q33 48.5 37.2 43.5" /> : face.mouth === 'tooth' ? <><path d="M27.5 44.5Q32 48.8 36.5 44.5" /><path d="M30.2 46.2V48.8H33.8V46.2" fill="#fff" strokeWidth="1.1" /></> : <path d="M27.5 44.5Q32 48.8 36.5 44.5" />}
        </Paint>
      </Part></Part></Part>
      <Paint>
        {face.accessory === 'beard' ? <path d="M16 45.5Q22.5 50.5 28 49.5L32 52.8L36 49.5Q41.5 50.5 48 45.5L44.5 54.5Q32 61 19.5 54.5Z" fill={shade} opacity=".85" /> : null}
        {face.marking && face.marking !== 'none' ? <g className="mote-face__marking">
          {face.marking === 'freckles' ? <g fill={ink} opacity=".42"><circle cx="16.5" cy="40.5" r=".9" /><circle cx="20" cy="42.2" r=".9" /><circle cx="23.5" cy="40.5" r=".9" /><circle cx="40.5" cy="40.2" r=".9" /><circle cx="44" cy="41.9" r=".9" /><circle cx="47.5" cy="40.2" r=".9" /></g> :
            face.marking === 'blush' ? <g fill="#e07b91" opacity=".48"><ellipse cx="17.5" cy="41.5" rx="4.5" ry="2.2" /><ellipse cx="46.5" cy="41.2" rx="4.5" ry="2.2" /></g> : <path d="M44.2 22.5L41.2 29M41 24.5L44.5 26.5" fill="none" stroke={shade} strokeWidth="1.9" strokeLinecap="round" />}
        </g> : null}
      </Paint>
    </Part></Part></Part></Model>
  </svg>
})
