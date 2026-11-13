import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * Real Electron: a page dialog during an Agent run fails the call in flight at once, can be answered,
 * and a dialog left open is dismissed so the page is usable again.
 *
 * The probe bundles the production dispatcher, CDP session, own-dispatch receipt and the dialog owner
 * from src and drives a page whose buttons open alert and confirm dialogs. Only Chromium decides
 * whether a page call hangs on an open dialog and whether Page.handleJavaScriptDialog closes it; a
 * fake transport cannot answer that. The page is visible: a hidden page sleeps and delays dialogs.
 */

const ELECTRON_BINARY: string = createRequire(import.meta.url)('electron') as unknown as string
const SRC_MAIN = new URL('../src/main/', import.meta.url)

const FIXTURE_PAGE = `<!doctype html><html><body style="margin:0">
  <button id="ask" style="position:absolute;left:40px;top:30px;width:160px;height:40px">Ask</button>
  <button id="warn" style="position:absolute;left:40px;top:100px;width:160px;height:40px">Warn</button>
  <output id="answer">none</output>
  <script>
    document.getElementById('ask').addEventListener('click', () => { document.getElementById('answer').textContent = String(confirm('Delete the draft?')) })
    document.getElementById('warn').addEventListener('click', () => { alert('Saved'); document.getElementById('answer').textContent = 'after-alert' })
  </script>
</body></html>`

const PROBE_MAIN = `
import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
const report = { steps: {} }
app.setPath('userData', process.env.PROBE_USER_DATA)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 600, height: 400, show: true })
  window.setIgnoreMouseEvents(true)
  let session = null
  try {
    const { createBrowserPageDispatch, BrowserCdpSession, beginOwnDispatch, ownDispatchMark, ownDispatchSince, installBrowserPageInterrupts } = await import('./dispatch.mjs')
    await window.webContents.loadURL(process.env.PROBE_PAGE_URL)
    const contents = window.webContents
    session = BrowserCdpSession.attach(contents)
    const control = new AbortController()
    const interrupts = installBrowserPageInterrupts(session, { signal: control.signal })
    await interrupts.ready()
    report.observing = interrupts.observing()
    const dispatch = createBrowserPageDispatch({
      session, interrupts,
      pageInfo: () => ({ url: contents.getURL(), title: contents.getTitle(), navigationId: 'nav-1' }),
      gotoUrl: async (url) => { await contents.loadURL(url) },
      captureScreenshot: async () => ({}), readLedger: async () => null, writeLedger: async () => {}, note: () => {},
      beginNativeInput: async () => beginOwnDispatch(contents)
    })
    // The run's page-call path, as BrowserViewManager wires it: refuse document calls while open, race the rest.
    const documentCalls = new Set(['snapshot', 'click', 'fillInput', 'pressKey', 'hover', 'pageInfo'])
    const call = async (name, args) => {
      if (documentCalls.has(name)) interrupts.assertNoDialog(name)
      const mark = ownDispatchMark(contents)
      const run = () => dispatch(name, args)
      return name === 'acceptDialog' || name === 'dismissDialog' ? await run() : await interrupts.race(run, () => ownDispatchSince(contents, mark))
    }
    const step = async (label, name, args) => {
      const started = Date.now()
      try { report.steps[label] = { ok: true, value: await call(name, args) } }
      catch (error) { report.steps[label] = { ok: false, error: String(error && error.message || error), fact: error && error.fact } }
      report.steps[label].ms = Date.now() - started
    }
    const page = await call('snapshot', [])
    const ref = (name) => page.nodes.find((node) => node.ref && node.name === name)?.ref
    const answer = () => contents.executeJavaScript('document.getElementById("answer").textContent')
    await step('askClick', 'click', [ref('Ask')])
    await step('snapshotWhileOpen', 'snapshot', [])
    await step('textForConfirm', 'acceptDialog', ['yes'])
    await step('accept', 'acceptDialog', [])
    report.afterAccept = await answer()
    await step('nothingOpen', 'dismissDialog', [])
    await step('warnClick', 'click', [ref('Warn')])
    // The program ends with the alert open: dispose dismisses it, and the page runs on.
    await interrupts.dispose()
    report.leftOpen = interrupts.leftOpenAtEnd()
    await new Promise((resolve) => setTimeout(resolve, 200))
    report.afterDispose = await answer()
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
export { beginOwnDispatch, ownDispatchMark, ownDispatchSince } from '${new URL('browser-own-dispatch.ts', SRC_MAIN).pathname}'
export { installBrowserPageInterrupts } from '${new URL('browser-page-interrupts.ts', SRC_MAIN).pathname}'
`

