import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import * as Menu from '../../../src/renderer/src/components/HoverDropdownMenu'
import '../../../src/renderer/src/styles/agent.css'

const actions: string[] = [], events: unknown[] = []
for (const type of ['pointerdown', 'pointerup', 'click', 'keydown', 'keyup']) document.addEventListener(type, event => events.push({ type: event.type, trusted: event.isTrusted, target: (event.target as Element)?.textContent, key: (event as KeyboardEvent).key, x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY }))
function Fixture() {
  const [viewport, setViewport] = useState('responsive')
  ;(window as any).menuProbe = { read: () => ({ actions: actions.slice(), events: events.slice(), viewport }) }
  return <main style={{ padding: 20 }}>
    <input aria-label="Original editor" defaultValue="retained draft" />
    <Menu.Root><Menu.Trigger aria-label="More browser tools">Browser</Menu.Trigger>
      <Menu.Portal><Menu.Content className="browser-menu" style={{ background: 'rgb(30, 35, 40)', color: 'white', width: 220, padding: 10 }}>
        <Menu.Item style={{ padding: 10 }} onSelect={() => actions.push('action')}>Original action</Menu.Item>
        <Menu.RadioGroup value={viewport} onValueChange={value => { setViewport(value); actions.push(value) }}>
          <Menu.RadioItem value="mobile" style={{ padding: 10 }}>Mobile viewport</Menu.RadioItem>
        </Menu.RadioGroup>
      </Menu.Content></Menu.Portal>
    </Menu.Root>
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
