import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * Real Electron: an Agent's click, fill, type, key and hover reach the page as trusted native input.
 *
 * The probe loads the production dispatcher, CDP session and own-dispatch receipt from src (bundled by
 * vite, as browser-drive-e2e.test.ts does) and drives a fixture page whose capture listeners record
 * every event's type, target and `event.isTrusted`. A fake CDP peer cannot answer this: only Chromium
 * decides whether an event is trusted, whether a press lands on the target and whether a key runs its
 * default action. The view is hidden, the state a background Agent run usually meets.
 *
 * Not proven here: that the own-dispatch wake is what lets a sleeping hidden page take the input, and
 * that the page sleeps again afterwards. On a machine whose screen is locked or whose window is
 * occluded, Chromium renders 0 frames even for a visible page, so frame counts cannot tell the two
 * states apart; removing the wake or the re-hide capture does not turn this file red there. Those two
 * facts are pinned by browser-trusted-agent-input.test.ts against the receipt's own calls.
 */

const ELECTRON_BINARY: string = createRequire(import.meta.url)('electron') as unknown as string
const SRC_MAIN = new URL('../src/main/', import.meta.url)

const FIXTURE_PAGE = `<!doctype html><html><body style="margin:0">
  <button id="go" style="position:absolute;left:40px;top:30px;width:120px;height:40px">Continue</button>
  <form id="form" style="position:absolute;left:40px;top:100px">
    <input id="name" aria-label="Name" value="old">
    <input id="email" type="email" aria-label="Email" value="a@b.c">
    <button type="submit">Send</button>
  </form>
  <div id="menu" role="button" aria-label="Menu" tabindex="0" style="position:absolute;left:40px;top:200px;width:120px;height:40px;background:#ddd">Menu</div>
  <div style="position:absolute;left:240px;top:120px">
    <input id="when" type="date" aria-label="When">
    <select id="fruit" aria-label="Fruit"><option value="a">Apple</option><option value="b">Banana</option></select>
    <input id="level" type="range" min="0" max="10" value="1" aria-label="Level">
  </div>
  <div style="position:absolute;left:240px;top:200px">
    <select id="num" aria-label="Number"><option value="0">1</option><option value="1">2</option><option value="2">3</option></select>
    <fieldset disabled style="display:inline;border:0;padding:0;margin:0"><input id="off" type="date" aria-label="Off date"></fieldset>
    <input id="stuck" type="range" min="0" max="10" value="8" readonly aria-label="Stuck">
    <input id="tint" type="color" aria-label="Tint">
    <input id="agree" type="checkbox" aria-label="Agree">
  </div>
  <div style="position:absolute;left:40px;top:300px">
    <input id="under" aria-label="Under">
    <span id="host"></span>
    <span id="closed"></span>
    <x-switch id="sw" role="switch" aria-label="Wifi"></x-switch>
    <input id="bounce" aria-label="Bounce"><input id="elsewhere" aria-label="Elsewhere">
  </div>
  <dialog id="modal"><button>Modal button</button></dialog>
  <button id="covered" style="position:absolute;left:240px;top:30px;width:120px;height:40px">Covered</button>
  <div style="position:absolute;left:230px;top:20px;width:150px;height:60px;background:rgba(0,0,0,.4)"></div>
  <script>
    window.frames_ = 0; (function frame() { window.frames_ += 1; requestAnimationFrame(frame) })()
    window.events = []
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'beforeinput', 'input', 'change', 'keydown', 'keyup', 'submit', 'mouseover'])
      document.addEventListener(type, (event) => {
        if (type === 'mouseover' && event.target.id !== 'menu') return
        events.push({ type, target: event.target.id || event.target.tagName, trusted: event.isTrusted })
      }, true)
    document.getElementById('form').addEventListener('submit', (event) => event.preventDefault())
    // A web component: its fields live in an open shadow root, so document.activeElement is the host.
    const shadow = document.getElementById('host').attachShadow({ mode: 'open' })
    shadow.innerHTML = '<input id="sdate" type="date" aria-label="Shadow date"><input id="sname" aria-label="Shadow name">'
    // A closed shadow root: the page cannot reach in, and neither can a walk down from document.
    const closed = document.getElementById('closed').attachShadow({ mode: 'closed' })
    closed.innerHTML = '<input type="date" aria-label="Closed date"><input aria-label="Closed name">'
    window.closedValues = () => [...closed.querySelectorAll('input')].map((input) => input.value)
    // A switch whose role sits on the host and which delegates focus to a button inside, as component libraries do.
    customElements.define('x-switch', class extends HTMLElement {
      constructor() { super(); this.attachShadow({ mode: 'open', delegatesFocus: true }).innerHTML = '<button>toggle</button>' }
    })
    // A field whose page handler sends focus elsewhere: typing would land in the other field.
    document.getElementById('bounce').addEventListener('focus', () => document.getElementById('elsewhere').focus())
  </script>
</body></html>`

