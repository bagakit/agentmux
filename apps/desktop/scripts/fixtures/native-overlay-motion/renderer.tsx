import { createRoot } from 'react-dom/client'
import * as Menu from '../../../src/renderer/src/components/HoverDropdownMenu'
import { RegionContextMenu } from '../../../src/renderer/src/components/RegionContextMenu'
import { observeNativeOverlayRegions } from '../../../src/renderer/src/lib/native-overlay-regions'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/tokens.css'
import '../../../src/renderer/src/styles/base.css'
import '../../../src/renderer/src/styles/chrome.css'
import '../../../src/renderer/src/styles/overlays.css'
import '../../../src/renderer/src/styles/agent.css'

declare global { interface Window { motionBridge: { publish(value: unknown): Promise<unknown> }; motionProbe: typeof probe } }
const pageBounds = { x: 0, y: 80, width: 800, height: 520 }
const publications: unknown[] = [], observations: unknown[] = [], actions: string[] = [], originalSurfaces = new Set<HTMLElement>()
let settled = Promise.resolve<unknown>(undefined)
let edgeEntry = false
mountThemeRuntime(window)
createRoot(document.getElementById('root')!).render(<>
  <Menu.Root><Menu.Trigger id="menu-trigger" style={{ position: 'fixed', left: 180, top: 50 }}>Original toolbar</Menu.Trigger>
    <Menu.Portal><Menu.Content className="tab-context-menu">
      <Menu.Item className="tab-context-menu__item" onSelect={() => actions.push('rename')}>Rename Tab</Menu.Item>
      <Menu.Item className="tab-context-menu__item">Show only this Region</Menu.Item>
    </Menu.Content></Menu.Portal>
  </Menu.Root>
  <RegionContextMenu regionId="original-region" agentSessionId={null} writeClipboardText={async () => {}} splitMenu={[]}
    swapMenu={[{ targetRegionId: 'original-sibling', label: 'Swap with original sibling', onSelect: () => actions.push('swap') }]}>
    <section id="region" style={{ position: 'fixed', left: 10, top: 5, width: 160, height: 60 }}>Original Region</section>
  </RegionContextMenu>
  <section id="terminal"><span>Unrelated terminal bytes</span></section>
</>)
const surfaces = () => [...document.querySelectorAll<HTMLElement>('[role="menu"]')].flatMap(node => {
  const style = getComputedStyle(node), rect = node.getBoundingClientRect()
  if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0 || node.dataset.state === 'closed') return []
  originalSurfaces.add(node)
  return [{ id: node.id, text: node.textContent, opacity: style.opacity, animation: style.animationName,
    static: node.getAttribute('data-native-overlay-motion'), bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }]
})
const overlay = observeNativeOverlayRegions(document.body, () => 1, (regions, warning) => {
  const publication = { regions, warning, surfaces: surfaces() }
  publications.push(publication)
  settled = settled.then(() => window.motionBridge.publish(publication))
}, reading => observations.push(reading), { revision: 1, bounds: [pageBounds] })
const probe = {
  read: () => ({ publications, observations, actions, surfaces: surfaces(),
    markedOriginalSurfaces: [...originalSurfaces].filter(node => node.hasAttribute('data-native-overlay-motion')).length }),
  settled: () => settled,
  demand: (visible: boolean, bounds = pageBounds) => overlay.setNativeDemand({ revision: visible ? 3 : 2, bounds: visible ? [bounds] : [] }),
  edgeEntry: (enabled: boolean) => { edgeEntry = enabled },
  churn: () => { const terminal = document.querySelector('#terminal')!; for (let i = 0; i < 50; i++) { terminal.append(document.createTextNode('.')); terminal.dispatchEvent(new Event('scroll')) } },
  dispose: () => overlay.dispose()
}
// Hold only the real production animation's first frame for a deterministic
// final-only overlap boundary. The product collector must remove that animation.
document.addEventListener('animationstart', event => {
  if (edgeEntry && event.target instanceof HTMLElement && event.target.matches('[role="menu"]')) {
    for (const animation of event.target.getAnimations()) { animation.pause(); animation.currentTime = 0 }
  }
}, true)
window.motionProbe = probe
