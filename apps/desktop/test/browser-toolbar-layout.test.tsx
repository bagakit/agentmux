// @vitest-environment happy-dom
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import type { AppConfig, BrowserProfileSummary } from '../src/shared/contracts.js'

const fixture = vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  return { state: {
    applyBrowserEvent: vi.fn(), reportError: vi.fn(), setWorkspaceTool: vi.fn(),
    executeControl: vi.fn(async (_request: { operation: string; browserId?: string }) => ({ operation: 'browser.history', operations: [] })),
    saveBrowserBookmark: vi.fn(async () => 'Page.webloc'), openFile: vi.fn(async () => {}),
    browserAnnotationsByBrowserId: {}, addBrowserAnnotation: vi.fn(), toolsOpen: false,
    config: null as AppConfig | null
  } }
})
vi.mock('../src/renderer/src/store.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/renderer/src/store.js')>()
  const state = () => ({ ...actual.useAppStore.getInitialState(), ...fixture.state })
  return { ...actual, useAppStore: Object.assign((selector: (value: ReturnType<typeof state>) => unknown) => selector(state()),
    { ...actual.useAppStore, getState: state }) }
})
import { BrowserPane } from '../src/renderer/src/components/BrowserPane.js'
import { api } from '../src/renderer/src/lib/api.js'
import { browserProfiles } from '../src/renderer/src/lib/browser-profiles.js'

const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], executors: {}, workspaces: [],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: {
    selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true
  } }
}
const tab = {
  id: 'browser-1', navigationId: 'navigation-1', browserId: 'browser-1', regionId: 'region-1',
  workspaceId: 'workspace-1', profileId: 'profile-1', kind: 'browser' as const,
  url: 'https://example.com/', title: 'Example', loading: false, canGoBack: true, canGoForward: true,
  viewport: 'responsive' as const, driving: false, appLinkPrompt: null, error: null,
  retention: { status: 'eligible' as const, reasons: [] },
  control: { owner: 'human' as const, activeOperationId: null, revision: 1, inputIsolation: 'inactive' as const, agent: null }
}
const closeSplit = () => {}

beforeEach(() => {
  fixture.state.config = structuredClone(config)
  vi.clearAllMocks()
})