const PROBE_MAIN = `
import { app, BrowserWindow, WebContentsView } from 'electron'
import { writeFileSync } from 'node:fs'
const report = { schema: 'agentmux.browser-trusted-input-e2e.v1', actions: {} }
app.setPath('userData', process.env.PROBE_USER_DATA)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 600, height: 400, show: true })
  window.setIgnoreMouseEvents(true)
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } })
  window.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 580, height: 380 })
  let session = null
  try {
    const { createBrowserPageDispatch, BrowserCdpSession, beginOwnDispatch, isOwnDispatch } = await import('./dispatch.mjs')
    await view.webContents.loadURL(process.env.PROBE_PAGE_URL)
    // A background Agent run usually meets a hidden page; Chromium does not process CDP input there
    // unless the receipt wakes it.
    view.setVisible(false)
    const contents = view.webContents
    // Rendered frames in a window: 0 means Chromium has put this hidden page to sleep.
    const frames = async (ms = 300) => { const start = await contents.executeJavaScript('window.frames_'); await new Promise((resolve) => setTimeout(resolve, ms)); return (await contents.executeJavaScript('window.frames_')) - start }
    // Act only once the page is really asleep; a page hidden a moment ago still processes input.
    for (let attempt = 0; attempt < 20 && (report.framesBefore = await frames()) > 0; attempt++) {}
    const ownSeen = []
    contents.on('input-event', (_event, input) => ownSeen.push(isOwnDispatch(contents, input)))
    session = BrowserCdpSession.attach(contents)
    const notes = []
    const dispatch = createBrowserPageDispatch({
      session,
      pageInfo: () => ({ url: contents.getURL(), title: contents.getTitle(), navigationId: 'nav-1' }),
      gotoUrl: async () => { throw new Error('the probe does not navigate') },
      captureScreenshot: async () => ({}), readLedger: async () => null, writeLedger: async () => {},
      note: (text) => notes.push(text),
      beginNativeInput: async () => beginOwnDispatch(contents)
    })
    const page = await dispatch('snapshot', [])
    const ref = (name) => page.nodes.find((node) => node.ref && node.name === name)?.ref
    const events = async () => await contents.executeJavaScript('window.events.splice(0)')
    const value = async (id) => await contents.executeJavaScript('document.getElementById(' + JSON.stringify(id) + ').value')
    const act = async (label, method, args, read) => {
      const before = ownSeen.length, notesBefore = notes.length
      try { await dispatch(method, args); report.actions[label] = { ok: true } }
      catch (error) { report.actions[label] = { ok: false, error: String(error && error.message || error), effects: error && error.fact && error.fact.effects } }
      await new Promise((resolve) => setTimeout(resolve, 80))
      report.actions[label].events = await events()
      report.actions[label].own = ownSeen.slice(before)
      report.actions[label].notes = notes.slice(notesBefore)
      if (read) report.actions[label].value = await read()
    }
    await events()
    await act('click', 'click', [ref('Continue')])
    await act('fill', 'fillInput', [ref('Name'), 'Ada'], () => value('name'))
    await act('type', 'typeText', [ref('Email'), 'x'], () => value('email'))
    await act('key', 'pressKey', [ref('Name'), 'Enter'])
    await act('hover', 'hover', [ref('Menu')], () => contents.executeJavaScript('document.getElementById("menu").matches(":hover")'))
    await act('covered', 'click', [ref('Covered')])
    await act('date', 'fillInput', [ref('When'), '2026-03-04'], () => value('when'))
    await act('select', 'fillInput', [ref('Fruit'), 'b'], () => value('fruit'))
    await act('range', 'fillInput', [ref('Level'), '7'], () => value('level'))
    await act('dateRefused', 'fillInput', [ref('When'), '03/04/2026'], () => value('when'))
    await act('numCrossed', 'fillInput', [ref('Number'), '2'], () => value('num'))
    await act('numByLabel', 'fillInput', [ref('Number'), '3'], () => value('num'))
    await act('offDate', 'fillInput', [ref('Off date'), '2026-03-04'], () => value('off'))
    await act('rangePlus', 'fillInput', [ref('Level'), '+3'], () => value('level'))
    await act('stuck', 'fillInput', [ref('Stuck'), '3'], () => value('stuck'))
    await act('tint', 'fillInput', [ref('Tint'), '#FF0000'], () => value('tint'))
    await act('agree', 'fillInput', [ref('Agree'), 'x'], () => contents.executeJavaScript('document.getElementById("agree").checked'))
    // A person is typing in Under; the Agent fills two fields of a web component and focus comes back.
    const shadowRead = (id) => () => contents.executeJavaScript('({ value: document.getElementById("host").shadowRoot.getElementById(' + JSON.stringify(id) + ').value, focus: document.activeElement && document.activeElement.id })')
    await contents.executeJavaScript('document.getElementById("under").focus()')
    await act('shadowDate', 'fillInput', [ref('Shadow date'), '2026-03-04'], shadowRead('sdate'))
    await act('shadowName', 'fillInput', [ref('Shadow name'), 'Ada'], shadowRead('sname'))
    await contents.executeJavaScript('document.getElementById("under").focus()')
    await act('closedDate', 'fillInput', [ref('Closed date'), '2026-03-04'], () => contents.executeJavaScript('({ value: window.closedValues()[0], focus: document.activeElement && document.activeElement.id })'))
    await act('closedName', 'fillInput', [ref('Closed name'), 'Cy'], () => contents.executeJavaScript('({ value: window.closedValues()[1], focus: document.activeElement && document.activeElement.id })'))
    await act('switchKey', 'pressKey', [ref('Wifi'), 'Enter'], () => contents.executeJavaScript('document.activeElement && document.activeElement.id'))
    await contents.executeJavaScript('document.getElementById("under").focus()')
    await act('bounce', 'fillInput', [ref('Bounce'), 'Dee'], () => contents.executeJavaScript('({ bounce: document.getElementById("bounce").value, elsewhere: document.getElementById("elsewhere").value, focus: document.activeElement && document.activeElement.id })'))
    // A modal dialog makes the rest of the page inert; a field there cannot take focus or a value.
    await contents.executeJavaScript('document.getElementById("modal").showModal()')
    await act('inertDate', 'fillInput', [ref('When'), '2026-05-06'], () => value('when'))
    await act('inertName', 'fillInput', [ref('Name'), 'Bea'], () => value('name'))
    await contents.executeJavaScript('document.getElementById("modal").close()')
    report.notes = notes
    report.throttlingAfter = contents.getBackgroundThrottling()
    report.ok = true
  } catch (error) {
    report.ok = false
    report.error = String(error && error.stack || error)
  } finally {
    try { session && session.detach() } catch {}
    writeFileSync(process.env.PROBE_REPORT, JSON.stringify(report, null, 2))
    app.exit(0)
  }
})
`

