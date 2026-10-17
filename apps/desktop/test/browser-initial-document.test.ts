import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEventListeners } from 'node:events'
const { fixtureFileUrl: _hygiene_fixtureFileUrl, fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import('../scripts/lib/fixture-values.mjs'))
// The actual Main manager owns navigation and dispatch. Electron/CDP transport is isolated;
// private product Native qualification supplies the real delayed document and public chain.
const native = vi.hoisted(() => {
  class Session {
    display: ((request: any, callback: (streams: any) => void) => void) | null = null
    setDisplayMediaRequestHandler = vi.fn((handler: ((request: any, callback: (streams: any) => void) => void) | null) => { this.display = handler })
    setPermissionCheckHandler = vi.fn()
    setPermissionRequestHandler = vi.fn()
    setDevicePermissionHandler = vi.fn()
    readonly listeners = new Map<string, Set<(...args: any[]) => void>>()
    on = vi.fn((event: string, fn: (...args: any[]) => void) => { const set=this.listeners.get(event)??new Set(); set.add(fn); this.listeners.set(event,set) })
    removeListener = vi.fn((event: string, fn: (...args: any[]) => void) => this.listeners.get(event)?.delete(fn))
    emit(event: string, ...args: any[]) { for (const fn of this.listeners.get(event)??[]) fn(...args) }
  }
  class Contents {
    static beforeLoad: ((contents: Contents, url: string) => Promise<void>) | undefined
    readonly session = new Session()
    url = _hygiene_fixtureFileUrl("app/renderer/index.html")
    dead = false
    readonly mainFrame = { url: this.url, detached: false, parent: null }
    readonly listeners = new Map<string, Set<(...args: any[]) => void>>()
    readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    send = vi.fn()
    focus = vi.fn()
    setWindowOpenHandler = vi.fn()
    zoom = 0.9
    getZoomFactor = () => this.zoom
    sendInputEvent = vi.fn((input: any) => { this.emit('input-event', {}, input) })
    setZoomFactor = vi.fn()
    disableDeviceEmulation = vi.fn()
    enableDeviceEmulation = vi.fn()
    getBackgroundThrottling = () => true
    setBackgroundThrottling = vi.fn()
    executeJavaScriptInIsolatedWorld = vi.fn(async (_worldId: number, _scripts: { code: string }[]) => ({width:768,height:1024,deviceScaleFactor:1}) as unknown)
    capturePage = vi.fn(async () => ({isEmpty:()=>false,getSize:()=>({width:1,height:1}),toPNG:()=>Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCq8AAAAASUVORK5CYII=','base64')}))
    getURL = () => this.url
    getTitle = () => 'Original Browser'
    isLoading = () => false
    isLoadingMainFrame = () => false
    isBeingCaptured = () => false
    isCurrentlyAudible = () => false
    isDestroyed = () => this.dead
    on(event: string, listener: (...args: any[]) => void) {
      const set = this.listeners.get(event) ?? new Set()
      set.add(listener); this.listeners.set(event, set); return this
    }
    once(event: string, listener: (...args: any[]) => void) {
      const wrapped = (...args: any[]) => { this.removeListener(event, wrapped); listener(...args) }
      return this.on(event, wrapped)
    }
    removeListener(event: string, listener: (...args: any[]) => void) { this.listeners.get(event)?.delete(listener) }
    emit(event: string, ...args: any[]) { for (const listener of this.listeners.get(event) ?? []) listener(...args) }
    readonly loads: string[] = []
    private loadSequence = 0
    private committedSequence = 0
    commitDocument(url: string) {
      this.committedSequence = this.loadSequence
      this.url = url; this.mainFrame.url = url
      this.emit('did-navigate', {}, url)
      this.emit('dom-ready')
    }
    async loadURL(url: string) {
      const sequence = ++this.loadSequence
      this.loads.push(url)
      this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url })
      await Contents.beforeLoad?.(this, url)
      if (this.committedSequence !== sequence) this.commitDocument(url)
      this.emit('did-finish-load'); this.emit('did-stop-loading')
    }
    reload() { void this.loadURL(this.url) }
    close = vi.fn((_options?: {waitForBeforeUnload?:boolean}) => { this.dead = true; this.emit('destroyed') })
  }
  class View {
    readonly webContents = new Contents()
    constructor() { this.webContents.url=''; this.webContents.mainFrame.url='' }
    visible = false
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    setVisible(value: boolean) { this.visible = value }
    getVisible() { return this.visible }
    setBounds(value: typeof this.bounds) { this.bounds = { ...value } }
    getBounds() { return this.bounds }
  }
  const shells: BaseWindow[] = []
  class BaseWindow {
    readonly views: View[] = []
    readonly contentView = {
      children: this.views,
      addChildView: (view: View) => { this.views.push(view) },
      removeChildView: (view: View) => { const index = this.views.indexOf(view); if (index !== -1) this.views.splice(index, 1) }
    }
    dead = false
    constructor(readonly options: Record<string, unknown>) { shells.push(this) }
    isDestroyed = () => this.dead
    destroy = vi.fn(() => { this.dead = true })
  }
  return { Session, Contents, View, BaseWindow, shells }
})
vi.mock('electron', () => ({ BaseWindow: native.BaseWindow, WebContentsView: native.View, app: { getPath: () => _hygiene_fixturePath("unused-private-ledger") } }))
import { BrowserViewManager } from '../src/main/browser-view-manager.js'
import { BrowserRefLedgerStore } from '../src/main/browser-ref-ledger-store.js'
import { BrowserCdpSession } from '../src/main/browser-cdp-session.js'
import { SCREENSHOT_VIEWPORT_SCRIPT } from '../src/main/browser-screenshot-source.js'
import { BrowserOperationJournal, BrowserOperationFileStore } from '../src/main/browser-operation-journal.js'
import { BrowserDemonstrationCapture } from '../src/main/browser-demonstration-capture.js'
import { BrowserDemonstrationRecorder } from '../src/main/browser-demonstration-recorder.js'
import { BrowserResultArtifactStore } from '../src/main/browser-result-artifact.js'
import * as scriptRunner from '../src/main/browser-script-runner.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

const managers: BrowserViewManager[] = [], roots: string[] = []
afterEach(() => { for(const m of managers.splice(0))m.dispose();for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});native.Contents.beforeLoad=undefined;vi.restoreAllMocks();vi.useRealTimers() })
function deferred() { let resolve!:()=>void, reject!:(error:Error)=>void;const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject} }
function fixture() {
  const directory=mkdtempSync(join(tmpdir(),'browser-initial-document-'));roots.push(directory)
  const contents=new native.Contents(),views:InstanceType<typeof native.View>[]=[]
  const attachments:{bounds:{x:number;y:number;width:number;height:number};visible:boolean}[]=[]
  const window={webContents:contents,isDestroyed:()=>false,getContentBounds:()=>({x:0,y:0,width:1200,height:800}),contentView:{children:views,addChildView:(v:InstanceType<typeof native.View>)=>{attachments.push({bounds:v.getBounds(),visible:v.getVisible()});views.push(v)},removeChildView:(v:InstanceType<typeof native.View>)=>{const n=views.indexOf(v);if(n!==-1)views.splice(n,1)}}}
  const journal=new BrowserOperationJournal(new BrowserOperationFileStore(join(directory,'journal.json')))
  const results=new BrowserResultArtifactStore(join(directory,'results'))
  const demonstrations={get:vi.fn(async()=>null),stop:vi.fn(async()=>null),getPersistenceWarning:()=>undefined} as unknown as BrowserDemonstrationRecorder
  const manager=new BrowserViewManager(window as never,{defaultProfileId:()=> 'original-profile',resolvePartition:id=>'persist:'+id},new BrowserRefLedgerStore(directory),{rememberedSchemes:async()=>({}),rememberScheme:async()=>{},openExternal(){}},journal,undefined,results,demonstrations)
  managers.push(manager)
  const sendCommand=vi.fn(async(method:string):Promise<unknown>=>method==='Runtime.evaluate'?{result:{value:{url:views[0]?.webContents.getURL(),body:'Original loaded document'}}}:{})
  const session={sendCommand,frames:new Map(),endedReason:null,detach:vi.fn(),observe:()=>()=>{}}
  vi.spyOn(BrowserCdpSession,'attach').mockReturnValue(session as never)
  const entry=()=>Reflect.get(manager,'entries').get('original-browser')
  return{manager,journal,views,sendCommand,session,entry,demonstrations,results,attachments}
}
const url='https://fixture.invalid/original'
async function started(f:ReturnType<typeof fixture>) { await vi.waitFor(()=>expect(f.entry().activity.operation?.steps.length).toBeGreaterThan(0)) }

