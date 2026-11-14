import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import { MobileConnectionRoot } from './connection/MobileConnectionRoot'
import { createBrowserPlatform } from './platform/browser'
import { createNativePlatform } from './platform/native/device'
import { parseConnectionLinkUrl, type ConnectionPin } from '@agentmux/relay/offer'
import '@agentmux/client-ui/styles.css'

const overlayContainer = () => document.getElementById('mobile-overlays')!
const browser = createBrowserPlatform({ overlayContainer })
const native = Capacitor.isNativePlatform()
const adapted = native ? createNativePlatform(browser) : null
const root = document.getElementById('root')
if (!root) throw new Error('Mobile root is missing')

let offer: import('@agentmux/relay/offer').ConnectionOffer | undefined
let pin: ConnectionPin | undefined
let linkIssue: string | undefined
try { const link = parseConnectionLinkUrl(location.href); if (link?.kind === 'offer') offer = link.offer; else if (link?.kind === 'pin') pin = link.pin } catch { linkIssue = '连接链接无法读取，请在 Mac 重新复制完整链接。' }
if (offer) history.replaceState(null, '', location.pathname + location.search)
createRoot(root).render(<MobileConnectionRoot platform={adapted?.platform ?? browser} native={native}
  {...(offer ? { offer } : {})} {...(pin ? { pin } : {})} {...(linkIssue ? { linkIssue } : {})}
  {...(adapted ? { focusComposer: adapted.focusComposer } : {})} />)
