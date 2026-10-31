import { resolveAppIcon, type AppIconId } from './app-icon-catalog.js'
import qingzhuan from '../assets/app-icons/qingzhuan.png'
import huihuan from '../assets/app-icons/huihuan.png'
import zheyu from '../assets/app-icons/zheyu.png'
import lingban from '../assets/app-icons/lingban.png'
import classic from '../assets/app-icons/classic.png'

const assets = { qingzhuan, huihuan, zheyu, lingban, classic } satisfies Record<AppIconId, string>

/** Browser bundlers project the same five authoritative assets; no configuration is held here. */
export function appIconUrl(icon?: AppIconId): string {
  return assets[resolveAppIcon(icon)]
}