// Geometry uses the actual BrowserPane markup and complete product stylesheet in Chromium.
// The wrapper is the real Region/SessionRegionHost mounting boundary, including Close split.
it('keeps the page, trace and disjoint toolbar hit areas usable in actual Chromium at both zooms', async () => {
  const widths = [
    { width: 234.5, more: true }, { width: 234.5, more: false },
    { width: 234.5, more: true, active: true },
    { width: 260, more: true }, { width: 320, more: true, active: true }, { width: 321, more: true, active: true }, { width: 340, more: true },
    { width: 381, more: false, active: true }, { width: 400, more: true, active: true },
    { width: 414, more: false, active: true }, { width: 440, more: true, active: true },
    { width: 480, more: true, active: true }, { width: 520, more: true, active: true }, { width: 521, more: true, active: true },
    { width: 650, more: false, active: true }, { width: 710, more: true, active: true },
    { width: 760, more: true, active: true }, { width: 880, more: true, active: true },
    { width: 260, more: false }, { width: 880, more: false }
  ]
  const cases: { width: number; more: boolean; active: boolean; trace: boolean; withProfile?: boolean; markup: string }[] = []
  const activeTab = { ...tab, driving: true, source: { browserId: 'source', navigationId: 'source-navigation' },
    zoomFactor: 1.25, control: { owner: 'agent' as const, activeOperationId: 'operation-minimum-pane', revision: 2,
      inputIsolation: 'isolated' as const, agent: { hostId: 'local', agentSessionId: 'agent-1' } }, activity: { control: 'agent' as const, operation: {
    id: 'operation-minimum-pane', browserId: tab.browserId,
    operator: { id: 'agent-1', name: 'Long Browser Research Operator', providerId: 'codex' },
    startedAt: 1, phase: 'running' as const, summary: 'Inspect page', url: tab.url, steps: []
  } } }
  // Open the actual Renderer drawer through More, then consume the protocol's fresh, empty recording
  // projection. This is a geometry oracle; canonical trusted Record and native-page input remain separate.
  fixture.state.config = structuredClone(config)
  const traceHost = document.createElement('div')
  document.body.appendChild(traceHost)
  const traceRoot = createRoot(traceHost)
  let traceMarkup = ''
  try {
    for (const { width, more, active } of widths) {
      fixture.state.config = { ...config, browser: { toolbar: { ...config.browser.toolbar, more } } }
      const current = active ? { ...activeTab, zoomFactor: width <= 521 ? 0.5 : activeTab.zoomFactor } : tab
      await act(async () => traceRoot.render(<BrowserPane key={`${width}:${more}:${active}`} tab={current} visible onRegionClose={closeSplit} />))
      cases.push({ width, more, active: Boolean(active), trace: false, markup: traceHost.innerHTML })
    }
    const profile: BrowserProfileSummary = { id: tab.profileId, label: 'Research account for long-form technical reading',
      revision: 'profile-revision', createdAt: 1, isDefault: true, source: null }
    const list = vi.spyOn(api.browser, 'readProfiles').mockResolvedValue({ revision: 1, sequence: 1, folders: [], views: [],
      profiles: [profile, { ...profile, id: 'second-profile', label: 'Personal', isDefault: false }] })
    try {
      await act(async () => { await browserProfiles.refresh() })
      for (const width of [234.5, 414, 521, 621, 650]) {
        await act(async () => traceRoot.render(<BrowserPane key={`profile:${width}`} tab={{ ...activeTab, zoomFactor: 0.5 }} visible onRegionClose={closeSplit} />))
        expect(traceHost.querySelector('button.browser-profile-chip')?.getAttribute('aria-label')).toContain(profile.label)
        cases.push({ width, more: true, active: true, trace: false, withProfile: true, markup: traceHost.innerHTML })
      }
    } finally { list.mockRestore() }
    fixture.state.config = structuredClone(config)
    await act(async () => traceRoot.render(<BrowserPane tab={tab} visible onRegionClose={closeSplit} />))
    const menu = await openMore(traceHost)
    const demonstration = menu.querySelector('[aria-label="Open human demonstration draft"]')
    expect(demonstration).not.toBeNull()
    await act(async () => demonstration!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(traceHost.querySelector('[aria-label="Start recording demonstration"]')).not.toBeNull()
    const recordingTab = { ...tab, demonstration: { draft: {
      id: 'new-recording', browserId: tab.browserId, navigationId: tab.navigationId, url: tab.url,
      revision: 1, status: 'recording' as const, startedAt: 1, updatedAt: 1, steps: []
    } } }
    await act(async () => traceRoot.render(<BrowserPane tab={recordingTab} visible onRegionClose={closeSplit} />))
    expect(traceHost.querySelector('[aria-label="Stop recording demonstration"]')).not.toBeNull()
    expect(traceHost.querySelector('.browser-trace-rail')?.textContent).toContain('No demonstrated steps yet')
    traceMarkup = traceHost.innerHTML
  } finally { await act(async () => traceRoot.unmount()); traceHost.remove(); browserProfiles.reset() }
  cases.push(...[234.5, 340, 480, 760].map(width => ({ width, more: true, active: false, trace: true, markup: traceMarkup })))
  const directory = await mkdtemp(join(tmpdir(), 'amux-toolbar-layout-'))
  try {
    const unmountTheme = mountThemeRuntime(window, { ...config.appearance, appAppearance: 'dark' })
    try {
      const { dataset, style } = document.documentElement
      const sprite = document.querySelector('[data-semantic-icon-sprite]')?.outerHTML
      expect(sprite).toContain('agentmux-icon-action.close')
      await writeFile(join(directory, 'theme.json'), JSON.stringify({ theme: dataset.theme, appearance: dataset.appearance, style: style.cssText, sprite }))
    } finally { unmountTheme() }
    const stylesheet = resolve('apps/desktop/src/renderer/src/styles/index.css')
    const index = await readFile(stylesheet, 'utf8')
    const imports = [...index.matchAll(/@import '([^']+)';/g)]
    expect(imports.length).toBeGreaterThan(0)
    const browserIndex = imports.findIndex(match => match[1] === './browser.css')
    expect(browserIndex).toBeGreaterThanOrEqual(0)
    const styles = await Promise.all(imports.map((match, index) => readFile(
      (index === browserIndex && process.env.AGENTMUX_TOOLBAR_LAYOUT_CSS) ||
      (match[1]!.startsWith('.') ? join(dirname(stylesheet), match[1]!) : createRequire(import.meta.url).resolve(match[1]!)), 'utf8')))
    await writeFile(join(directory, 'cases.json'), JSON.stringify(cases))
    await writeFile(join(directory, 'page.html'), `<!doctype html><style>${styles.join('\n')}</style><div class="workbench-region" style="height:320px"><div class="session-region-host workbench-session-region-host"></div></div>`)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module', main: 'main.mjs' }))
    await writeFile(join(directory, 'main.mjs'), `
import { app, BrowserWindow } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
app.setPath('userData',process.env.TOOLBAR_ROOT+'/userdata')
app.whenReady().then(async()=>{
 const report={cases:[]};let window
 try {
  window=new BrowserWindow({width:1200,height:800,show:false,webPreferences:{sandbox:true}})
  await window.loadFile(join(process.env.TOOLBAR_ROOT,'page.html'))
  window.webContents.debugger.attach('1.3')
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
  const theme=await readFile(join(process.env.TOOLBAR_ROOT,'theme.json'),'utf8')
  await window.webContents.executeJavaScript('((theme)=>{const root=document.documentElement; root.dataset.theme=theme.theme;root.dataset.appearance=theme.appearance;root.style.cssText=theme.style;document.body.insertAdjacentHTML("afterbegin",theme.sprite)})('+theme+')')
  const cases=JSON.parse(await readFile(join(process.env.TOOLBAR_ROOT,'cases.json'),'utf8'))
  for(const zoom of [1,1.25]){
   window.webContents.setZoomFactor(zoom)
   for(const entry of cases){
    const layout=await window.webContents.executeJavaScript('('+(${JSON.stringify(`async function(entry){
      const region=document.querySelector('.workbench-region')
      region.style.width=entry.width+'px'
      region.querySelector('.workbench-session-region-host').innerHTML=entry.markup
      await document.fonts.ready
      await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))
      const rect=element=>{const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}
      const visible=element=>getComputedStyle(element).display!=='none'&&element.getBoundingClientRect().width>0
      const toolbar=region.querySelector('.browser-toolbar')
      const more=toolbar.querySelector('[aria-label="More browser tools"]')
      const close=toolbar.querySelector('.browser-toolbar__close')
      const rail=region.querySelector('.browser-trace-rail')
      const stop=rail?.querySelector('[aria-label="Stop recording demonstration"]')
      const closeTrace=rail?.querySelector('[aria-label="Close browser activity timeline"]')
      const hit=element=>{const r=element.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===element}
      const hitSamples=element=>{const r=element.getBoundingClientRect();return [
        [r.x+r.width/2,r.y+r.height/2],[r.x+1,r.y+r.height/2],[r.right-1,r.y+r.height/2],
        [r.x+r.width/2,r.y+1],[r.x+r.width/2,r.bottom-1]
      ].map(([x,y])=>document.elementFromPoint(x,y)?.closest('button')===element)}
      const origin=rail?.querySelector('.browser-rsi-replay__origin'),range=origin&&document.createRange();if(range)range.selectNodeContents(origin)
      const emptySteps=rail?.querySelector('.browser-demonstration__steps .browser-rsi-timeline__empty'),emptyRange=emptySteps&&document.createRange();if(emptyRange)emptyRange.selectNodeContents(emptySteps)
      const trace=rail?{bounds:rect(rail),steps:rail.querySelectorAll('[data-sequence]').length,emptySteps:{count:rail.querySelectorAll('.browser-demonstration__steps .browser-rsi-timeline__empty').length,text:emptySteps?.textContent,lines:emptyRange?.getClientRects().length},origin:{text:origin.textContent,lines:range.getClientRects().length},stop:{bounds:rect(stop),disabled:stop.disabled,hitSamples:hitSamples(stop),fontSize:getComputedStyle(stop).fontSize},closeBeforeScroll:rect(closeTrace),closeCount:rail.querySelectorAll('[aria-label="Close browser activity timeline"]').length}:null
      // The existing rail scroll keeps later actions reachable in a short pane. Record is checked
      // before scrolling; Close is checked after the user's normal scroll-to-action geometry.
      if(closeTrace){closeTrace.scrollIntoView({block:'nearest'});await new Promise(done=>requestAnimationFrame(done));const r=closeTrace.getBoundingClientRect();const rightHit=document.elementFromPoint(r.right-1,r.y+r.height/2);trace.close={bounds:rect(closeTrace),hitSamples:hitSamples(closeTrace),rightHit:{tag:rightHit?.tagName,ariaLabel:rightHit?.getAttribute('aria-label'),className:rightHit?.className},railClientWidth:rail.clientWidth,railScrollWidth:rail.scrollWidth,railScrollLeft:rail.scrollLeft}}
      const input=toolbar.querySelector('input'), address=rect(input), discussion=toolbar.querySelector('.browser-toolbar__discussion');
      const zoom=toolbar.querySelector('.browser-zoom')
      input.focus();
      const focusedAddress=rect(input), focusedClose=hit(close), focusedMore=visible(more)&&hit(more), focusedDiscussion=visible(discussion)&&hit(discussion), addressFocused=input.matches(':focus');
      input.blur();
      return {pane:rect(region),toolbar:rect(toolbar),stage:rect(region.querySelector('.browser-stage')),address,focusedAddress,focusedClose,focusedMore,focusedDiscussion,addressFocused,
       pageZoom:zoom&&visible(zoom)?{text:zoom.textContent,bounds:rect(zoom),ownHit:hit(zoom)}:null,
       overflow:toolbar.scrollWidth-toolbar.clientWidth,
       trace,
       secondary:[...toolbar.querySelectorAll('.browser-toolbar__secondary')].filter(visible).map(node=>node.getAttribute('aria-label')),
       navigation:[...toolbar.querySelectorAll('.browser-toolbar__navigation')].filter(visible).map(node=>node.getAttribute('aria-label')),
       externalVisible:visible(toolbar.querySelector('.browser-toolbar__external')),
       status:{phase:toolbar.querySelector('.browser-operation-status').dataset.phase,bounds:rect(toolbar.querySelector('.browser-operation-status__trigger'))},
       reloadVisible:visible(toolbar.querySelector('[aria-label="Reload"]')),
       more:{visible:visible(more),bounds:rect(more),ownHit:visible(more)&&hit(more),hitSamples:visible(more)?hitSamples(more):[]},
       close:{visible:visible(close),bounds:rect(close),ownHit:hit(close),hitSamples:hitSamples(close)},
       buttons:[...toolbar.querySelectorAll('button')].filter(node=>node!==close&&visible(node)).map(node=>({label:node.getAttribute('aria-label'),bounds:rect(node),ownHit:hit(node),hitSamples:hitSamples(node)}))}
     }`)} )+')('+JSON.stringify(entry)+')')
    if(entry.withProfile && entry.width===234.5) {
      await window.webContents.executeJavaScript('(() => {'+
        'const start=document.createElement("button");start.id="tab-sequence-start";'+
        'start.style.cssText="position:fixed;opacity:0";document.body.prepend(start);start.focus();})()')
      layout.tabSequence=[]
      for(let index=0;index<3;index++){
        const key={key:'Tab',code:'Tab',windowsVirtualKeyCode:9}
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',...key})
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',...key})
        layout.tabSequence.push(await window.webContents.executeJavaScript("document.activeElement.getAttribute('aria-label')"))
      }
      await window.webContents.executeJavaScript("document.activeElement.blur();document.getElementById('tab-sequence-start').remove()")
    }
    report.cases.push({...layout,width:entry.width,morePreference:entry.more,active:entry.active,hasTrace:entry.trace,withProfile:entry.withProfile??false,zoom})
    const capture = entry.withProfile ? [234.5,414].includes(entry.width) : [234.5,414,650,880].includes(entry.width)
    if(process.env.AGENTMUX_TOOLBAR_LAYOUT_SHOTS && entry.active && zoom===1 && capture) {
      const bounds = layout.pane
      const image = await window.webContents.capturePage({x:Math.floor(bounds.x),y:Math.floor(bounds.y),width:Math.ceil(bounds.width),height:Math.ceil(bounds.height)})
      if(image.isEmpty()) throw new Error('Empty Browser toolbar capture')
      await writeFile(join(process.env.AGENTMUX_TOOLBAR_LAYOUT_SHOTS,(entry.withProfile?'profile-':'active-')+entry.width+'.png'),image.toPNG())
    }
   }
  }
 }catch(error){report.error=error.stack||String(error)}
 finally{await writeFile(join(process.env.TOOLBAR_ROOT,'report.json'),JSON.stringify(report));window?.destroy();app.quit()}
})`)
    const env: NodeJS.ProcessEnv = { ...process.env, TOOLBAR_ROOT: directory, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron') as unknown as string, [directory], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4096) })
    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Toolbar layout deadline: ' + stderr)) }, 25_000)
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('close', code => { clearTimeout(timeout); resolve(code) })
    })
    expect(code, stderr).toBe(0)
    const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'))
    report.browserCssSha256 = createHash('sha256').update(styles[browserIndex]!).digest('hex')
    if (process.env.AGENTMUX_TOOLBAR_LAYOUT_PROOF) {
      await writeFile(resolve(process.env.AGENTMUX_TOOLBAR_LAYOUT_PROOF), `${JSON.stringify(report, null, 2)}\n`)
    }
    expect(report.error, JSON.stringify(report)).toBeUndefined()
    expect(report.cases).toHaveLength(cases.length * 2)
    for (const result of report.cases) {
      const context = JSON.stringify(result)
      if (result.width <= 320) {
        expect(result.toolbar.height, context).toBeGreaterThan(38)
        expect(result.toolbar.height, context).toBeLessThan(72)
        expect(result.address.y + result.address.height, context).toBeLessThan(result.more.bounds.y)
      } else expect(result.toolbar.height, context).toBe(38)
      expect(result.overflow, context).toBeLessThanOrEqual(0)
      expect(result.address.width, context).toBeGreaterThanOrEqual(result.width <= 320 ? 150 : result.width <= 380 ? 28 : 96)
      expect(result.addressFocused, context).toBe(true)
      expect(result.focusedAddress.width, context).toBeGreaterThanOrEqual(result.width < 380 ? 80 : 96)
      expect(result.focusedClose, context).toBe(true)
      expect(result.focusedDiscussion, context).toBe(true)
      if (result.width <= 820) expect(result.focusedMore, context).toBe(true)
      expect(result.stage.width, context).toBeGreaterThanOrEqual(result.pane.width / 2)
      expect(result.stage.height, context).toBeGreaterThan(0)
      if (result.hasTrace) {
        expect(result.trace, context).not.toBeNull()
        expect(result.trace.steps, context).toBe(0)
        expect(result.trace.emptySteps.count, context).toBe(1)
        expect(result.trace.emptySteps.text, context).toBe('No demonstrated steps yet')
        expect(result.trace.emptySteps.lines, context).toBeGreaterThan(0)
        expect(result.trace.emptySteps.lines, context).toBeLessThanOrEqual(2)
        if (result.width <= 380) {
          expect(result.trace.bounds.width, context).toBe(result.pane.width)
          expect(result.stage.width, context).toBe(result.pane.width)
          expect(result.trace.bounds.height, context).toBeLessThanOrEqual((result.pane.height - result.toolbar.height) * 0.44 + 1)
          expect(result.stage.height, context).toBeGreaterThanOrEqual((result.pane.height - result.toolbar.height) * 0.56 - 1)
          expect(result.stage.y + result.stage.height, context).toBeLessThanOrEqual(result.trace.bounds.y)
          expect(result.trace.origin.text, context).toBe('Recording human input · main document')
          expect(result.trace.origin.lines, context).toBeGreaterThan(0)
          expect(result.trace.origin.lines, context).toBeLessThanOrEqual(2)
        } else {
          expect(result.trace.bounds.width, context).toBeLessThanOrEqual(result.pane.width / 2)
          expect(result.stage.x + result.stage.width, context).toBeLessThanOrEqual(result.trace.bounds.x)
        }
        expect(result.trace.stop.disabled, context).toBe(false)
        expect(result.trace.stop.bounds.height, context).toBeGreaterThanOrEqual(25)
        expect(result.trace.stop.fontSize, context).toBe('10px')
        expect(result.trace.stop.hitSamples, context).toEqual([true, true, true, true, true])
        expect(result.trace.closeCount, context).toBe(1)
        expect(result.trace.close.bounds.width, context).toBeGreaterThanOrEqual(25)
        expect(result.trace.close.hitSamples, context).toEqual([true, true, true, true, true])
        expect(result.trace.close.railScrollLeft, context).toBe(0)
      }
      expect(result.close.visible, context).toBe(true)
      expect(result.close.ownHit, context).toBe(true)
      expect(result.close.hitSamples, context).toEqual([true, true, true, true, true])
      expect(result.status.phase, context).toBe(result.active ? 'running' : 'idle')
      if (result.active) {
        expect(result.pageZoom?.ownHit, context).toBe(true)
        expect(result.status.bounds.width, context).toBeGreaterThanOrEqual(27)
        expect(result.buttons.some(button => button.label === 'Take control of Browser' && button.ownHit), context).toBe(true)
      }
      if (result.withProfile && result.width === 234.5) {
        expect(result.tabSequence, context).toEqual([
          'Browser address', expect.stringMatching(/^Page zoom 50%/), expect.stringMatching(/^Profile: Research account/)
        ])
      }
      expect(result.more.visible, context).toBe(result.morePreference || result.width <= 820)
      if (result.more.visible) {
        expect(result.more.ownHit, context).toBe(true)
        expect(result.more.hitSamples, context).toEqual([true, true, true, true, true])
        expect(result.more.bounds.x + result.more.bounds.width, context).toBeLessThanOrEqual(result.close.bounds.x)
      }
      const tools = ['Select element', 'Screenshot', 'Open DevTools', 'Viewport', 'Save this page as a bookmark']
      expect(result.secondary, context).toEqual(result.width <= 720 ? [] : result.width <= 820 ? tools.slice(0, 2) : tools)
      expect(result.navigation, context).toEqual(result.width <= 520 ? [] : ['Back', 'Forward'])
      expect(result.externalVisible, context).toBe(result.width > 520)
      expect(result.reloadVisible, context).toBe(result.width > 380)
      expect(result.buttons.length, context).toBeGreaterThanOrEqual(3)
      const boxes = [...result.buttons.map(button => button.bounds), result.close.bounds]
      const disjoint = boxes.every((box, index) => boxes.slice(0, index).every(previous =>
        Math.min(box.x + box.width, previous.x + previous.width) - Math.max(box.x, previous.x) <= 0.125 ||
        Math.min(box.y + box.height, previous.y + previous.height) - Math.max(box.y, previous.y) <= 0.125))
      expect(disjoint, context).toBe(true)
      for (const button of result.buttons) {
        expect(button.ownHit, context).toBe(true)
        expect(button.hitSamples, context).toEqual([true, true, true, true, true])
        expect(button.bounds.x, context).toBeGreaterThanOrEqual(result.pane.x)
        expect(button.bounds.x + button.bounds.width, context).toBeLessThanOrEqual(result.pane.x + result.pane.width)
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 30_000)

async function openMore(container: HTMLElement): Promise<HTMLElement> {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="More browser tools"]')!
  expect(trigger).not.toBeNull()
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!
  expect(menu).not.toBeNull()
  return menu
}

it('overflow reaches navigation, bookmark, DevTools, viewport and demonstration through their product handlers', async () => {
  fixture.state.config!.browser.toolbar.more = false
  const back = vi.spyOn(api.browser, 'back').mockResolvedValue(tab)
  const devtools = vi.spyOn(api.browser, 'openDevTools').mockResolvedValue(undefined)
  const viewport = vi.spyOn(api.browser, 'setViewport').mockResolvedValue(tab)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<BrowserPane tab={tab} visible />))
    for (const [label, verify] of [
      ['Back', () => expect(back).toHaveBeenCalledWith(tab.browserId)],
      ['Open DevTools', () => expect(devtools).toHaveBeenCalledWith(tab.browserId)],
      ['Save this page as a bookmark', () => expect(fixture.state.saveBrowserBookmark).toHaveBeenCalledWith(tab.workspaceId, tab.url, tab.title)]
    ] as const) {
      const menu = await openMore(container)
      const item = menu.querySelector(`[role="menuitem"][aria-label="${label}"]`)
      expect(item).not.toBeNull()
      await act(async () => item!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      verify()
    }
    let menu = await openMore(container)
    const viewportMenu = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Viewport')
    expect(viewportMenu).toBeDefined()
    await act(async () => { viewportMenu!.focus(); viewportMenu!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    const mobile = [...document.querySelectorAll('.browser-viewport-menu [role="menuitemradio"]')].find(item => item.textContent?.includes('Mobile'))
    expect(mobile).not.toBeUndefined()
    await act(async () => mobile!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(viewport).toHaveBeenCalledWith(tab.browserId, 'mobile')
    menu = await openMore(container)
    const demonstration = menu.querySelector('[aria-label="Open human demonstration draft"]')
    expect(demonstration).not.toBeNull()
    await act(async () => demonstration!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(fixture.state.executeControl.mock.calls).toHaveLength(1)
    expect(fixture.state.executeControl.mock.calls[0]![0]).toMatchObject({ operation: 'browser.history', browserId: tab.browserId })
    expect(container.querySelector('[aria-label="Human demonstration draft"]')).not.toBeNull()
  } finally { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() }
})

it('keeps site zoom reset available in More when the inline zoom indicator is condensed', async () => {
  const resetZoom = vi.spyOn(api.browser, 'zoom').mockResolvedValue(tab)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<BrowserPane tab={{ ...tab, zoomFactor: 1.25 }} visible />))
    const menu = await openMore(container)
    const zoomAction = [...menu.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.includes('Reset page zoom'))
    expect(zoomAction?.textContent).toContain('125%')
    await act(async () => zoomAction!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(resetZoom).toHaveBeenCalledExactlyOnceWith(tab.browserId, 'reset')
  } finally { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() }
})

it('overflow preserves disabled page/navigation actions and configured tool exclusions', async () => {
  fixture.state.config!.browser.toolbar.screenshot = false
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<BrowserPane tab={{ ...tab, url: 'about:blank', canGoBack: false, canGoForward: false }} visible />))
    const menu = await openMore(container)
    const disabled = [...menu.querySelectorAll('[data-disabled]')].map(item => item.getAttribute('aria-label'))
    expect(disabled).toEqual(['Open in external browser', 'Back', 'Forward', 'Select element', 'Open DevTools', 'Save this page as a bookmark'])
    expect(menu.querySelector('[aria-label="Screenshot"]')).toBeNull()
  } finally { await act(async () => root.unmount()); container.remove() }
})