const BUNDLE_ENTRY = `
export { createBrowserPageDispatch } from '${new URL('browser-page-dispatch.ts', SRC_MAIN).pathname}'
export { BrowserCdpSession } from '${new URL('browser-cdp-session.ts', SRC_MAIN).pathname}'
export { beginOwnDispatch, isOwnDispatch } from '${new URL('browser-own-dispatch.ts', SRC_MAIN).pathname}'
`

async function buildBundle(outDirectory: string): Promise<void> {
  const { build } = await import('vite')
  const entryPath = join(outDirectory, 'entry.ts')
  await writeFile(entryPath, BUNDLE_ENTRY)
  await build({ logLevel: 'error', build: { outDir: outDirectory, emptyOutDir: false,
    lib: { entry: entryPath, formats: ['es'], fileName: () => 'dispatch.mjs' },
    rollupOptions: { external: ['electron', '@agentmux/core', /^node:/] } } })
}

type Action = { ok: boolean; error?: string; effects?: string; events: { type: string; target: string; trusted: boolean }[]; own: boolean[]; notes?: string[]; value?: unknown }
type Report = { ok?: boolean; error?: string; actions: Record<string, Action>; notes?: string[]; throttlingAfter?: boolean; framesBefore?: number }

const roots: string[] = []
afterAll(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

let report: Report | undefined
async function probe(): Promise<Report> {
  if (report) return report
  const root = await mkdtemp(join(tmpdir(), 'amux-trusted-input-e2e-'))
  roots.push(root)
  await symlink(new URL('../node_modules', import.meta.url).pathname, join(root, 'node_modules'), 'dir')
  await buildBundle(root)
  const pagePath = join(root, 'page.html'), reportPath = join(root, 'report.json')
  await writeFile(join(root, 'main.mjs'), PROBE_MAIN)
  await writeFile(pagePath, FIXTURE_PAGE)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'trusted-input-e2e', type: 'module', main: 'main.mjs' }))
  const env = { ...process.env, PROBE_REPORT: reportPath, PROBE_PAGE_URL: `file://${pagePath}`, PROBE_USER_DATA: join(root, 'userData'),
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(ELECTRON_BINARY, [root], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    // A loaded machine can take long to start Electron; the probe's own stderr says what it was doing.
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`trusted input probe timed out. Electron stderr:\n${stderr.slice(-2000)}`)) }, 180_000)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code) => { clearTimeout(timer); resolve(code) })
  })
  const raw = await readFile(reportPath, 'utf8').catch(() => null)
  // A missing report means the probe did not run, which is not the same as untrusted input.
  if (raw === null) throw new Error(`trusted input probe published no report (exit=${exitCode}). Electron stderr:\n${stderr.slice(-2000)}`)
  report = JSON.parse(raw) as Report
  return report
}

