import { useId } from 'react'
import type { MoteAvatarSeriesLocator, MoteAvatarSeriesParameters } from '@agentmux/core/mote-avatar-series'
import type { MoteExpression } from './MoteFace'

export const MOTE_SILHOUETTE_TITLES = {
  'retro-future': 'Retro future',
  'low-poly': 'Low poly',
  'dada': 'Dada',
  'polka-dot': 'Polka dot',
  'ukiyo-e': 'Ukiyo-e',
  'cyberpunk': 'Cyberpunk',
  'flat': 'Flat',
  'neo-classical': 'Neoclassical',
  'vaporwave': 'Vaporwave',
  'klei': 'Klei',
  'ink': 'Ink',
  'fallout-four': 'Fallout 4'
} as const

export type MoteSilhouetteId = keyof typeof MOTE_SILHOUETTE_TITLES

export function isBuiltinMoteSilhouetteLocator(source: Pick<MoteAvatarSeriesLocator, 'origin' | 'seriesId' | 'entryId'> | null | undefined): source is MoteAvatarSeriesLocator & { entryId: MoteSilhouetteId } {
  return Boolean(source && source.origin === 'builtin' && source.seriesId === 'mote-silhouettes' && Object.hasOwn(MOTE_SILHOUETTE_TITLES, source.entryId))
}

const COMPANION_BODY = 'M4.7 2.8C7.1 3.05 9.1 4.05 10.45 5.3C11.55 4.95 12.75 4.75 14.05 4.8C18.65 4.95 21.2 8.25 21.2 12.7C21.2 17.65 17.5 21 11.95 21C6.45 21 2.8 17.8 2.8 13.15C2.8 11.05 3.4 9.25 4.3 7.8L4.7 2.8Z'
const EYE_L = 'M8.45 10.45C7.65 10.45 7.05 11.2 7.05 12.2C7.05 13.2 7.65 13.95 8.45 13.95C9.25 13.95 9.85 13.2 9.85 12.2C9.85 11.2 9.25 10.45 8.45 10.45Z'
const EYE_R = 'M15.55 9.9C14.65 9.9 14 10.75 14 11.85C14 12.95 14.65 13.8 15.55 13.8C16.45 13.8 17.1 12.95 17.1 11.85C17.1 10.75 16.45 9.9 15.55 9.9Z'

const sleepStrokes: Record<string, string> = {
  'retro-future': '#7ff0c3',
  'cyberpunk': '#53f6ec',
  'dada': '#f5e9d0',
  'flat': '#223138',
  'fallout-four': '#e8cf82'
}

