import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import { MobileConnectionRoot } from './connection/MobileConnectionRoot'
import { createBrowserPlatform } from './platform/browser'
import { createNativePlatform } from './platform/native/device'
import { createNativePrivateAccess } from './platform/native/private-transport'
import { connectPrivateHostedClient } from './connection/hosted-rpc'
import '@agentmux/client-ui/styles.css'

const overlayContainer = () => document.getElementById('mobile-overlays')!
const browser = createBrowserPlatform({ overlayContainer })
const native = Capacitor.isNativePlatform()
const adapted = native ? createNativePlatform(browser) : null
const nativeAccess = native ? createNativePrivateAccess() : null
const root = document.getElementById('root')
if (!root) throw new Error('Mobile root is missing')

const parameters = new URLSearchParams(location.hash.slice(1))
const connectionCode = parameters.get('connect') ?? undefined
if (connectionCode) history.replaceState(null, '', location.pathname + location.search)

createRoot(root).render(<MobileConnectionRoot
  {...(connectionCode ? { connectionCode } : {})}
  platform={adapted?.platform ?? browser} native={native} connectClient={connectPrivateHostedClient}
  {...(adapted ? { focusComposer: adapted.focusComposer } : {})}
  {...(nativeAccess ? { nativeAccess } : {})} />
)
