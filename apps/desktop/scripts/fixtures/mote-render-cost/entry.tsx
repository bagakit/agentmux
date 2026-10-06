import { fixturePath as _reshape_fixturePath, fixtureEpoch as _reshape_fixtureEpoch } from "../../../../../test/fixture-values.mjs"
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { SpaceObjectIcon } from '../../../src/renderer/src/components/SpaceObjectIcon'
import { useAppStore } from '../../../src/renderer/src/store'
import { DEFAULT_MOTE_FACE, MOTE_FACE_PARTS } from '../../../../../packages/core/src/mote-face'
import type { MoteFace } from '../../../../../packages/core/src/mote-face'
import type { SessionSnapshot } from '../../../src/shared/contracts'
import '../../../src/renderer/src/styles/index.css'
import './scene.css'

const w = window as any
const errors: string[] = [],
  inputs: string[] = [],
  compositions: unknown[] = []
w.fixtureErrors = errors
window.addEventListener('error', (event) => errors.push(event.message))
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)))
const face = {
  kind: 'face',
  shape: 'round',
  palette: 'mint',
  eyes: 'oval',
  brows: 'soft',
  mouth: 'smile',
  accessory: 'horns',
  nose: 'button',
  marking: 'freckles'
} as const
const term = new Terminal({
  cols: 92,
  rows: 24,
  scrollback: 10000,
  fontSize: 15,
  fontFamily: 'monospace',
  theme: { background: '#15171b', foreground: '#d4d8df' }
})
let output = 0,
  completedOutput = 0,
  ticking: ReturnType<typeof setInterval> | undefined
const write = () =>
  term.write(`live-output-${++output}  original terminal output remains available\r\n`, () => {
    completedOutput++
  })
const sessions: SessionSnapshot[] = Array.from({ length: 8 }, (_, i) => ({
  id: `private-face-${i}`,
  kind: 'agent',
  providerId: 'fixture',
  executorId: 'fixture',
  hostId: 'local',
  workspacePath: _reshape_fixturePath("private-mote-cost"),
  label: `Mote ${i + 1}`,
  createdAt: _reshape_fixtureEpoch(0, 0, 1),
  updatedAt: _reshape_fixtureEpoch(0, 0, 1),
  processState: 'running',
  latestOutputBytes: 0,
  status: { state: 'done', source: 'native-hook', observedAt: _reshape_fixtureEpoch(0, 0, 1) },
  semanticStatus: { state: 'done', source: 'native-hook', observedAt: _reshape_fixtureEpoch(0, 0, 1), stateEnteredAt: _reshape_fixtureEpoch(0, 0, 1) },
  control: {
    kind: 'agent',
    hostId: 'local',
    agentSessionId: `private-face-${i}`,
    run: { runId: `private-face-run-${i}` }
  },
  capabilities: {
    terminal: true,
    timeline: 'complete-events',
    permission: 'observe',
    providerResume: false,
    replyCorrelation: 'none'
  }
}))
function Faces() {
  const [visible, setVisible] = useState(true)
  const [choice, setChoice] = useState<MoteFace>(face)
  const [sleeping, setSleeping] = useState(false)
  w.setFacesVisible = setVisible
  w.setFaceChoice = setChoice
  w.setFacesSleeping = setSleeping
  return (
    <aside
      id="faces"
      className="mote-directory"
      data-mote-directory-view="collaborators"
      aria-label="Mote identities"
    >
      {Array.from({ length: 8 }, (_, index) => (
        <button
          key={index}
          data-face-button={index}
          data-slot={
            ['auto', 'auto', 'footer', 'footer', 'directory', 'directory', 'preview', 'preview'][index]
          }
          className={
            index < 2
              ? ''
              : index < 4
                ? 'pmo-teams-topic-compact-launcher__button'
                : index < 6
                  ? 'space-mote-row'
                  : 'mote-face-editor__preview'
          }
          aria-label={`Mote ${index + 1}`}
        >
          <span
            className={index >= 2 && index < 4 ? 'pmo-teams-topic-compact-launcher__surface' : 'cost-slot'}
          >
            <SpaceObjectIcon
              kind="mote"
              name={`Mote ${index + 1}`}
              manualIcon={{
                ...choice,
                palette:
                  choice.palette === 'mint'
                    ? (['mint', 'peach', 'lavender', 'sky', 'cocoa', 'sand', 'rose', 'slate'] as const)[index]
                    : choice.palette
              }}
              visible={visible}
              moteSessionId={sleeping ? undefined : `private-face-${index}`}
              moteAvailability={sleeping ? 'no-agent' : 'static'}
              moteHostId="local"
            />
          </span>
        </button>
      ))}
    </aside>
  )
}
useAppStore.setState({ sessions, timelines: {} })
createRoot(document.getElementById('root')!).render(
  <main>
    <header>
      <span>Original Mote animations · private Native fixture</span>
      <Faces />
    </header>
    <section id="terminal-shell">
      <p>Live terminal · output, scroll and composition</p>
      <div id="terminal" />
    </section>
    <div id="retained" aria-hidden="true" />
  </main>
)
const nodes = () => Array.from(document.querySelectorAll<HTMLElement>('.mote-identity-motion'))
const rect = (n: Element) => {
  const r = n.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}