/** Shared articulated silhouette used in both Change Avatar and live Mote surfaces. */
export function MoteSilhouetteArt({ id, expression = 'identity', parameters, interactive = true }: {
  id: string; expression?: MoteExpression | undefined;
  parameters?: Extract<MoteAvatarSeriesParameters, { kind: 'image' }> | undefined;
  interactive?: boolean | undefined
}) {
  const uid = useId().replace(/:/g, '')
  const sleepy = expression === 'sleep'
  const sleepInk = sleepStrokes[id] ?? '#172422'
  const zoom = parameters ? parameters.zoom : 1
  const tx = parameters && zoom > 1 ? parameters.offsetX * (zoom - 1) * 14 : 0
  const ty = parameters && zoom > 1 ? parameters.offsetY * (zoom - 1) * 14 : 0
  const hasCrop = zoom !== 1 || tx !== 0 || ty !== 0
  const cropTransform = hasCrop ? `translate(${(12 + tx).toFixed(2)} ${(12 + ty).toFixed(2)}) scale(${zoom.toFixed(3)}) translate(-12 -12)` : undefined

  const renderEyes = (children: React.ReactNode) => sleepy ? (
    <g className="mote-silhouette__sleep-eyes" fill="none" stroke={sleepInk} strokeWidth="1.35" strokeLinecap="round">
      <path d="M7.1 12.1Q8.5 13.5 9.9 12.1M14.1 11.7Q15.6 13.1 17.1 11.7" />
    </g>
  ) : (
    <g className="mote-silhouette__gaze">
      <g className="mote-silhouette__gesture-gaze">
        <g className="mote-silhouette__eyes">
          <g className="mote-silhouette__gesture-eyes">{children}</g>
        </g>
      </g>
    </g>
  )

  const body = id === 'retro-future' ? <>
    <defs>
      <linearGradient id={`rf-${uid}`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#e8dfc4" /><stop offset="0.45" stopColor="#8fb3a5" /><stop offset="1" stopColor="#2e4f49" />
      </linearGradient>
    </defs>
    <path d={COMPANION_BODY} fill={`url(#rf-${uid})`} />
    <path d="M4.7 2.8C7.1 3.05 9.1 4.05 10.45 5.3C13.5 4.4 17.8 5.2 20.1 8.4C16.2 7.2 10.6 7.5 4.2 10.2L4.7 2.8Z" fill="#f3ebd3" opacity=".65" />
    <path d="M4.2 15.8C8.2 18.8 15.6 18.8 19.8 15.5C18.2 19.1 15.2 21 11.95 21C7.6 21 4.3 18.9 3.2 15.8Z" fill="#c76744" opacity=".85" />
    <rect x="5.8" y="9.2" width="12.6" height="5.2" rx="2.6" fill="#162624" stroke="#d8efe6" strokeWidth=".6" />
    {renderEyes(<g fill="#7ff0c3"><circle cx="8.7" cy="11.8" r="1.25" /><circle cx="15.3" cy="11.5" r="1.35" /></g>)}
  </> : id === 'low-poly' ? <>
    <polygon points="4.7,2.8 10.5,5.2 4.1,8.5" fill="#d9e5dc" />
    <polygon points="10.5,5.2 16.8,4.9 12.2,10.2 4.1,8.5" fill="#9fc2b2" />
    <polygon points="16.8,4.9 21.1,9.8 18.2,14.5 12.2,10.2" fill="#6b9486" />
    <polygon points="4.1,8.5 12.2,10.2 7.2,16.5 2.8,13.2" fill="#82a898" />
    <polygon points="12.2,10.2 18.2,14.5 15.8,20.2 7.2,16.5" fill="#53796d" />
    <polygon points="18.2,14.5 21.2,12.8 19.2,18.4 15.8,20.2" fill="#3a5950" />
    <polygon points="2.8,13.2 7.2,16.5 15.8,20.2 11.8,21 5.6,19.4" fill="#416157" />
    {renderEyes(<g fill="#16221f"><polygon points="7.3,10.8 9.7,10.6 9.9,13.4 7.1,13.2" /><polygon points="14.2,10.2 16.9,10.1 17.1,13.1 14.1,12.9" /></g>)}
  </> : id === 'dada' ? <>
    <defs><clipPath id={`dada-${uid}`}><path d={COMPANION_BODY} /></clipPath></defs>
    <g clipPath={`url(#dada-${uid})`}>
      <rect x="0" y="0" width="12" height="24" fill="#d15b42" />
      <rect x="12" y="0" width="12" height="24" fill="#28353b" />
      <polygon points="2,4 16,2 10,22 2,18" fill="#e6cfa3" opacity=".9" />
      <circle cx="16.5" cy="16.5" r="5.5" fill="#b84a36" />
    </g>
    {renderEyes(<><circle cx="8.5" cy="12" r="2.1" fill="#1a1d20" /><circle cx="8.5" cy="12" r=".8" fill="#f5e9d0" /><rect x="13.8" y="9.8" width="3.6" height="3.6" rx=".6" fill="#f5e9d0" /><circle cx="15.6" cy="11.6" r="1.1" fill="#1a1d20" /></>)}
  </> : id === 'polka-dot' ? <>
    <defs><clipPath id={`polka-${uid}`}><path d={COMPANION_BODY} /></clipPath></defs>
    <g clipPath={`url(#polka-${uid})`}>
      <rect width="24" height="24" fill="#e5be62" />
      <circle cx="5" cy="6" r="2.2" fill="#233836" />
      <circle cx="18" cy="7" r="3" fill="#3a665c" />
      <circle cx="6" cy="18" r="3.4" fill="#2d4c46" />
      <circle cx="18.5" cy="17.5" r="4.2" fill="#1d3330" />
      <circle cx="12" cy="19.5" r="2" fill="#b85b3f" />
    </g>
    {renderEyes(<g fill="#172422"><circle cx="8.5" cy="12" r="1.75" /><circle cx="15.5" cy="11.6" r="1.95" /><circle cx="9" cy="11.4" r=".55" fill="#fff" /><circle cx="16" cy="11" r=".6" fill="#fff" /></g>)}
  </> : id === 'ukiyo-e' ? <>
    <defs><clipPath id={`ukiyo-${uid}`}><path d={COMPANION_BODY} /></clipPath></defs>
    <g clipPath={`url(#ukiyo-${uid})`}>
      <rect width="24" height="24" fill="#e9dec3" />
      <circle cx="16.5" cy="8" r="4" fill="#c75643" />
      <path d="M1 14.5Q6 11.5 11 14.5T22 13.5V22H1Z" fill="#264b68" />
      <path d="M2 17.5Q7.5 14.5 13 17.5T23 16.5V22H2Z" fill="#183247" />
      <path d="M2 14.5Q6 12 10.5 14.5" fill="none" stroke="#f3ebd8" strokeWidth="1.1" strokeLinecap="round" />
    </g>
    {renderEyes(<g fill="#142330"><path d={EYE_L} /><path d={EYE_R} /></g>)}
  </> : id === 'cyberpunk' ? <>
    <path d={COMPANION_BODY} fill="#1b2234" stroke="#48d8d0" strokeWidth=".9" />
    <path d="M4.7 2.8L10.4 5.3L6.2 10.2L3.8 8.2Z" fill="#e04f8b" />
    <path d="M4.5 15.5H19.5" stroke="#e04f8b" strokeWidth=".9" strokeDasharray="3 1.5" />
    {renderEyes(<><path d={EYE_L} fill="#53f6ec" /><path d={EYE_R} fill="#ff5d9e" /></>)}
  </> : id === 'flat' ? <>
    <defs><clipPath id={`flat-${uid}`}><path d={COMPANION_BODY} /></clipPath></defs>
    <g clipPath={`url(#flat-${uid})`}>
      <rect x="0" y="0" width="12" height="24" fill="#c65b46" />
      <rect x="12" y="0" width="12" height="24" fill="#e0b96c" />
      <path d="M12 4.8V21" stroke="#223138" strokeWidth=".8" opacity=".25" />
    </g>
    {renderEyes(<><path d={EYE_L} fill={sleepy ? '#223138' : '#f6ebd6'} /><path d={EYE_R} fill="#223138" /></>)}
  </> : id === 'neo-classical' ? <>
    <defs>
      <radialGradient id={`neo-${uid}`} cx="38%" cy="32%" r="68%">
        <stop offset="0" stopColor="#eef2ec" /><stop offset="0.55" stopColor="#8fa69b" /><stop offset="1" stopColor="#3c5149" />
      </radialGradient>
    </defs>
    <path d={COMPANION_BODY} fill={`url(#neo-${uid})`} />
    <path d="M5.8 16.5C8.5 19.2 15.5 19.2 18.2 16.5" fill="none" stroke="#dce5df" strokeWidth=".85" opacity=".65" strokeLinecap="round" />
    {renderEyes(<g fill="#23322c"><path d={EYE_L} /><path d={EYE_R} /></g>)}
  </> : id === 'vaporwave' ? <>
    <defs>
      <linearGradient id={`vw-${uid}`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#df6ec7" /><stop offset="0.52" stopColor="#8f6fe8" /><stop offset="1" stopColor="#48c9d9" />
      </linearGradient>
    </defs>
    <path d={COMPANION_BODY} fill={`url(#vw-${uid})`} />
    <path d="M3.5 15.5H20.5M4.5 17.8H19.5" stroke="#18152c" strokeWidth=".8" opacity=".45" />
    {renderEyes(<g fill="#18152c"><path d={EYE_L} /><path d={EYE_R} /></g>)}
  </> : id === 'klei' ? <>
    <path d={COMPANION_BODY} fill="#cfc7aa" stroke="#232925" strokeWidth="1.4" strokeLinejoin="round" />
    <path d="M5.2 4.2L8.8 6.2M4.5 16.2L7.2 18.5M17.5 17.8L19.5 15.2" stroke="#535c4c" strokeWidth=".9" strokeLinecap="round" />
    {renderEyes(<><ellipse cx="8.5" cy="12.1" rx="1.6" ry="2.1" fill="#232925" /><ellipse cx="15.5" cy="11.7" rx="1.7" ry="2.2" fill="#232925" /><circle cx="8.2" cy="11.5" r=".55" fill="#e9e2c8" /><circle cx="15.2" cy="11.1" r=".55" fill="#e9e2c8" /></>)}
  </> : id === 'ink' ? <>
    <defs>
      <radialGradient id={`ink-${uid}`} cx="35%" cy="30%" r="70%">
        <stop offset="0" stopColor="#d8dfd9" /><stop offset="0.6" stopColor="#697d75" /><stop offset="1" stopColor="#23302c" />
      </radialGradient>
    </defs>
    <path d={COMPANION_BODY} fill={`url(#ink-${uid})`} />
    <path d="M5 4C7.5 4.5 9.2 5.4 10.4 6.2C14.8 5 19.6 7.8 20.2 12.8" fill="none" stroke="#151d1a" strokeWidth="1.35" strokeLinecap="round" />
    <circle cx="17.8" cy="16.8" r="1.1" fill="#b5493a" opacity=".85" />
    {renderEyes(<g fill="#121917"><path d={EYE_L} /><path d={EYE_R} /></g>)}
  </> : <>
    <path d={COMPANION_BODY} fill="#486b85" stroke="#d9bd6a" strokeWidth="1.2" />
    <path d="M3.2 13.8H20.8" stroke="#d9bd6a" strokeWidth="1.4" />
    {renderEyes(<g fill="#17242e"><circle cx="8.5" cy="11.8" r="1.9" stroke="#e8cf82" strokeWidth=".7" /><circle cx="15.5" cy="11.5" r="2.0" stroke="#e8cf82" strokeWidth=".7" /></g>)}
  </>

  const articulated = <g className="mote-silhouette__press">
    <g className="mote-silhouette__gesture-head">
      <g className="mote-silhouette__head">{body}</g>
    </g>
  </g>

  return <svg className={`mote-silhouette-art${interactive ? ' mote-companion' : ''}`} viewBox="-2 -2 28 28" aria-hidden="true" data-silhouette-art={id} data-mote-silhouette-expression={expression}>
    {hasCrop ? <>
      <defs><clipPath id={`crop-${uid}`}><circle cx="12" cy="12" r="14" /></clipPath></defs>
      <g clipPath={`url(#crop-${uid})`}><g transform={cropTransform}>{articulated}</g></g>
    </> : articulated}
  </svg>
}
