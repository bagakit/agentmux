import iconUrl from '../../../../resources/icon-128.png'

export function BrandIcon({ size = 16 }: { size?: number }) {
  return <img className="brand-icon" src={iconUrl} width={size} height={size} alt="" />
}