describe('the original initial Browser document',()=>{
  it.each([
    { name: 'responsive', viewport: 'responsive' as const },
    { name: 'custom', viewport: { width: 820, height: 1180, screenPosition: 'mobile' as const } }
  ])('keeps $name emulation off a new native view until its original document is ready', async ({ viewport }) => {
    const f = fixture(), load = deferred()
    native.Contents.beforeLoad = () => load.promise
    const created = await f.manager.create('original-browser', url, 'workspace', undefined, 'normal', viewport)
    const contents = f.views[0]!.webContents
    const firstConsumer = f.manager.runScript('original-browser', 'return await js("document.body.innerText")')
    try {
      await started(f)
      expect(created.viewport).toEqual(viewport)
      expect(contents.disableDeviceEmulation).not.toHaveBeenCalled()
      expect(contents.enableDeviceEmulation).not.toHaveBeenCalled()
      expect(f.sendCommand).not.toHaveBeenCalled()
      contents.commitDocument(url)
      const report = await firstConsumer
      expect(report.outcome.kind).toBe('completed')
      expect(report.result).toMatchObject({ url })
      expect(contents.setZoomFactor).toHaveBeenCalledWith(0.9)
      if (viewport === 'responsive') {
        expect(contents.disableDeviceEmulation).toHaveBeenCalledOnce()
        expect(contents.enableDeviceEmulation).not.toHaveBeenCalled()
      } else {
        expect(contents.enableDeviceEmulation).toHaveBeenCalledWith(expect.objectContaining({
          screenPosition: 'mobile', viewSize: { width: viewport.width, height: viewport.height }
        }))
        expect(contents.disableDeviceEmulation).not.toHaveBeenCalled()
      }
      expect(f.entry().navigationId).toBe(created.navigationId)
      expect(f.entry().viewport).toEqual(viewport)
    } finally {
      load.resolve()
      await firstConsumer
    }
  })
  it('detaches every ended budget request from one still-pending native document',async()=>{
    vi.useFakeTimers();const f=fixture(),load=deferred();native.Contents.beforeLoad=()=>load.promise
    await f.manager.create('original-browser',url,'workspace');const document=f.entry().initialDocument
    for(let n=0;n<3;n++) {
      const pending=f.manager.captureScreenshot('original-browser').catch(error=>error)
      expect(getEventListeners(document.completion.signal,'abort')).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(30001);expect(await pending).toBeInstanceOf(Error)
      expect(getEventListeners(document.completion.signal,'abort')).toHaveLength(0)
      expect(getEventListeners(document.superseded.signal,'abort')).toHaveLength(0)
      expect(f.entry().initialDocument).toBe(document)
    }
    const healthy=f.manager.captureScreenshot('original-browser');load.resolve();await vi.advanceTimersByTimeAsync(0)
    expect((await healthy).source.url).toBe(url);expect(getEventListeners(document.completion.signal,'abort')).toHaveLength(0)
  })
  it('detaches stopped real runs while retaining one pending document for a later healthy consumer',async()=>{
    const f=fixture(),load=deferred();native.Contents.beforeLoad=()=>load.promise
    await f.manager.create('original-browser',url,'workspace');const document=f.entry().initialDocument
    for(let n=0;n<3;n++) {
      f.manager.returnControl('original-browser')
      const operation='stopped-observation-'+n,pending=f.manager.runScript('original-browser','return await js("document.body.innerText")',undefined,undefined,operation)
      await vi.waitFor(()=>expect(getEventListeners(document.completion.signal,'abort')).toHaveLength(1))
      await f.manager.stopOperationById(operation);expect((await pending).outcome.kind).toBe('stopped')
      expect(getEventListeners(document.completion.signal,'abort')).toHaveLength(0);expect(getEventListeners(document.superseded.signal,'abort')).toHaveLength(0)
    }
    const healthy=f.manager.captureScreenshot('original-browser');load.resolve();expect((await healthy).source.url).toBe(url)
    expect(getEventListeners(document.completion.signal,'abort')).toHaveLength(0)
  })
  it('does not treat an unobserved target navigation or an initial blank event as document readiness',async()=>{
    vi.useFakeTimers();const f=fixture()
    vi.spyOn(native.Contents.prototype,'loadURL').mockResolvedValue()
    await f.manager.create('original-browser',url,'workspace')
    const pending=f.manager.captureScreenshot('original-browser').catch(error=>error)
    f.views[0]!.webContents.emit('dom-ready');await vi.advanceTimersByTimeAsync(30001)
    const result=await pending;expect(result).toBeInstanceOf(Error);expect(result.message).toContain('budget');expect(f.views[0]!.webContents.capturePage).not.toHaveBeenCalled()
    expect(f.entry().error).toBeNull();expect(f.views[0]!.webContents.dead).toBe(false)
  })
  it('reads the committed top-level document while a normal image or iframe keeps full load pending',async()=>{
    for(const resource of ['image','iframe']) {
      const f=fixture(),held=deferred();native.Contents.beforeLoad=()=>held.promise
      await f.manager.create('original-browser',url,'workspace',undefined,undefined,'tablet')
      const pending=f.manager.runScript('original-browser','return await js("document.body.innerText")')
      await started(f);expect(f.sendCommand).not.toHaveBeenCalled()
      const contents=f.views[0]!.webContents
      try {
        contents.emit('dom-ready');await new Promise(resolve=>setTimeout(resolve,25));expect(f.sendCommand).not.toHaveBeenCalled()
        contents.commitDocument(url)
        await vi.waitFor(()=>expect(f.sendCommand).toHaveBeenCalledOnce(),{timeout:250,interval:10})
        const report=await pending
        expect(report.outcome.kind,resource).toBe('completed');expect(report.result).toMatchObject({url})
        expect(contents.setZoomFactor).toHaveBeenCalledWith(0.9);expect(contents.enableDeviceEmulation).toHaveBeenCalled()
        expect(f.entry().initialDocument).toBeNull()
      } finally { held.resolve();await pending }
    }
  })
  it('follows a native replacement document without letting the old load failure reject the healthy read',async()=>{
    const f=fixture(),old=deferred();native.Contents.beforeLoad=()=>old.promise
    await f.manager.create('original-browser',url,'workspace')
    const pending=f.manager.runScript('original-browser','return await js("document.body.innerText")');await started(f)
    const contents=f.views[0]!.webContents,replacement='https://fixture.invalid/native-replacement'
    contents.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false,url:replacement})
    contents.commitDocument(replacement);old.reject(new Error('Old navigation superseded'))
    const result=await pending;expect(result.outcome.kind).toBe('completed');expect(result.result).toMatchObject({url:replacement});expect(f.entry().error).toBeNull()
  })
  it('keeps a committed initial document ready through its own same-document navigation before resources finish',async()=>{
    const f=fixture(),held=deferred();native.Contents.beforeLoad=()=>held.promise
    await f.manager.create('original-browser',url,'workspace')
    const pending=f.manager.runScript('original-browser','return await js("document.body.innerText")');await started(f)
    const contents=f.views[0]!.webContents
    contents.url=url;contents.mainFrame.url=url;contents.emit('did-navigate',{},url)
    const changed=url+'#same-document';contents.url=changed;contents.mainFrame.url=changed
    contents.emit('did-start-navigation',{isMainFrame:true,isSameDocument:true,url:changed});contents.emit('did-navigate-in-page',{},changed,true);contents.emit('dom-ready')
    try { await vi.waitFor(()=>expect(f.sendCommand).toHaveBeenCalledOnce(),{timeout:250,interval:10});expect((await pending).result).toMatchObject({url:changed}) }
    finally { held.resolve();await pending }
  })
  it('does not let an unowned old native failure reject a replacement initial document',async()=>{
    const f=fixture(),old=deferred(),next=deferred();native.Contents.beforeLoad=(_c,u)=>u===url?old.promise:next.promise
    await f.manager.create('original-browser',url,'workspace')
    const capture=f.manager.captureScreenshot('original-browser').catch(error=>error),replacement='https://fixture.invalid/replacement'
    await f.manager.navigate('original-browser',replacement)
    f.views[0]!.webContents.emit('did-fail-load',{},-2,'Old request failed',url,true)
    f.views[0]!.webContents.commitDocument(replacement)
    expect((await capture).source?.url).toBe(replacement)
    next.resolve();old.reject(new Error('Old request failed'));await Promise.resolve()
    expect(f.entry().error).toBeNull()
  })
  it.each([
    {name:'responsive',viewport:'responsive' as const,width:1200,height:800},
    {name:'tablet',viewport:'tablet' as const,width:768,height:1024},
    {name:'custom',viewport:{width:640,height:480,screenPosition:'desktop' as const},width:640,height:480}
  ])('initializes the hidden $name drawing size before original attachment without changing capture or presentation geometry',async({viewport,width,height})=>{
    const f=fixture();await f.manager.create('original-browser',url,'workspace',undefined,'normal',viewport);await Promise.resolve();await Promise.resolve()
    const view=f.views[0]!,entry=f.entry(),originalParent=[...Reflect.get(f.manager,'window').contentView.children]
    expect(f.attachments).toEqual([{bounds:{x:0,y:0,width,height},visible:false}])
    expect(view.getBounds()).toEqual({x:0,y:0,width,height})
    await f.manager.captureScreenshot('original-browser')
    expect(view.getBounds()).toEqual({x:0,y:0,width,height})
    expect(view.getVisible()).toBe(false);expect(entry.bounds).toBeNull();expect(entry.inputLeaseId).toBeNull();expect(entry.visible).toBe(false)
    expect(Reflect.get(f.manager,'window').contentView.children).toEqual(originalParent)
    expect(view.webContents.capturePage).toHaveBeenCalledWith()
    view.setBounds({x:10,y:20,width:400,height:300})
    await f.manager.captureScreenshot('original-browser');expect(view.getBounds()).toEqual({x:10,y:20,width:400,height:300})
  })
  it('rechecks the original capture owner after viewport observation without changing either drawable',async()=>{
    const f=fixture();await f.manager.create('original-browser',url,'workspace');await Promise.resolve();await Promise.resolve()
    const original=f.views[0]!,replacement=new native.View(),bounds=original.getBounds()
    original.webContents.executeJavaScriptInIsolatedWorld.mockImplementation(async()=>{f.entry().view=replacement;return{width:768,height:1024,deviceScaleFactor:1}})
    await expect(f.manager.captureScreenshot('original-browser')).rejects.toThrow('Browser page changed')
    expect(original.getBounds()).toEqual(bounds);expect(replacement.getBounds()).toMatchObject({width:0,height:0})
    expect(original.webContents.capturePage).not.toHaveBeenCalled()
  })
  it('captures a public run through its original protocol session without a second Native capture',async()=>{
    const f=fixture(),png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCq8AAAAASUVORK5CYII='
    const created=await f.manager.create('original-browser',url,'workspace',undefined,'normal','tablet')
    f.sendCommand.mockImplementation(async method=>method==='Page.captureScreenshot'?{data:png}:{})
    const result=await f.manager.runScript('original-browser','return await captureScreenshot()')
    expect(result.outcome.kind).toBe('completed')
    expect(result.result).toMatchObject({browserId:'original-browser',navigationId:created.navigationId,source:{url},image:{mimeType:'image/png',width:1,height:1}})
    expect(BrowserCdpSession.attach).toHaveBeenCalledOnce()
    expect(f.sendCommand).toHaveBeenCalledExactlyOnceWith('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false})
    expect(f.views[0]!.webContents.capturePage).not.toHaveBeenCalled()
    expect(f.session.detach).toHaveBeenCalledOnce()
  })
  it('keeps the screenshot session bound to its original view while journal preparation awaits a Profile replacement',async()=>{
    const f=fixture(),held=deferred(),png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCq8AAAAASUVORK5CYII='
    await f.manager.create('original-browser',url,'workspace')
    const original=f.entry().view,start=f.journal.start.bind(f.journal);let preparing=false
    vi.spyOn(f.journal,'start').mockImplementation(async input=>{const op=await start(input);preparing=true;await held.promise;return op})
    f.sendCommand.mockImplementation(async method=>method==='Page.captureScreenshot'?{data:png}:{})
    const pending=f.manager.runScript('original-browser','return await captureScreenshot()')
    try {
      await vi.waitFor(()=>expect(preparing).toBe(true))
      await f.manager.switchProfile('original-browser','replacement-profile')
      const replacement=f.entry().view,nav=f.entry().navigationId
      expect(replacement).not.toBe(original);expect(BrowserCdpSession.attach).toHaveBeenCalledExactlyOnceWith(original.webContents)
      held.resolve();const result=await pending
      expect(result.outcome).toMatchObject({kind:'script-failed',message:expect.stringContaining('original Browser operation changed')})
      expect(result.result).toBeUndefined();expect(f.sendCommand).not.toHaveBeenCalled();expect(replacement.webContents.capturePage).not.toHaveBeenCalled()
      expect(f.entry().view).toBe(replacement);expect(f.entry().navigationId).toBe(nav);expect(replacement.webContents.dead).toBe(false)
      expect(f.session.detach).toHaveBeenCalledOnce()
    } finally {held.resolve();await pending}
  })
  it('refuses a protocol session belonging to a different view before reading either screenshot source',async()=>{
    const f=fixture();await f.manager.create('original-browser',url,'workspace')
    const foreign=new native.View()
    await expect(f.manager.captureScreenshot('original-browser',{view:foreign as never,sendCommand:f.sendCommand})).rejects.toThrow('Browser page changed')
    expect(f.sendCommand).not.toHaveBeenCalled();expect(f.views[0]!.webContents.executeJavaScriptInIsolatedWorld.mock.calls.filter(([,scripts])=>scripts.some(s=>s.code===SCREENSHOT_VIEWPORT_SCRIPT))).toHaveLength(0)
    expect(f.views[0]!.webContents.capturePage).not.toHaveBeenCalled();expect(foreign.webContents.capturePage).not.toHaveBeenCalled()
  })
  it.each(['owner','navigation'] as const)('rejects a protocol screenshot before sending when its original %s changes during viewport observation',async changed=>{
    const f=fixture();await f.manager.create('original-browser',url,'workspace')
    const original=f.entry().view as InstanceType<typeof native.View>,nav=f.entry().navigationId
    original.webContents.executeJavaScriptInIsolatedWorld.mockImplementation(async(_world,scripts)=>{
      if(scripts.some(s=>s.code===SCREENSHOT_VIEWPORT_SCRIPT)) {
        if(changed==='owner')f.entry().view=new native.View()
        else f.entry().navigationId='replacement-navigation'
      }
      return{width:768,height:1024,deviceScaleFactor:1}
    })
    try {
      const result=await f.manager.runScript('original-browser','return await captureScreenshot()')
      expect(result.outcome).toMatchObject({kind:'script-failed',message:expect.stringContaining('Browser page changed')})
      expect(result.result).toBeUndefined();expect(f.sendCommand).not.toHaveBeenCalled();expect(original.webContents.capturePage).not.toHaveBeenCalled()
      expect(original.webContents.dead).toBe(false);expect(f.session.detach).toHaveBeenCalledOnce()
    } finally {f.entry().view=original;f.entry().navigationId=nav}
  })
  it.each(['owner','navigation'] as const)('rejects a late protocol image after its original %s changes',async changed=>{
    const f=fixture(),png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCq8AAAAASUVORK5CYII='
    await f.manager.create('original-browser',url,'workspace')
    let resolve!:(value:unknown)=>void
    f.sendCommand.mockImplementation(async method=>method==='Page.captureScreenshot'?await new Promise(yes=>{resolve=yes}):{})
    const pending=f.manager.runScript('original-browser','return await captureScreenshot()'),original=f.entry().view as InstanceType<typeof native.View>,nav=f.entry().navigationId
    try {
      await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'))
      if(changed==='owner')f.entry().view=new native.View()
      else f.entry().navigationId='replacement-navigation'
      resolve({data:png})
      const result=await pending
      expect(result.outcome).toMatchObject({kind:'script-failed',message:expect.stringContaining('Browser page changed')})
      expect(result.result).toBeUndefined();expect(original.webContents.capturePage).not.toHaveBeenCalled()
      expect(original.webContents.executeJavaScriptInIsolatedWorld.mock.calls.filter(([,scripts])=>scripts.some(s=>s.code===SCREENSHOT_VIEWPORT_SCRIPT))).toHaveLength(1)
      expect(original.webContents.dead).toBe(false);expect(f.session.detach).toHaveBeenCalledOnce()
    } finally { f.entry().view=original;f.entry().navigationId=nav }
  })
  it('reports invalid protocol PNG bytes without falling back to another screenshot',async()=>{
    const f=fixture();await f.manager.create('original-browser',url,'workspace')
    f.sendCommand.mockImplementation(async method=>method==='Page.captureScreenshot'?{data:Buffer.from('invalid-image').toString('base64')}:{})
    const result=await f.manager.runScript('original-browser','return await captureScreenshot()')
    expect(result.outcome).toMatchObject({kind:'script-failed',message:expect.stringContaining('PNG')})
    expect(f.sendCommand).toHaveBeenCalledOnce();expect(f.views[0]!.webContents.capturePage).not.toHaveBeenCalled()
    expect(f.session.detach).toHaveBeenCalledOnce()
  })
  it('keeps creation immediate and lets the real run read the loaded document after its original native load',async()=>{
    const f=fixture(),load=deferred();native.Contents.beforeLoad=()=>load.promise
    await f.manager.create('original-browser',url,'workspace');expect(f.views).toHaveLength(1)
    const pending=f.manager.runScript('original-browser','return await js("document.body.innerText")',undefined,undefined,'original-operation')
    await started(f);expect(f.sendCommand).not.toHaveBeenCalled();expect((await f.manager.getOperation('original-operation'))?.phase).toBe('running')
    load.resolve();const result=await pending
    expect(result.outcome.kind).toBe('completed');expect(result.result).toEqual({url,body:'Original loaded document'});expect(f.sendCommand).toHaveBeenCalledOnce()
  })
  it('follows a replacement initial navigation even when the new promise settles before the old rejection',async()=>{
    const f=fixture(),old=deferred(),next=deferred();native.Contents.beforeLoad=(_c,u)=>u===url?old.promise:next.promise
    await f.manager.create('original-browser',url,'workspace')
    const shot=f.manager.captureScreenshot('original-browser');await Promise.resolve();expect(f.views[0]!.webContents.capturePage).not.toHaveBeenCalled()
    await f.manager.navigate('original-browser','https://fixture.invalid/replacement');next.resolve()
    const capture=await shot;expect(capture.source.url).toBe('https://fixture.invalid/replacement')
    old.reject(new Error('Old initial request aborted'));await Promise.resolve();await Promise.resolve()
    expect((await f.manager.ensure('original-browser',async()=>{throw Error('No cold read')})).error).toBeNull()
  })
  it('does not gate later ordinary live navigation after the initial document has finished',async()=>{
    const f=fixture();await f.manager.create('original-browser',url,'workspace');await Promise.resolve();await Promise.resolve()
    const later=deferred();native.Contents.beforeLoad=()=>later.promise;await f.manager.navigate('original-browser','https://fixture.invalid/later')
    const capture=await f.manager.captureScreenshot('original-browser');expect(capture.source.url).toBe(url);later.resolve()
  })
  it('keeps a pending operation queryable and stoppable without invoking a late document action',async()=>{
    const f=fixture(),load=deferred();native.Contents.beforeLoad=()=>load.promise;await f.manager.create('original-browser',url,'workspace')
    const pending=f.manager.runScript('original-browser','return await js("document.body.innerText")',undefined,undefined,'stop-original')
    await started(f);expect((await f.manager.getOperation('stop-original'))?.id).toBe('stop-original')
    await f.manager.stopOperationById('stop-original');const result=await pending;expect(result.outcome.kind).toBe('stopped')
    load.resolve();await Promise.resolve();expect(f.sendCommand).not.toHaveBeenCalled();expect(f.views[0]!.webContents.dead).toBe(false)
  })
  it('lets the original raw CDP and retained or pure waiting primitives through an initial load',async()=>{
    const f=fixture(),load=deferred();native.Contents.beforeLoad=()=>load.promise;await f.manager.create('original-browser',url,'workspace')
    const result=await f.manager.runScript('original-browser','await wait(0); return await cdp("Page.stopLoading")')
    expect(result.outcome.kind).toBe('completed');expect(f.sendCommand).toHaveBeenCalledExactlyOnceWith('Page.stopLoading',{})
    load.resolve()
  })
  it('does not let a failed first request permanently block raw CDP recovery or a healthy next observation',async()=>{
    const f=fixture(),load=deferred();native.Contents.beforeLoad=()=>load.promise;await f.manager.create('original-browser',url,'workspace')
    const pending=f.manager.captureScreenshot('original-browser');load.reject(new Error('Original navigation failed'));await expect(pending).rejects.toThrow('Original navigation failed')
    native.Contents.beforeLoad=undefined;f.sendCommand.mockImplementation(async method=>{if(method==='Page.navigate')await f.views[0]!.webContents.loadURL('https://fixture.invalid/recovered');return{}})
    expect((await f.manager.runScript('original-browser','return await cdp("Page.navigate", {url:"https://fixture.invalid/recovered"})')).outcome.kind).toBe('completed')
    expect((await f.manager.captureScreenshot('original-browser')).source.url).toBe('https://fixture.invalid/recovered')
  })
  it('cancels a waiting picker without starting it later, while initial native navigation alone preserves the request',async()=>{
    const f=fixture(),load=deferred();native.Contents.beforeLoad=()=>load.promise;await f.manager.create('original-browser',url,'workspace')
    f.views[0]!.webContents.executeJavaScriptInIsolatedWorld.mockResolvedValue(null)
    const pick=f.manager.selectElement('original-browser');await f.manager.cancelElementSelection('original-browser');const before=f.views[0]!.webContents.executeJavaScriptInIsolatedWorld.mock.calls.length
    load.resolve();expect(await pick).toBeNull();expect(f.views[0]!.webContents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(before)
  })
  it('reserves recording ownership before waiting so stop cannot be followed by a late recorder start',async()=>{
    const f=fixture(),load=deferred();native.Contents.beforeLoad=()=>load.promise;await f.manager.create('original-browser',url,'workspace')
    const start=vi.spyOn(BrowserDemonstrationCapture.prototype,'start').mockResolvedValue({id:'cancelled-recording',browserId:'original-browser',navigationId:'loaded-document',url,revision:1,status:'recording',startedAt:_historyFixtureEpoch(0, 0, 0),updatedAt:_historyFixtureEpoch(0, 0, 0),steps:[]}),pending=f.manager.startDemonstration('original-browser');const observed=pending.catch(error=>error)
    await f.manager.stopDemonstration('original-browser');load.resolve();expect((await observed).message).toContain('no longer owns');expect(start).not.toHaveBeenCalled()
  })
  it('does not dispatch a readonly observation after its worker already ended',async()=>{
    const f=fixture(),load=deferred();native.Contents.beforeLoad=()=>load.promise;await f.manager.create('original-browser',url,'workspace');let late:Promise<unknown>|undefined
    vi.spyOn(scriptRunner,'runBrowserScript').mockImplementation(async input=>{late=input.onPageCall!('pageInfo',[]).catch(error=>error);return{completed:false,failure:{kind:'timeout',timeoutMs:1},logs:[]}})
    const dispatch=f.manager.runScript('original-browser','return await pageInfo()');expect((await dispatch).outcome.kind).toBe('stopped');load.resolve();expect(await late).toBeInstanceOf(Error);expect(f.sendCommand).not.toHaveBeenCalled()
  })
  it('keeps readonly observation available after human control changes during the initial wait',async()=>{
    const f=fixture(),load=deferred();native.Contents.beforeLoad=()=>load.promise;await f.manager.create('original-browser',url,'workspace')
    const pending=f.manager.runScript('original-browser','return await pageInfo()');await started(f);f.entry().humanControl=true;load.resolve()
    const result=await pending;expect(result.outcome.kind).toBe('completed');expect(result.result).toMatchObject({url});expect(f.sendCommand).not.toHaveBeenCalled()
  })
  it('rechecks the original view and finite run deadline before any document dispatch',async()=>{
    for(const changed of ['view','deadline']){
      const f=fixture(),load=deferred();native.Contents.beforeLoad=()=>load.promise;await f.manager.create('original-browser',url,'workspace')
      let clock=1000;const now=vi.spyOn(performance,'now').mockImplementation(()=>clock)
      const pending=f.manager.runScript('original-browser','return await js("document.body.innerText")');await started(f)
      changed==='view'?f.entry().view=new native.View():clock=32000;load.resolve();const result=await pending
      expect(result.outcome.kind).toBe('script-failed');expect(f.sendCommand).not.toHaveBeenCalled();now.mockRestore()
    }
  })
  it('binds a real retained large result to the document identity present at artifact import',async()=>{
    const f=fixture(),load=deferred();native.Contents.beforeLoad=()=>load.promise;await f.manager.create('original-browser',url,'workspace')
    const originalNavigation=f.entry().navigationId,pending=f.manager.runScript('original-browser','await pageInfo();return "x".repeat(150000)')
    await started(f);f.views[0]!.webContents.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false,url});const actualNavigation=f.entry().navigationId
    expect(actualNavigation).not.toBe(originalNavigation);load.resolve();const report=await pending
    expect(report.outcome.kind).toBe('completed');expect(report.result).toMatchObject({kind:'browser-result-artifact',navigationId:actualNavigation,browserId:'original-browser'})
  })
  it('allows first native navigation to finish a pending picker without mistaking it for explicit cancel',async()=>{
    const f=fixture(),load=deferred();native.Contents.beforeLoad=()=>load.promise;await f.manager.create('original-browser',url,'workspace')
    f.views[0]!.webContents.executeJavaScriptInIsolatedWorld.mockResolvedValue(null)
    const pick=f.manager.selectElement('original-browser');f.views[0]!.webContents.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false,url})
    expect(typeof f.entry().selectionOperation).toBe('symbol');const before=f.views[0]!.webContents.executeJavaScriptInIsolatedWorld.mock.calls.length
    load.resolve();await pick;expect(f.views[0]!.webContents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(before+3)
  })
  it('starts the reserved recorder only after the initial document is ready',async()=>{
    const f=fixture(),load=deferred();native.Contents.beforeLoad=()=>load.promise;await f.manager.create('original-browser',url,'workspace')
    const start=vi.spyOn(BrowserDemonstrationCapture.prototype,'start').mockResolvedValue({id:'original-recording',browserId:'original-browser',navigationId:'loaded-document',url,revision:1,status:'recording',startedAt:_historyFixtureEpoch(0, 0, 0),updatedAt:_historyFixtureEpoch(0, 0, 0),steps:[]})
    const pending=f.manager.startDemonstration('original-browser');expect(start).not.toHaveBeenCalled();load.resolve()
    expect((await pending).draft?.id).toBe('original-recording');expect(start).toHaveBeenCalledOnce()
  })
  it('bounds only the standalone initial observation and keeps the loading page and its recovery controls',async()=>{
    vi.useFakeTimers();const f=fixture(),load=deferred();native.Contents.beforeLoad=()=>load.promise;await f.manager.create('original-browser',url,'workspace')
    const pending=f.manager.captureScreenshot('original-browser').catch(error=>error)
    await vi.advanceTimersByTimeAsync(30001);expect((await pending).message).toContain('budget');expect(f.entry().error).toBeNull();expect(f.views[0]!.webContents.dead).toBe(false);expect(f.views[0]!.webContents.capturePage).not.toHaveBeenCalled()
    load.resolve();await Promise.resolve();await Promise.resolve();expect((await f.manager.captureScreenshot('original-browser')).source.url).toBe(url)
  })
  it('registers a new field check only after initial load and uses the resulting navigation for its producer',async()=>{
    const f=fixture(),load=deferred();native.Contents.beforeLoad=()=>load.promise;await f.manager.create('original-browser',url,'workspace');let registered:any
    const register=vi.spyOn(f.journal,'registerOutcome').mockImplementation(async(_id,input)=>{registered=input;return{operation:{outcome:{registration:input}},saved:true} as never})
    const run=vi.spyOn(f.manager,'runScript').mockImplementation(async(_id,_code,_operator,_replay,_operation,onStarted)=>{await onStarted!({id:'field-check'} as never);return{runOperation:{id:'field-check'}} as never})
    vi.spyOn(f.manager as never,'evaluateOutcome' as never).mockResolvedValue({status:'unavailable'} as never)
    const pending=f.manager.checkOutcomeFields('original-browser',{request:{fields:[{key:'status',type:'string',source:{selector:'#status',read:'text'}}]},criteria:[{kind:'field-equals',key:'status',expected:'ready'}]})
    expect(register).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();f.views[0]!.webContents.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false,url});load.resolve();await pending
    expect(registered.context.navigationId).toBe(f.entry().navigationId);expect(registered.criteria[0].producer.navigationId).toBe(f.entry().navigationId)
  })
  it('locates a task navigation against the loaded URL rather than the transient empty document',async()=>{
    const f=fixture(),load=deferred();native.Contents.beforeLoad=()=>load.promise;await f.manager.create('original-browser',url,'workspace')
    const asset={id:'original-asset',browserId:'original-browser',draft:{steps:[{id:'navigate-step',kind:'navigate',url:'https://fixture.invalid/old'}]}}
    const edit=vi.fn(async(_id,_revision,content)=>({...asset,draft:content}));Reflect.set(f.manager,'taskAssets',{get:async()=>asset,edit})
    const pending=f.manager.locateTaskAssetStep('original-browser',asset.id,1,'navigate-step');await Promise.resolve();expect(edit).not.toHaveBeenCalled();load.resolve()
    const updated=await pending;expect(updated.draft.steps[0]?.url).toBe(url);expect(edit).toHaveBeenCalledOnce()
  })

  it('keeps standalone screenshot pixels pending until the original first document is ready',async()=>{
    const f=fixture(),load=deferred();native.Contents.beforeLoad=()=>load.promise;await f.manager.create('original-browser',url,'workspace')
    const pending=f.manager.captureScreenshot('original-browser');await Promise.resolve();await Promise.resolve()
    expect(f.views[0]!.webContents.capturePage).not.toHaveBeenCalled();load.resolve();expect((await pending).source.url).toBe(url);expect(f.views[0]!.webContents.capturePage).toHaveBeenCalledOnce()
  })

})