type Step = { ok: boolean; value?: unknown; error?: string; fact?: { kind: string; effects: string }; ms: number }
type Report = { ok?: boolean; error?: string; observing?: boolean; steps: Record<string, Step>; afterAccept?: string; afterDispose?: string;
  leftOpen?: { type: string; message: string } | null }

const roots: string[] = []
afterAll(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

let report: Report | undefined
async function probe(): Promise<Report> {
  if (report) return report
  const root = await mkdtemp(join(tmpdir(), 'amux-page-dialog-e2e-'))
  roots.push(root)
  await symlink(new URL('../node_modules', import.meta.url).pathname, join(root, 'node_modules'), 'dir')
  const { build } = await import('vite')
  await writeFile(join(root, 'entry.ts'), BUNDLE_ENTRY)
  await build({ logLevel: 'error', build: { outDir: root, emptyOutDir: false,
    lib: { entry: join(root, 'entry.ts'), formats: ['es'], fileName: () => 'dispatch.mjs' },
    rollupOptions: { external: ['electron', '@agentmux/core', /^node:/] } } })
  const pagePath = join(root, 'page.html'), reportPath = join(root, 'report.json')
  await writeFile(join(root, 'main.mjs'), PROBE_MAIN)
  await writeFile(pagePath, FIXTURE_PAGE)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'page-dialog-e2e', type: 'module', main: 'main.mjs' }))
  const env: NodeJS.ProcessEnv = { ...process.env, PROBE_REPORT: reportPath, PROBE_PAGE_URL: `file://${pagePath}`, PROBE_USER_DATA: join(root, 'userData'),
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(ELECTRON_BINARY, [root], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`page dialog probe timed out. Electron stderr:\n${stderr.slice(-2000)}`)) }, 180_000)
    child.once('error', reject)
    child.once('close', () => { clearTimeout(timer); resolve() })
  })
  const raw = await readFile(reportPath, 'utf8').catch(() => null)
  if (raw === null) throw new Error(`page dialog probe published no report. Electron stderr:\n${stderr.slice(-2000)}`)
  report = JSON.parse(raw) as Report
  return report
}

describe('real Electron: a page dialog during an Agent run', () => {
  it('the probe ran with Page notifications on', async () => {
    const result = await probe()
    expect(result.ok, result.error).toBe(true)
    expect(result.observing).toBe(true)
  }, 240_000)

  it('a click that opens a confirm fails at once, naming the dialog; its effect is unknown because the click was sent', async () => {
    const { steps } = await probe()
    expect(steps.askClick).toMatchObject({ ok: false, fact: { kind: 'page-dialog', effects: 'unknown' } })
    expect(steps.askClick!.error).toContain('confirm dialog: [page-authored text] Delete the draft?')
    expect(steps.askClick!.ms, 'the call must end on the dialog, not on a budget').toBeLessThan(3_000)
  }, 240_000)

  it('while it is open a snapshot is refused unsent, prompt text is refused for a confirm, and accepting answers the page', async () => {
    const result = await probe()
    expect(result.steps.snapshotWhileOpen).toMatchObject({ ok: false, fact: { kind: 'page-dialog', effects: 'not-dispatched' } })
    expect(result.steps.snapshotWhileOpen!.ms).toBeLessThan(500)
    expect(result.steps.textForConfirm).toMatchObject({ ok: false, fact: { kind: 'page-dialog', effects: 'not-dispatched' } })
    expect(result.steps.accept).toMatchObject({ ok: true, value: { type: 'confirm', accepted: true } })
    expect(result.afterAccept, 'the page saw OK').toBe('true')
    expect(result.steps.nothingOpen).toMatchObject({ ok: false, fact: { kind: 'page-dialog', effects: 'not-dispatched' } })
  }, 240_000)

  it('an alert left open when the program ends is dismissed, and the page runs on', async () => {
    const result = await probe()
    expect(result.steps.warnClick).toMatchObject({ ok: false, fact: { kind: 'page-dialog' } })
    expect(result.leftOpen).toMatchObject({ type: 'alert', message: 'Saved' })
    expect(result.afterDispose, 'the page continued past its alert').toBe('after-alert')
  }, 240_000)
})
