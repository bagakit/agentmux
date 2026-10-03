import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import { MobileConnectionRoot } from './connection/MobileConnectionRoot'
import { createBrowserPlatform } from './platform/browser'
import { createNativePlatform } from './platform/native/device'
import { parseConnectionOfferUrl } from '@agentmux/relay/offer'
import '@agentmux/client-ui/styles.css'

const overlayContainer = () => document.getElementById('mobile-overlays')!
const browser = createBrowserPlatform({ overlayContainer })
const native = Capacitor.isNativePlatform()
const adapted = native ? createNativePlatform(browser) : null
const root = document.getElementById('root')
if (!root) throw new Error('Mobile root is missing')

let offer: import('@agentmux/relay/offer').ConnectionOffer | undefined
let linkIssue: string | undefined
try { offer = parseConnectionOfferUrl(location.href) ?? undefined } catch { linkIssue = '连接链接无法读取，请在 Mac 重新复制完整链接。' }
if (offer) history.replaceState(null, '', location.pathname + location.search)
createRoot(root).render(<MobileConnectionRoot platform={adapted?.platform ?? browser} native={native}
  {...(offer ? { offer } : {})} {...(linkIssue ? { linkIssue } : {})}
  {...(adapted ? { focusComposer: adapted.focusComposer } : {})} />)