describe('safe native Browser release', () => {
  async function quiet() {
    const f=fixture(); await f.manager.create('original-browser',url,'workspace')
    await vi.waitFor(()=>expect(f.entry().resourceDocumentConfirmed).toBe(true))
    return {...f, contents:f.views[0]!.webContents, nav:()=>f.entry().navigationId}
  }
  it('commits only native destruction, then restores original identity and viewport',async()=>{
    const f=await quiet(); const nav=f.nav(), entry=f.entry()
    await f.manager.setViewport('original-browser','tablet')
    const closing=deferred();f.contents.close.mockImplementation(()=>{void closing.promise.then(()=>{f.contents.dead=true;f.contents.emit('destroyed')})})
    const pending=f.manager.release('original-browser',nav)
    expect(f.entry()).toBe(entry);expect(f.views).toHaveLength(1);expect(f.contents.dead).toBe(false)
    expect(Reflect.get(f.manager,'releasedEntries').size).toBe(0)
    closing.resolve();expect(await pending).toMatchObject({status:'released',navigationId:nav})
    expect(f.entry()).toBeUndefined();expect(f.contents.close).toHaveBeenCalledWith({waitForBeforeUnload:true})
    const restored=await f.manager.restore('original-browser',{workspaceId:'workspace'})
    expect(restored).toMatchObject({id:'original-browser',profileId:'original-profile',viewport:'tablet',url})
    expect(restored.navigationId).not.toBe(nav)
    expect(await f.manager.release('original-browser',nav)).toMatchObject({status:'retained',reasons:['source-changed']})
  })
  it.each(['visible','run','selection','profile','capture','debugger','media'] as const)('retains %s before touching any owner',async kind=>{
    const f=await quiet();const entry=f.entry(),cancel=vi.spyOn(f.manager as any,'cancelPendingSwitch'),revoke=vi.spyOn(f.manager as any,'revokePresentationCapture')
    if(kind==='visible')f.manager.setBounds('original-browser',{x:0,y:0,width:400,height:400})
    if(kind==='run')entry.runInFlight=true
    if(kind==='selection')entry.selectionOperation=Symbol('picker')
    if(kind==='profile')entry.pendingSwitch={token:entry.switchRevision}
    if(kind==='capture')f.contents.isBeingCaptured=()=>true
    if(kind==='debugger')Reflect.set(f.contents,'debugger',{isAttached:()=>true})
    if(kind==='media')f.contents.isCurrentlyAudible=()=>true
    const receipt=await f.manager.release('original-browser',f.nav())
    expect(receipt.status).toBe('retained');expect(f.contents.close).not.toHaveBeenCalled();expect(cancel).not.toHaveBeenCalled();expect(revoke).not.toHaveBeenCalled();expect(f.entry()).toBe(entry)
    // Restore fixture-only owner injections before normal owner disposal.
    entry.pendingSwitch=null;entry.selectionOperation=null;entry.runInFlight=false
  })
  it.each(['mouseDown','keyDown','touchStart'])('keeps native %s risk across same-document, failed and history navigation',async type=>{
    const f=await quiet();f.contents.emit('input-event',{}, {type})
    for(const same of [true,false]){f.contents.emit('did-start-navigation',{isMainFrame:true,isSameDocument:same,url});f.contents.emit('did-navigate',{},url)}
    expect(await f.manager.release('original-browser',f.nav())).toMatchObject({status:'retained',reasons:['document-used']})
    expect(f.contents.close).not.toHaveBeenCalled()
  })
  it.each(['media','download'])('uses native %s source and retains it after activity ends',async kind=>{
    const f=await quiet()
    if(kind==='media')f.contents.emit('media-started-playing')
    else f.contents.session.emit('will-download',{}, {},f.contents)
    expect(await f.manager.release('original-browser',f.nav())).toMatchObject({status:'retained',reasons:[kind]})
    expect(f.contents.close).not.toHaveBeenCalled()
  })
  it('preserves a vetoed owner and does not reissue an unknown native close',async()=>{
    vi.useFakeTimers();const f=await quiet(),nav=f.nav()
    f.contents.close.mockImplementation(()=>f.contents.emit('will-prevent-unload'))
    expect(await f.manager.release('original-browser',nav)).toMatchObject({status:'retained',reasons:['beforeunload']})
    expect(f.entry()).toBeDefined();expect(f.contents.dead).toBe(false)
    expect(await f.manager.release('original-browser',nav)).toMatchObject({status:'retained'})
    expect(f.contents.close).toHaveBeenCalledTimes(1)
  })
  it('keeps delayed or throwing close unknown with exact original source and late destruction authoritative',async()=>{
    vi.useFakeTimers();const f=await quiet(),nav=f.nav()
    f.contents.close.mockImplementation(()=>{})
    const first=f.manager.release('original-browser',nav)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await first).toMatchObject({status:'unknown',navigationId:nav})
    expect(await f.manager.release('original-browser',nav)).toMatchObject({status:'unknown'})
    expect(f.contents.close).toHaveBeenCalledTimes(1);expect(f.entry()).toBeDefined()
    f.contents.dead=true;f.contents.emit('destroyed');expect(f.entry()).toBeUndefined()
  })
  it('does not destroy a screenshot consumer before its actual read completes',async()=>{
    const f=await quiet(),read=deferred()
    f.contents.capturePage.mockImplementation(async()=>{await read.promise;return{isEmpty:()=>false,getSize:()=>({width:1,height:1}),toPNG:()=>Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCq8AAAAASUVORK5CYII=','base64')}})
    const pending=f.manager.captureScreenshot('original-browser')
    expect(await f.manager.release('original-browser',f.nav())).toMatchObject({status:'retained',reasons:['operation']})
    read.resolve();await pending
    expect(await f.manager.release('original-browser',f.nav())).toMatchObject({status:'released'})
  })
})

it('observes late native veto after a close reader expired, without a second close',async()=>{
  vi.useFakeTimers();const f=fixture();await f.manager.create('original-browser',url,'workspace');await vi.advanceTimersByTimeAsync(0)
  const contents=f.views[0]!.webContents,nav=f.entry().navigationId
  contents.close.mockImplementation(()=>{})
  const waiting=f.manager.release('original-browser',nav);await vi.advanceTimersByTimeAsync(1001)
  expect(await waiting).toMatchObject({status:'unknown'})
  await expect(f.manager.navigate('original-browser',url+'/later')).rejects.toThrow('closing')
  expect(contents.loads).toEqual([url])
  contents.emit('will-prevent-unload')
  expect(await f.manager.release('original-browser',nav)).toMatchObject({status:'retained',reasons:['beforeunload']})
  expect(await f.manager.navigate('original-browser',url+'/later')).toMatchObject({id:'original-browser'})
  expect(contents.close).toHaveBeenCalledTimes(1)
})