w.proof = {
  ready: false,
  defaultFace: DEFAULT_MOTE_FACE,
  parts: MOTE_FACE_PARTS,
  choose(choice: MoteFace) {
    w.setFaceChoice(choice)
  },
  scale(count: number) {
    const parent = document.getElementById('retained')!,
      fragment = document.createDocumentFragment()
    parent.replaceChildren()
    for (let i = 0; i < count; i++) {
      const section = document.createElement('section')
      section.className = 'retained-workface'
      const p = document.createElement('p')
      p.textContent = `Original retained workface ${i}`
      section.append(p)
      fragment.append(section)
    }
    parent.append(fragment)
  },
  trigger(kind: string) {
    const state = kind === 'pointer-state' ? ('starting' as const) : ('done' as const)
    useAppStore.setState({
      sessions: sessions.map((session) => ({
        ...session,
        status: { state, source: 'native-hook' as const, observedAt: Date.now() }
      }))
    })
    for (const [i, n] of nodes().entries()) {
      n.style.setProperty('--mote-ambient-delay', '-11400ms')
      if (kind === 'pointer-state') n.dataset.moteGesture = 'focus'
      else delete n.dataset.moteGesture
    }
    if (ticking) clearInterval(ticking)
    ticking = setInterval(write, 40)
  },
  stop() {
    if (ticking) clearInterval(ticking)
    ticking = undefined
  },
  facts(includeGeometry = false) {
    const n = nodes(),
      viewport = term.buffer.active
    return {
      visibility: document.visibilityState,
      viewport: { width: innerWidth, height: innerHeight },
      faces: n.map((n) => ({
        rect: rect(n),
        contain: getComputedStyle(n).contain,
        motion: n.dataset.moteMotion,
        visible: n.dataset.moteVisible,
        expression: n.dataset.moteExpression,
        gaze: getComputedStyle(n.querySelector('.mote-face__gaze-follow')!).transform,
        head: getComputedStyle(n.querySelector('.mote-face__head')!).transform,
        overflow: getComputedStyle(n.querySelector('.mote-face')!).overflow,
        display: getComputedStyle(n).display,
        svg: n.querySelector('.mote-face')!.outerHTML,
        transform: getComputedStyle(n.querySelector('.mote-face__gesture-eyes')!).transform,
        viewBox: n.querySelector('.mote-face')!.getAttribute('viewBox'),
        selectedParts: Object.fromEntries(
          [...n.querySelector('.mote-face')!.attributes]
            .filter((a) => a.name.startsWith('data-mote-face-'))
            .map((a) => [a.name, a.value])
        ),
        bones: [
          'head',
          'brows',
          'eyes',
          'gaze',
          'mouth',
          'gesture-head',
          'gesture-eyes',
          'gesture-gaze',
          'gesture-brows',
          'gesture-mouth',
          'neck',
          'gaze-follow',
          'brow-follow',
          'mouth-follow'
        ].map((name) => {
          const element = n.querySelector('.mote-face__' + name)!
          const css = getComputedStyle(element)
          const bbox =
            includeGeometry && 'getBBox' in element ? (element as SVGGraphicsElement).getBBox() : null
          return {
            name,
            tag: element.tagName,
            transform: css.transform,
            origin: css.transformOrigin,
            bbox: bbox ? { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height } : null
          }
        }),
        drawingAnimations: [...n.querySelectorAll('.mote-face__drawing')]
          .flatMap((e) => e.getAnimations())
          .map((a) => (a as CSSAnimation).animationName),
        drawingModels: [...n.querySelectorAll('.mote-face__drawing')].map((e) => {
          const css = getComputedStyle(e)
          return { width: css.width, height: css.height, overflow: css.overflow }
        }),
        animations: n
          .getAnimations({ subtree: true })
          .map((a) => ({ name: (a as CSSAnimation).animationName, state: a.playState, time: a.currentTime }))
      })),
      buttons: Array.from(document.querySelectorAll('[data-face-button]')).map((n) => ({
        rect: rect(n),
        hit:
          document
            .elementFromPoint(
              n.getBoundingClientRect().x + n.getBoundingClientRect().width / 2,
              n.getBoundingClientRect().y + n.getBoundingClientRect().height / 2
            )
            ?.closest('button') === n
      })),
      terminal: {
        viewportY: viewport.viewportY,
        baseY: viewport.baseY,
        length: viewport.length,
        output,
        completedOutput,
        inputs: [...inputs],
        compositions: [...compositions],
        rect: rect(document.querySelector('.xterm-screen')!),
        focused: document.activeElement === term.textarea
      },
      retained: document.querySelectorAll('.retained-workface').length,
      domNodes: document.querySelectorAll('*').length,
      errors: [...errors]
    }
  },
  focus() {
    term.focus()
  },
  scrollToLine(line: number) {
    term.scrollToLine(line)
  }
}
while (!document.getElementById('terminal')) await new Promise((resolve) => setTimeout(resolve, 20))
term.open(document.getElementById('terminal')!)
term.loadAddon(new WebglAddon())
term.onData((data) => {
  inputs.push(data)
  term.write(data)
})
for (const name of ['compositionstart', 'compositionupdate', 'compositionend'])
  term.textarea!.addEventListener(name, (event) =>
    compositions.push({ name, data: (event as CompositionEvent).data })
  )
await new Promise<void>((resolve) =>
  term.write(Array.from({ length: 1200 }, (_, i) => `retained-terminal-line-${i}\r\n`).join(''), resolve)
)
w.proof.ready = true