const trusted = (action: Action | undefined) => action?.events.every((event) => event.trusted) ?? false
const order = (action: Action | undefined) => action?.events.map((event) => `${event.type}:${event.target}`) ?? []

describe('real Electron: Agent page actions are trusted native input', () => {
  it('the probe ran the production dispatcher against a hidden page that Chromium had put to sleep', async () => {
    const result = await probe()
    expect(result.error ?? null).toBeNull()
    expect(result.ok).toBe(true)
    expect(result.framesBefore, 'the page was still rendering, so this run does not prove hidden-page delivery').toBe(0)
  }, 240_000)

  it('click is a trusted press, release and click on the target, all inside Main’s receipt', async () => {
    const click = (await probe()).actions.click
    expect(click?.ok, click?.error).toBe(true)
    expect(order(click)).toEqual(['pointerdown:go', 'mousedown:go', 'mouseup:go', 'click:go'])
    expect(trusted(click), JSON.stringify(click?.events)).toBe(true)
    expect(click!.own.length, 'Electron reported no input-event for the click').toBeGreaterThan(0)
    expect(click!.own.every(Boolean), 'an Agent input-event was outside Main’s receipt').toBe(true)
  }, 240_000)

  it('fill replaces and type appends through trusted beforeinput/input, and the value is what was typed', async () => {
    const { fill, type } = (await probe()).actions
    expect(fill?.ok, fill?.error).toBe(true)
    expect(fill!.value).toBe('Ada')
    expect(order(fill)).toEqual(expect.arrayContaining(['beforeinput:name', 'input:name']))
    expect(trusted(fill), JSON.stringify(fill?.events)).toBe(true)
    expect(type?.ok, type?.error).toBe(true)
    expect(type!.value).toBe('a@b.cx')
    expect(trusted(type), JSON.stringify(type?.events)).toBe(true)
    // Focus returned after fill, so the field's trusted change belongs to the fill itself.
    expect([...order(fill), ...order(type)], JSON.stringify({ fill: fill?.events, type: type?.events })).toContain('change:name')
    // Chromium does not report an inserted text as an Electron input-event, so most runs see none here.
    // Whatever it does report (the focus or caret step) must be inside Main's receipt, or the takeover
    // listener would read the Agent's typing as a person's.
    for (const [label, action] of [['fill', fill], ['type', type]] as const) {
      expect(action!.own.filter((own) => !own), `a ${label} input-event was outside Main’s receipt`).toEqual([])
    }
    // An email field has no selection API, so type moves the caret with a native End key Electron does report.
    expect(type!.own.length, 'Electron reported no input-event for the End key of type').toBeGreaterThan(0)
  }, 240_000)

  it('Enter is a trusted keydown/keyup that runs its default action and submits the form', async () => {
    const key = (await probe()).actions.key
    expect(key?.ok, key?.error).toBe(true)
    expect(order(key)).toEqual(expect.arrayContaining(['keydown:name', 'keyup:name', 'submit:form']))
    expect(trusted(key), JSON.stringify(key?.events)).toBe(true)
    expect(key!.own.length, 'Electron reported no input-event for the key').toBeGreaterThan(0)
    expect(key!.own.every(Boolean), 'a key input-event was outside Main’s receipt').toBe(true)
  }, 240_000)

  it('hover is a trusted pointer move that leaves the target under :hover, with no press', async () => {
    const hover = (await probe()).actions.hover
    expect(hover?.ok, hover?.error).toBe(true)
    expect(hover!.value).toBe(true)
    expect(order(hover)).toContain('mouseover:menu')
    expect(order(hover).filter((entry) => entry.startsWith('mousedown') || entry.startsWith('click'))).toEqual([])
    expect(trusted(hover)).toBe(true)
    expect(hover!.own.length, 'Electron reported no input-event for the hover').toBeGreaterThan(0)
    expect(hover!.own.every(Boolean), 'a hover input-event was outside Main’s receipt').toBe(true)
  }, 240_000)

  it('date, select and range take a value, not typed text, and fire input and change; a malformed date is refused unchanged', async () => {
    const { actions } = await probe()
    for (const [label, expected, id] of [['date', '2026-03-04', 'when'], ['select', 'b', 'fruit'], ['range', '7', 'level']] as const) {
      expect(actions[label], `${label}: ${actions[label]?.error}`).toMatchObject({ ok: true, value: expected })
      const kinds = actions[label]!.events.filter(event => event.target === id).map(event => event.type)
      expect(kinds, `${label} fired`).toEqual(expect.arrayContaining(['input', 'change']))
      expect(kinds, `${label} was typed into`).not.toContain('beforeinput')
    }
    expect(actions.dateRefused).toMatchObject({ ok: false, effects: 'not-dispatched', value: '2026-03-04' })
  }, 240_000)

  it('a picker refuses what Chromium would reset, names the options it cannot tell apart, and takes what a person could set', async () => {
    const { actions } = await probe()
    // Options valued 0, 1, 2 labelled 1, 2, 3: "2" is one option's label and another's value.
    expect(actions.numCrossed, actions.numCrossed?.error).toMatchObject({ ok: false, effects: 'not-dispatched', value: '0' })
    expect(actions.numCrossed!.error).toMatch(/more than one option matching "2": "2" \(value "1"\), "3" \(value "2"\)/)
    expect(actions.numByLabel, actions.numByLabel?.error).toMatchObject({ ok: true, value: '2' })
    // A disabled fieldset disables the date inside it, though its own .disabled stays false.
    expect(actions.offDate, actions.offDate?.error).toMatchObject({ ok: false, effects: 'not-dispatched', value: '' })
    expect(actions.offDate!.error).toContain('is disabled')
    expect(actions.offDate!.events).toEqual([])
    // Chromium resets "+3" on a range to its midpoint; it is refused and the earlier 7 stays.
    expect(actions.rangePlus, actions.rangePlus?.error).toMatchObject({ ok: false, effects: 'not-dispatched', value: '7' })
    // readonly does not apply to a range, and a person can still drag it.
    expect(actions.stuck, actions.stuck?.error).toMatchObject({ ok: true, value: '3' })
    // An upper-case color is the same color; it is taken without a note that would make the run indeterminate.
    expect(actions.tint, actions.tint?.error).toMatchObject({ ok: true, value: '#ff0000', notes: [] })
    expect(actions.agree, actions.agree?.error).toMatchObject({ ok: false, effects: 'not-dispatched', value: false })
    expect(actions.agree!.error).toContain('checkbox input, which takes a click')
  }, 240_000)

  it('fields in open and closed shadow roots and a focus-delegating host take input and give focus back; a field behind a modal or one that sends focus away is refused', async () => {
    const { actions } = await probe()
    expect(actions.shadowDate, actions.shadowDate?.error).toMatchObject({ ok: true, value: { value: '2026-03-04', focus: 'under' } })
    expect(actions.shadowName, actions.shadowName?.error).toMatchObject({ ok: true, value: { value: 'Ada', focus: 'under' } })
    // A closed shadow root cannot be walked into from document; its fields are judged from their own side.
    expect(actions.closedDate, actions.closedDate?.error).toMatchObject({ ok: true, value: { value: '2026-03-04', focus: 'under' } })
    expect(actions.closedName, actions.closedName?.error).toMatchObject({ ok: true, value: { value: 'Cy', focus: 'under' } })
    // The host keeps focus while its inner button has it, so the key reaches the switch.
    expect(actions.switchKey, actions.switchKey?.error).toMatchObject({ ok: true })
    expect(order(actions.switchKey)).toContain('keydown:sw')
    // The page sent focus to another field: refused before typing, and focus goes back to the person's field.
    expect(actions.bounce, actions.bounce?.error).toMatchObject({ ok: false, effects: 'not-dispatched', value: { bounce: '', elsewhere: '', focus: 'under' } })
    expect(actions.bounce!.error).toContain('the page moved focus elsewhere')
    for (const label of ['inertDate', 'inertName'] as const) {
      expect(actions[label], `${label}: ${actions[label]?.error}`).toMatchObject({ ok: false, effects: 'not-dispatched' })
      expect(actions[label]!.error).toContain('inert (behind a modal dialog)')
    }
    expect(actions.inertDate!.value, 'an inert date keeps its value').toBe('2026-03-04')
    expect(actions.inertName!.value, 'an inert text field keeps its value').toBe('Ada')
  }, 240_000)

  it('a covered target is refused before input and the page receives nothing; throttling is restored afterwards', async () => {
    const result = await probe()
    const covered = result.actions.covered
    expect(covered?.ok).toBe(false)
    expect(covered!.effects).toBe('not-dispatched')
    expect(covered!.events).toEqual([])
    expect(covered!.own).toEqual([])
    expect(result.throttlingAfter, 'background throttling was not restored after the actions').toBe(true)
  }, 240_000)
})
