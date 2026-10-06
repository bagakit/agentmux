import { afterEach, describe, expect, it } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ComposerLayoutToggle, type ComposerToolPhase } from '../src/components/ComposerLayoutToggle'
import { AgentAvatarBadgeIcon } from '../src/components/AgentAvatarBadgeIcon'
import { MoteIcon } from '../src/components/MoteIcon'
import { SPACE_ICON_CATALOG } from '../src/lib/space-icon-catalog'
import { WorkflowStatusGlyph } from '../src/components/WorkflowObservation'
import { updateIconSprite, removeIconSprite, semanticIconHref } from '../src/theme/icon-sprite'
import { GRAPHITE_THEME } from '../src/theme/catalog'

let root: Root | undefined, host: HTMLDivElement | undefined
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); removeIconSprite(document) })
function Controls() {
  const [phase, setPhase] = useState<ComposerToolPhase>('collapsed')
  const Choice = SPACE_ICON_CATALOG.book.Icon
  return <><ComposerLayoutToggle phase={phase} onChange={setPhase} /><output>{phase}</output>
    <MoteIcon size={18} /><AgentAvatarBadgeIcon badge="bolt" /><Choice size={20} />
    <WorkflowStatusGlyph status="running" /><WorkflowStatusGlyph status="running" recorded />
    <WorkflowStatusGlyph status="failed" /></>
}
describe('themed shared production controls', () => {
  it('changes retained sprite geometry without replacing controls or changing action/state meanings', async () => {
    updateIconSprite(document, GRAPHITE_THEME, GRAPHITE_THEME.variants.dark.colors.text)
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root!.render(<Controls />))
    const button = host.querySelector('button')!, mote = host.querySelector('[data-semantic-icon="object.mote"]')!
    expect(mote, 'The original Mote consumer must be present before testing theme projection.').not.toBeNull()
    const original = document.getElementById(semanticIconHref('object.mote').slice(1))!.innerHTML
    const icons = { ...GRAPHITE_THEME.icons, 'object.mote': { kind: 'paths' as const, paths: [{ d: 'M3 3 L21 3 L12 21 Z' }] } }
    updateIconSprite(document, { ...GRAPHITE_THEME, icons }, GRAPHITE_THEME.variants.dark.colors.text)
    expect(host.querySelector('button')).toBe(button)
    expect(host.querySelector('[data-semantic-icon="object.mote"]')).toBe(mote)
    expect(document.getElementById(semanticIconHref('object.mote').slice(1))!.innerHTML).not.toBe(original)
    expect(mote.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('object.mote'))
    expect(host.querySelector('[data-semantic-icon="space.book"] use')?.getAttribute('href')).toBe(semanticIconHref('space.book'))
    expect(host.querySelector('[data-semantic-icon="avatar.badge-bolt"]')).not.toBeNull()
    expect(host.querySelector('[data-semantic-icon="status.working"]')).not.toBeNull()
    expect(host.querySelector('[data-semantic-icon="status.running"]')).not.toBeNull()
    expect(host.querySelector('[data-semantic-icon="status.failed"]')).not.toBeNull()
    await act(async () => button.click())
    expect(button.getAttribute('aria-label')).toBe('Grow the input box for long text')
    expect(host.querySelector('output')?.textContent).toBe('current')
    expect(button.querySelector('[data-semantic-icon="layout.expand"]')).not.toBeNull()
    await act(async () => button.click())
    expect(host.querySelector('output')?.textContent).toBe('expanded')
    await act(async () => button.click())
    expect(host.querySelector('output')?.textContent).toBe('collapsed')
  })
})
