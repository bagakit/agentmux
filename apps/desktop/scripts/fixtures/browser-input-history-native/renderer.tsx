import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserAddressInput, type BrowserAddressInputHandle } from '../../../src/renderer/src/components/BrowserAddressInput'
import { useNativeOverlayChrome } from '../../../src/renderer/src/hooks/useNativeOverlayChrome'
import type { BrowserInputHistoryTarget } from '../../../src/shared/browser-input-history'
import '../../../src/renderer/src/styles/tokens.css'
import '../../../src/renderer/src/styles/base.css'
import '../../../src/renderer/src/styles/overlays.css'
import '../../../src/renderer/src/styles/browser.css'
import './fixture.css'

const observations: unknown[] = [], submissions: unknown[] = []
for (const type of ['focusin', 'focusout', 'keydown', 'keyup', 'input', 'compositionstart', 'compositionupdate', 'compositionend', 'click']) {
  document.addEventListener(type, event => {
    const e = event as KeyboardEvent & InputEvent & CompositionEvent
    observations.push({ type, trusted: event.isTrusted, at: Date.now(), key: e.key, isComposing: e.isComposing,
      inputType: e.inputType, data: e.data, target: (e.target as Element)?.getAttribute('aria-label') })
    if (observations.length > 240) observations.shift()
  }, true)
}
function Fixture() {
  const [value, setValue] = useState(''), [notice, setNotice] = useState<string | null>(null)
  const [target, setTarget] = useState<BrowserInputHistoryTarget | null>(null)
  const [paneWidth, setPaneWidth] = useState(560)
  const input = useRef<BrowserAddressInputHandle>(null)
  const warning = useNativeOverlayChrome()
  ;(window as any).historyProbe = {
    configure: (next: BrowserInputHistoryTarget, width: number) => { setTarget(next); setPaneWidth(width) },
    read: () => {
      const node = document.querySelector<HTMLInputElement>('input[role="combobox"]')!, panel = document.querySelector('.browser-address-history')
      const bounds = (element: Element | null) => { const r = element?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null }
      return { value: node?.value, selection: [node?.selectionStart, node?.selectionEnd], focused: document.activeElement === node,
        expanded: node?.getAttribute('aria-expanded'), activeDescendant: node?.getAttribute('aria-activedescendant'),
        input: bounds(node), panel: bounds(panel), panelText: panel?.textContent, notice, warning,
        options: [...document.querySelectorAll('[role="option"]')].map(node => ({ text: node.textContent, selected: node.getAttribute('aria-selected') })),
        events: observations.slice(), submissions: submissions.slice(), viewport: { width: innerWidth, height: innerHeight }, at: Date.now() }
    }
  }
  return <main className="history-native-fixture" style={{ width: paneWidth }}>
    <div className="history-native-fixture__label">Browser input · private native component probe</div>
    <form className="browser-toolbar" onSubmit={event => { event.preventDefault(); input.current?.submit() }}>
      <label><BrowserAddressInput ref={input} aria-label="Native history address" placeholder="Search or enter an address" value={value}
        onValueChange={setValue} onSubmit={text => submissions.push({ text, at: Date.now() })} historyTarget={target}
        onHistoryNotice={setNotice} onDeferredHistoryFailure={setNotice} /></label>
      <button type="submit" aria-label="Submit address">↗</button>
    </form>
    {notice || warning ? <p className="history-native-fixture__notice">{notice ?? warning}</p> : null}
    <div className="history-native-fixture__stage" aria-label="Original native page stage" />
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
