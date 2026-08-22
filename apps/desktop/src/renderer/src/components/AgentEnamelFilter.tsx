import type { ReactNode } from 'react'

/**
 * Paints one Provider/badge mark like a small enamel badge: a closed neutral
 * backing, a crisp opaque tint rim, then the original artwork on top. The
 * backing is deliberately closed before it grows, so hollow marks do not get
 * a second inner outline and the tint never becomes a glow.
 */
export function AgentEnamelFilter({ id, tint, children, className, filterClassName }: {
  id: string
  tint: string
  children: ReactNode
  className: string
  filterClassName?: string
}) {
  const filterClass = filterClassName ?? `${className}-filters`
  return <>
    <svg className={filterClass} aria-hidden="true" width="0" height="0">
      <defs>
        <filter id={id} x="-50%" y="-50%" width="200%" height="200%" colorInterpolationFilters="sRGB">
          <feMorphology in="SourceAlpha" operator="dilate" radius="4" result="solidDilated" />
          <feMorphology in="solidDilated" operator="erode" radius="4" result="solidAlpha" />
          <feMorphology in="solidAlpha" operator="dilate" radius="2" result="backingAlpha" />
          <feMorphology in="solidAlpha" operator="dilate" radius="3" result="rimOuterAlpha" />
          <feComposite in="rimOuterAlpha" in2="backingAlpha" operator="out" result="rimAlpha" />
          <feFlood floodColor="var(--surface-0)" floodOpacity="1" result="backingColor" />
          <feComposite in="backingColor" in2="backingAlpha" operator="in" result="enamelBacking" />
          <feFlood floodColor={tint} floodOpacity="1" result="rimColor" />
          <feComposite in="rimColor" in2="rimAlpha" operator="in" result="enamelRim" />
          <feComposite in="enamelRim" in2="enamelBacking" operator="over" result="enamelSurface" />
          <feComposite in="SourceGraphic" in2="enamelSurface" operator="over" />
        </filter>
      </defs>
    </svg>
    <span className={className} style={{ filter: `url(#${id})` }} aria-hidden="true">
      {children}
    </span>
  </>
}
