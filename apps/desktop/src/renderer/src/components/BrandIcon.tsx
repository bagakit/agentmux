import { BrandIcon as BrandArtwork } from '@agentmux/client-ui/components/BrandIcon'
import { useAppStore } from '../store'
import type { ComponentProps } from 'react'

/** Desktop connects the original committed configuration to shared, stateless artwork. */
export function BrandIcon(props: Omit<ComponentProps<typeof BrandArtwork>, 'icon'>) {
  const icon = useAppStore(state => state.config?.appearance.appIcon)
  return <BrandArtwork {...props} icon={icon} />
}
