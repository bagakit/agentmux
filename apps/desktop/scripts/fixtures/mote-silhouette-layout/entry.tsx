import { useState, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { SpaceObjectIcon } from '../../../src/renderer/src/components/SpaceObjectIcon'
import { MoteAvatarCrop } from '../../../src/renderer/src/components/MoteAvatarCrop'
import { MOTE_SILHOUETTE_TITLES } from '../../../src/renderer/src/components/MoteSilhouetteArt'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { mountThemeRuntime, updateThemeSelection } from '../../../../../packages/client-ui/src/theme/runtime'
import { DEFAULT_MOTE_FACE } from '../../../../../packages/core/src/mote-face'
import type { SessionSnapshot } from '../../../src/shared/contracts'
import type { SpaceIconChoice as SpaceManualIcon } from '../../../src/renderer/src/lib/space-object-appearance'
import '../../../src/renderer/src/styles/index.css'
import './scene.css'

const w = window as any, errors: string[] = [], inputs: string[] = [], compositions: unknown[] = []
window.addEventListener('error', e => errors.push(e.message)); window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)))
const releaseTheme = mountThemeRuntime(window, { appAppearance: 'dark' })
const term = new Terminal({ cols: 96, rows: 12, scrollback: 10000, fontSize: 14, theme: { background: '#15171b', foreground: '#d4d8df' } })
let ticking: ReturnType<typeof setInterval> | undefined, output = 0, completed = 0, clicks = 0
const ids = [...Object.keys(MOTE_SILHOUETTE_TITLES), 'dragon']
const imageSource = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#466956"/><circle cx="128" cy="128" r="70" fill="#a3d6b8"/></svg>')
const choice = (id: string) => ({ kind: 'series', source: { origin: 'builtin', seriesId: id === 'dragon' ? 'lowpoly' : 'mote-silhouettes', entryId: id, revision: 'sha256:' + '1'.repeat(64) }, parameters: { kind: 'image', zoom: 1, offsetX: 0, offsetY: 0 }, image: { kind: 'image', fileName: 'a'.repeat(64) + '.png' } }) as SpaceManualIcon
const image = document.createElement('canvas'); image.width = image.height = 256; const context = image.getContext('2d')!; context.fillStyle = '#466956'; context.fillRect(0,0,256,256); context.fillStyle = '#a3d6b8'; context.fillRect(64,64,128,128); api.scratch.readMoteAvatar = async () => ({ width:256, height:256, dataUrl:image.toDataURL('image/png') });
const slotKinds = ['rail', 'chooser', 'footer', 'directory', 'list', 'preview']
function Scene() {
  const [visible, setVisible] = useState(true), [selected, setSelected] = useState('retro-future'), [extra, setExtra] = useState(false), [size, setSize] = useState(45), [bound, setBound] = useState(false), [neighbourMotion, setNeighbourMotion] = useState(true)
  const canvas = useRef<HTMLCanvasElement>(null)
  Object.assign(w, { setVisible, setSelected, setExtra, setSize, setBound, setNeighbourMotion })
  return <main><header><strong>Original Mote consumers · private Native fixture</strong></header>
    <section id="original-slots" className="workbench-layout-body">
      <div id="slots">{slotKinds.map((slot, i) => <section key={slot} data-case={slot} className={slot === 'directory' || slot === 'list' ? 'mote-directory' : ''}
        {...(slot === 'directory' || slot === 'list' ? { 'data-mote-directory-view': slot === 'directory' ? 'collaborators' : 'list' } : {})} style={{ '--mote-directory-avatar-size': `${size}px` } as React.CSSProperties}>
        <small>{slot}</small>{slot === 'preview' ? <div className="mote-avatar-preview" role="img" aria-label="Original avatar preview"><SpaceObjectIcon kind="mote" name={slot} manualIcon={choice('dragon')} visible={visible} moteSessionId={bound ? 'private-silhouette-agent' : undefined} moteHostId="local" /></div> : <button data-slot-button={slot} onClick={() => clicks++} className={slot === 'footer' ? 'pmo-teams-topic-compact-launcher__button' : slot === 'directory' || slot === 'list' ? 'space-mote-row' : slot === 'preview' ? 'mote-avatar-preview' : slot === 'chooser' ? 'mote-chooser__name' : 'project-rail-row'}>
          {slot === 'footer' ? <span className="pmo-teams-topic-compact-launcher__surface"><SpaceObjectIcon kind="mote" name={slot} manualIcon={choice(i % 2 ? 'dragon' : selected)} visible={visible} moteSessionId={bound ? 'private-silhouette-agent' : undefined} moteHostId="local" /></span> : <SpaceObjectIcon kind="mote" name={slot} manualIcon={choice(i % 2 ? 'dragon' : selected)} visible={visible} moteSessionId={bound ? 'private-silhouette-agent' : undefined} moteHostId="local" />}
        </button>}</section>)}
      <section data-case="crop"><small>crop</small><MoteAvatarCrop source={imageSource} silhouetteId="dragon" visible={visible} canvasRef={canvas} disabled={false} onReady={() => { w.cropReady = true }} onFrame={frame => { w.cropFrame = frame }} onError={message => errors.push(message)} /></section>
      </div>
      <aside id="neighbours">{[null, DEFAULT_MOTE_FACE, 'book', {kind:'image',fileName:'a'.repeat(64)+'.png'}].map((manualIcon, i) => <button key={i} data-neighbour={i} aria-label={'Neighbour ' + i}><SpaceObjectIcon kind="mote" name="Neighbour" manualIcon={manualIcon as SpaceManualIcon} visible={visible && neighbourMotion} avatarWorkspaceId="private" avatarTopicId="private" avatarObjectKey="private-image" /></button>)}</aside><aside id="static-chips">{[45,24].map(size=><span key={size} data-static-chip={size} className={'mote-avatar-stage__slot mote-avatar-stage__slot--'+size}><SpaceObjectIcon kind="mote" name="Static sample" manualIcon={choice(selected)} visible={false} /></span>)}</aside>
      {extra ? <aside id="extra">{Array.from({ length: 6 }, (_, i) => <SpaceObjectIcon key={i} kind="mote" name={'Additional ' + i} manualIcon={choice(i % 2 ? 'dragon' : 'retro-future')} visible={visible} />)}</aside> : null}
    </section>
    <section id="terminal-shell"><p>Live terminal · output, reading and composition</p><div id="terminal" /></section><div id="retained" aria-hidden="true" />
  </main>
}
createRoot(document.getElementById('root')!).render(<Scene />)
const rect = (node: Element) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
const motion = () => [...document.querySelectorAll<HTMLElement>('.mote-identity-motion')]
w.proof = {
  ready: false, ids,
  state(value: string) {
    const now = Date.now(), run = { runId: 'private-silhouette-run' }
    const session = { id: 'private-silhouette-agent', kind: 'agent', providerId: 'fixture', executorId: 'fixture', hostId: 'local', workspacePath: '/private/mote-fixture', label: 'Private Mote', createdAt: now, updatedAt: now, processState: 'running', latestOutputBytes: 0,
      status: { state: value === 'starting' ? 'starting' : value === 'waiting' ? 'waiting' : 'working', source: 'native-hook', observedAt: now },
      semanticStatus: { state: 'working', source: 'native-hook', observedAt: now, stateEnteredAt: now },
      ...(['thinking', 'tool'].includes(value) ? { currentActivity: { state: 'active', nativeSessionId: 'private-native', nativeTurnId: 'private-turn', sourceId: 'private-channel', sequence: 1, source: 'native-hook', run, hookReceiptId: 'private-receipt', observedAt: now } } : {}),
      control: { kind: 'agent', hostId: 'local', agentSessionId: 'private-silhouette-agent', run }, capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: false, replyCorrelation: 'none' } } as SessionSnapshot
    useAppStore.setState({ sessions: [session], timelines: value === 'tool' ? { [session.id]: { agentSessionId: session.id, revision: 1, items: [], liveTool: { itemId: 'private-tool', hostId: 'local', runId: run.runId, epoch: now, observedAt: now, startedAt: now } } } : {} })
    w.setBound(value !== 'identity')
  },
  visible(value: boolean) { w.setVisible(value) }, choose(id: string) { w.setSelected(id) }, extra(value: boolean) { w.setExtra(value) }, size(value: number) { w.setSize(value) }, neighbours(value: boolean) { w.setNeighbourMotion(value) },
  parked(value: boolean) { document.getElementById('original-slots')!.dataset.workbenchLayoutState = value ? 'parked' : 'visible' },
  theme(light: boolean) { updateThemeSelection({ appAppearance: light ? 'light' : 'dark' }) },
  scale(count: number) { const host = document.getElementById('retained')!, fragment = document.createDocumentFragment(); host.replaceChildren(); for (let i = 0; i < count; i++) { const node = document.createElement('section'); node.className = 'retained-workface'; const p = document.createElement('p'); p.textContent = 'Retained workface ' + i; node.append(p); fragment.append(node) } host.append(fragment) },
  reset() { for (const n of motion()) for (const a of n.getAnimations({ subtree: true })) if (['mote-breathe', 'mote-blink'].includes((a as CSSAnimation).animationName)) a.currentTime = 0 },
  output(enabled: boolean) { if (ticking) clearInterval(ticking); ticking = undefined; if (enabled) ticking = setInterval(() => term.write(`live-${++output} original terminal output\r\n`, () => completed++), 40) },
  focus() { term.focus() }, scroll(line: number) { term.scrollToLine(line) },
  gesture(value: string) { for (const n of motion()) n.dataset.moteGesture = value },
  facts() { return { visibility: document.visibilityState, viewport: { width: innerWidth, height: innerHeight }, errors: [...errors], cropReady: !!w.cropReady, cropFrame: w.cropFrame, clicks,
    retained: document.querySelectorAll('.retained-workface').length, visibleMotionCount: motion().filter(n => n.dataset.moteMotion === 'on').length,
    slots: [...document.querySelectorAll<HTMLElement>('[data-case]')].map(slot => { const svg = slot.querySelector('svg.mote-silhouette-art')!, n = slot.querySelector<HTMLElement>('.mote-identity-motion') ?? svg.parentElement!; return { slot: slot.dataset.case, rect: rect(n), svgRect: rect(svg), display: getComputedStyle(n).display, overflow: getComputedStyle(svg).overflow, motion: n.dataset.moteMotion, visible: n.dataset.moteVisible, expression: n.dataset.moteExpression,
      animations: n.getAnimations({ subtree: true }).map(a => ({ name: (a as CSSAnimation).animationName, state: a.playState, time: a.currentTime })),
      bones: ['head', 'eyes', 'gaze', 'gesture-head', 'gesture-gaze', 'press'].map(name => { const part = svg.querySelector('.mote-silhouette__' + name); return { name, transform: part ? getComputedStyle(part).transform : null } }) } }),
    buttons: [...document.querySelectorAll<HTMLButtonElement>('[data-slot-button]')].map(node => { const r = rect(node); return { slot: node.dataset.slotButton, rect: r, hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === node } }),
    terminal: { rect: rect(document.querySelector('.xterm-screen')!), viewportY: term.buffer.active.viewportY, completed, output, inputs: [...inputs], compositions: [...compositions], focused: document.activeElement === term.textarea } } },
  stop() { if (ticking) clearInterval(ticking); term.dispose(); releaseTheme() }
}
while (!document.getElementById('terminal')) await new Promise(r => setTimeout(r, 20))
term.open(document.getElementById('terminal')!); term.loadAddon(new WebglAddon()); term.onData(data => { inputs.push(data); term.write(data) })
for (const name of ['compositionstart', 'compositionupdate', 'compositionend']) term.textarea!.addEventListener(name, e => compositions.push({ name, data: (e as CompositionEvent).data }))
await new Promise<void>(resolve => term.write(Array.from({ length: 1200 }, (_, i) => `original-line-${i}\r\n`).join(''), resolve)); useAppStore.setState({ sessions: [], timelines: {} }); w.proof.ready = true
