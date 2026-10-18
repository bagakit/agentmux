import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { browserAgentEffectsCss, type BrowserAgentControlPreferences } from '../../../../shared/browser-agent-control'
import { AgentProviderIcon } from '../AgentProviderIcon'
import { BrowserControlBoundary } from '../BrowserControlBoundary'
import { BrowserOperationStatus } from '../BrowserOperationSurface'
import type { BrowserOperation } from '../../../../shared/browser-operation'

const targets = [{ x: .23, y: .39 }, { x: .72, y: .39 }, { x: .72, y: .72 }] as const
type PreviewPhase = 'running' | 'observing' | 'script' | 'navigating' | 'waiting' | 'completed' | 'human'

/** Local illustration only: no API, Store, Browser, Session or navigation reads. */
export function BrowserAgentControlPreview({ preferences, active, dirty }: { preferences: BrowserAgentControlPreferences; active: boolean; dirty: boolean }) {
  const [phase, setPhase] = useState<PreviewPhase>('running')
  const [background, setBackground] = useState<'light' | 'dark'>('light')
  const [playing, setPlaying] = useState(false), [step, setStep] = useState(0)
  const [ripple, setRipple] = useState<number | null>(null)
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden')
  const [shadow, setShadow] = useState<ShadowRoot | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const stage = useRef<HTMLDivElement>(null)
  const attachEffects = useCallback((node: HTMLDivElement | null) => {
    if (node) setShadow(node.shadowRoot ?? node.attachShadow({ mode: 'open' }))
  }, [])
  useEffect(() => {
    const change = () => setVisible(document.visibilityState !== 'hidden')
    change()
    if (!active) return
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [active])
  useLayoutEffect(() => {
    if (!active || !visible || !stage.current) return
    const measure = () => { const rect = stage.current!.getBoundingClientRect(); setSize({ width: rect.width, height: Math.max(0, rect.height - 29) }) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage.current)
    return () => observer.disconnect()
  }, [active, visible])
  useEffect(() => {
    if (!active || !visible || !playing || phase !== 'running') return
    const timer = window.setInterval(() => setStep(value => value + 1), Math.max(1400, preferences.pointerDurationMs + preferences.clickDurationMs + 400))
    return () => window.clearInterval(timer)
  }, [active, visible, playing, phase, preferences.pointerDurationMs, preferences.clickDurationMs])
  useEffect(() => {
    setRipple(null)
    if (!active || !visible || phase !== 'running' || step === 0 || !preferences.clickRipple) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const start = window.setTimeout(() => setRipple(step), preferences.pointerTween && !reduced ? preferences.pointerDurationMs : 0)
    const end = window.setTimeout(() => setRipple(null), (preferences.pointerTween && !reduced ? preferences.pointerDurationMs : 0) + preferences.clickDurationMs)
    return () => { window.clearTimeout(start); window.clearTimeout(end) }
  }, [active, visible, phase, step, preferences.clickRipple, preferences.pointerTween, preferences.pointerDurationMs, preferences.clickDurationMs])
  const point = targets[step % targets.length]!
  const position = { left: point.x * size.width, top: (preferences.showDiscussion ? Math.min(point.y, .3) : point.y) * size.height }
  const operating = active && visible && phase !== 'human'
  const operation: BrowserOperation = {
    id: 'simulation-operation', browserId: 'simulation-browser', operator: { id: 'simulation-agent', name: 'Sample Agent', providerId: 'codex' },
    startedAt: 0, url: 'https://example.test/workspace', summary: 'Local appearance simulation',
    phase: phase === 'human' || phase === 'completed' || phase === 'waiting' ? phase : 'running',
    steps: [{ sequence: step + 1, method: phase === 'observing' ? 'snapshot' : phase === 'script' ? 'js' : phase === 'navigating' ? 'gotoUrl' : phase === 'waiting' ? 'wait' : 'click',
      label: 'Sample step', startedAt: 0, status: phase === 'completed' ? 'completed' : phase === 'human' ? 'stopped' : 'running' }]
  }
  return <section className="browser-agent-preview" aria-label="Agent control simulation">
    <header className="browser-agent-preview__header"><span><strong>Live preview</strong><small>Simulation · {dirty ? 'unsaved draft' : 'saved appearance'}</small></span>
      <div className="browser-agent-preview__playback">
        <button type="button" className="small-button" disabled={phase !== 'running'} onClick={() => setPlaying(value => !value)} aria-pressed={playing}>{playing ? 'Pause' : 'Play'}</button>
        <button type="button" className="small-button" disabled={phase !== 'running'} onClick={() => setStep(value => value + 1)}>Step</button>
      </div>
    </header>
    <div className="browser-agent-preview__options">
      <label>State <select aria-label="Simulation state" value={phase} onChange={event => setPhase(event.target.value as PreviewPhase)}>
        <option value="running">Agent operating</option><option value="observing">Observing page</option><option value="script">Running script</option><option value="navigating">Navigating</option><option value="waiting">Agent waiting</option><option value="completed">Completed</option><option value="human">User control</option>
      </select></label>
      <label>Page <select aria-label="Simulation page" value={background} onChange={event => setBackground(event.target.value as 'light' | 'dark')}><option value="light">Light</option><option value="dark">Dark</option></select></label>
    </div>
    <div className="browser-agent-preview__stage" data-background={background} ref={stage}>
      <div className="browser-agent-preview__browserbar"><span className="browser-agent-preview__address">example.test / workspace</span>
        <BrowserOperationStatus browserId={operation.browserId} activity={{ operation, control: operating ? 'agent' : 'human' }}
          control={{ owner: operating ? 'agent' : 'human', activeOperationId: operating && phase !== 'completed' ? operation.id : null, revision: 0, inputIsolation: operating ? 'isolated' : 'inactive' }}
          onTakeControl={() => setPhase('human')} onReturnControl={() => setPhase('completed')} />
      </div>
      <div className="browser-agent-preview__page">
        <span className="browser-agent-preview__eyebrow">SAMPLE WORKSPACE</span><h3>A clear view of the work.</h3>
        <div className="browser-agent-preview__sample-row"><span>Design review<small>Ready to share</small></span><span className="browser-agent-preview__sample-button">Open details ↗</span></div>
        <div className="browser-agent-preview__sample-lines"><i /><i /><i /></div>
      </div>
      {preferences.showDiscussion && operating ? <div className="browser-agent-preview__discussion"><strong>Message sample Agent <span>×</span></strong><span>Your comment about this step…</span><small>Browser · step {step + 1}<b>↑</b></small></div> : null}
      <div className="browser-agent-preview__effects" ref={attachEffects} aria-hidden="true">
        {shadow && createPortal(<>
          <style>{browserAgentEffectsCss(preferences)}</style>
          <div className="amux-browser-agent-effects" data-active={operating} data-phase={phase}>
            <div className="amux-browser-agent-glow" />
            {phase === 'running' ? <div className="amux-browser-agent-pointer" data-label-side={point.x > .5 ? 'left' : 'right'} data-label-above={preferences.showDiscussion || point.y > .7} style={{ transform: `translate3d(${position.left}px,${position.top}px,0)` }}>
              <svg className="amux-browser-agent-arrow" viewBox="0 0 18 24"><path d="M1 1 16 14l-7 1-3 7z" /></svg>
              <span className="amux-browser-agent-label"><span className="amux-browser-agent-avatar"><AgentProviderIcon providerId="codex" size={17} /></span><span className="amux-browser-agent-label-text"><span className="amux-browser-agent-label-name">Sample Agent</span><small>{`Click · step ${step + 1}`}</small></span></span>
            </div> : null}
            {phase === 'running' && ripple !== null ? <div key={ripple} className="amux-browser-agent-ripple" style={position} /> : null}
          </div>
        </>, shadow)}
      </div>
      {operating ? <div className="browser-agent-preview__boundary"><BrowserControlBoundary preferences={preferences} /></div> : null}
    </div>
    <p className="browser-agent-preview__caption" role="status">{phase === 'human' ? 'Your turn · page input is available; agent effects are cleared.'
      : phase === 'completed' ? 'Completed · Agent retains control. Take control explicitly to interact with the page.'
        : phase === 'waiting' ? 'Waiting · the steady edge stays visible; no pointer or clicks are simulated.'
          : phase === 'navigating' ? 'Navigating · the steady edge survives a change of page.'
            : phase === 'observing' ? 'Observing · the agent reads the page without pointing at a target.'
              : phase === 'script' ? 'Script · the activity badge identifies execution without inventing a pointer target.'
                : 'Play or step to compare cursor motion and click feedback.'}</p>
  </section>
}
