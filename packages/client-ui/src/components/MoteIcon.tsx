import type { SVGProps } from 'react'
import { SemanticIcon } from '../theme/icons.js'

/** Product Mote navigation mark; authored avatar identity remains independent. */
export function MoteIcon({ size = 14, ...props }: { size?: number } & SVGProps<SVGSVGElement>) {
  return <SemanticIcon {...props} name="object.mote" size={size} />
}
