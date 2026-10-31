import type { ComponentProps } from 'react'
import { resolveAppIcon, type AppIconId } from '../lib/app-icon-catalog.js'
import { appIconUrl } from '../lib/app-icon-url.js'

/** Pure brand presentation. Hosts supply their already observed choice. */
export function BrandIcon({ icon, size = 16, className, ...props }: {
  icon?: AppIconId | undefined; size?: number | undefined
} & Omit<ComponentProps<'img'>, 'src' | 'width' | 'height'>) {
  return <img className={['brand-icon', className].filter(Boolean).join(' ')} src={appIconUrl(icon)}
    width={size} height={size} alt="" draggable={false} data-app-icon={resolveAppIcon(icon)} {...props} />
}
