import { useId, type SVGProps } from 'react'
import { SemanticIcon } from '../theme/icons.js'
import { MOTE_COMPANION_PARTS as parts } from '../theme/icon-authored.js'

type MoteIconProps = { size?: number; interactive?: boolean } & SVGProps<SVGSVGElement>
/** Types and records stay static. Only the existing visible avatar owner opts in. */
export function MoteIcon({ size = 14, interactive = false, ...props }: MoteIconProps) {
  return interactive ? <CompanionIcon {...props} size={size} /> : <SemanticIcon {...props} name="object.mote" size={size} />
}

function CompanionIcon({ className, ...props }: Omit<MoteIconProps, 'interactive'>) {
  const mask = useId()
  return <SemanticIcon {...props} name="object.mote" className={['mote-companion', className].filter(Boolean).join(' ')}>
    <g className="mote-companion__rig" fill="currentColor" stroke="none">
      <g className="mote-companion__press"><g className="mote-companion__head">
        <defs><mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24" style={{ maskType: 'luminance' }}>
          <rect width="24" height="24" fill="white" />
          <g className="mote-companion__gaze"><g className="mote-companion__eyes" fill="black">
            <path d={parts.leftEye} /><path d={parts.rightEye} />
          </g></g>
        </mask></defs>
        <path d={parts.body} mask={`url(#${mask})`} />
      </g></g>
    </g>
  </SemanticIcon>
}
