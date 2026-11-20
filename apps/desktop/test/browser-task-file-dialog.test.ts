// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { LocalExecutionHost, AgentMuxControlServer } from '@agentmux/core'
import { parseBrowserTarget } from '../../../packages/core/src/control-browser-targets'
import { installBrowserPageInterrupts } from '@agentmux/browser/page'
import { browserTaskImportInput } from '../../../packages/core/src/browser-task-control'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { objectCliReceipt } from '../../../packages/core/test/helpers/object-cli-receipt'
import { importTaskRecording } from './helpers/import-task-recording'

// Real Main/asset/file owners and compiled public CLI. Only Electron/CDP events are doubles;
// a separate native fixture must prove actual Chromium FileList/dialog/download behavior.
const native = vi.hoisted(() => ({ views: [] as any[] }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const { nativeInputDouble, isNativeScroll } = await import('./browser-native-input-double')
  class Contents extends EventEmitter {
    id = native.views.length + 1; url = ''; destroyed = false; attached = false
    chosen: { name: string; byteLength: number }[] = []; selectedBytes: Buffer[] = []
    answers: any[] = []; clicks: number[] = []; onRelease?: (target: number) => Promise<void>
    dialog: { type: string; url: string } | null = null
    loseUploadReply = false; loseAnswerReply = false
    readonly input = nativeInputDouble(id => Number(id) || 1)
    readonly session = Object.assign(new EventEmitter(), { setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, setDevicePermissionHandler() {} })
    readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    readonly mainFrame = { framesInSubtree: [] }
    readonly debugger = Object.assign(new EventEmitter(), {
      attach: () => { this.attached = true }, detach: () => { this.attached = false }, isAttached: () => this.attached,
      sendCommand: async (method: string, parameters: any = {}) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: 'loader' } } }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 17 }
        if (method === 'Accessibility.getFullAXTree') return { nodes: [{nodeId:'root',backendDOMNodeId:10,frameId:'frame',role:{value:'RootWebArea'},name:{value:'File task'},childIds:names.map((_,index)=>String(index+1))}, ...names.map((name, index) => ({ nodeId: String(index + 1), backendDOMNodeId: index + 1,
          frameId: 'frame', role: { value: index === 3 ? 'link' : 'button' }, name: { value: name }, childIds: [] }))] }
        if (method === 'Runtime.evaluate') return { result: { value: '[]' } }
        if (method === 'DOM.resolveNode') return { object: { objectId: String(parameters.backendNodeId) } }
        if (method === 'DOM.setFileInputFiles') {
          this.selectedBytes = await Promise.all(parameters.files.map((path: string) => readFile(path)))
          this.chosen = await Promise.all(parameters.files.map(async (path: string) => ({ name: basename(path), byteLength: (await stat(path)).size })))
          if (this.loseUploadReply) throw Error('private-prompt-sentinel')
          return {}
        }
        if (method === 'Page.handleJavaScriptDialog') {
          this.answers.push({ type: this.dialog?.type, ...parameters })
          this.dialog = null; this.debugger.emit('message', {}, 'Page.javascriptDialogClosed', {})
          if (this.loseAnswerReply) throw Error('private-prompt-sentinel')
          return {}
        }
        const answer = this.input.answer(method, parameters)
        if (method === 'Input.dispatchMouseEvent' && parameters.type === 'mouseReleased') {
          const target = this.input.presses.at(-1)!.target
          this.clicks.push(target); await this.onRelease?.(target)
        }
        if (answer !== undefined) return answer
        if (method === 'Runtime.callFunctionOn') {
          const declaration = parameters.functionDeclaration as string
          if (declaration.includes('this.files')) return { result: { value: this.chosen } }
          if (declaration.includes('HTMLInputElement')) return { result: { value: { multiple: true } } }
          if (isNativeScroll(parameters)) return { result: { value: undefined } }
        }
        return {}
      }
    })
    open(type: string, url = this.url) { this.dialog = { type, url }; this.debugger.emit('message', {}, 'Page.javascriptDialogOpening', { type, url, message: 'Page-authored request' }) }
    isDestroyed() { return this.destroyed } isLoading() { return false }
    getBackgroundThrottling() { return false } setBackgroundThrottling() {}
    getURL() { return this.url } getTitle() { return 'File task' } getZoomFactor() { return 1 }
    setZoomFactor() {} disableDeviceEmulation() {} enableDeviceEmulation() {} setWindowOpenHandler() {}
    async executeJavaScriptInIsolatedWorld() { return true }
    async loadURL(url: string) { this.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false }); this.url = url; this.emit('did-navigate', {}, url); this.emit('dom-ready'); this.emit('did-finish-load') }
    close() { this.destroyed = true; this.emit('destroyed') }
  }
  const names = ['Files', 'Confirm', 'Prompt', 'Download']
  class View { readonly webContents = new Contents(); constructor() { native.views.push(this) } setVisible() {} setBounds() {} }
  return { WebContentsView: View, app: { getPath: () => tmpdir() } }
})
import { BrowserViewManager } from '../src/main/browser-view-manager'
import { BrowserUploads } from '../src/main/browser-uploads'
import { BrowserDownloads } from '../src/main/browser-downloads'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { BrowserTaskAssetFileStore, BrowserTaskAssets } from '../src/main/browser-task-assets'
import { BrowserOperationFileStore, BrowserOperationJournal } from '@agentmux/browser/operations'
import { BrowserRefLedgerStore } from '@agentmux/browser/operations'
import { BrowserResultArtifactStore } from '@agentmux/browser/operations'
import { BrowserStepEvidenceStore } from '@agentmux/browser/operations'
import { executeBrowserTaskControl } from '../src/main/browser-task-control'
import { BrowserTaskAssetEditor } from '../src/renderer/src/components/BrowserTaskAssetEditor'
import type { BrowserTaskContent } from '../src/shared/browser-task-assets'
import { renameBrowserTaskParameter } from '../src/shared/browser-task-assets'
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
// These tests read actual Workspace bytes, through the same Host-owned native artifact as Desktop.
// A fresh worktree must prepare it rather than inherit an unrelated tree's generated executable.
beforeAll(() => {
  execFileSync(process.execPath, [resolve(import.meta.dirname, '../scripts/build-workspace-move-helper.mjs')], { timeout: 20_000 })
})
const url = 'https://files.invalid/form', browserId = 'browser-files', sentinel = 'private-prompt-sentinel'
const roots: string[] = [], managers: BrowserViewManager[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const manager of managers.splice(0)) manager.dispose(); native.views.length = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const target = (name: string) => ({ role: name === 'Download' ? 'link' : 'button', name, ordinal: 1, count: 1 })
function content(): BrowserTaskContent { return { name: 'Files and dialogs', url, parameters: [{ key: 'file', label: 'File', secret: true }, { key: 'answer', label: 'Answer', secret: true }], steps: [
  { id: 'upload', kind: 'upload', url, target: target('Files'), parameterKeys: ['file'], reviewed: true },
  { id: 'confirm', kind: 'click', url, target: target('Confirm'), dialog: { type: 'confirm', action: 'accept' }, reviewed: true },
  { id: 'prompt', kind: 'click', url, target: target('Prompt'), dialog: { type: 'prompt', action: 'accept', promptParameterKey: 'answer' }, reviewed: true },
  { id: 'download', kind: 'click', url, target: target('Download'), reviewed: true }
], completion: { criteria: [{ kind: 'download-readable', stepId: 'download', path: 'result.bin' }] } } }
class Download extends EventEmitter {
  path = ''; setSavePath(path: string) { this.path = path } getFilename() { return 'result.bin' } getMimeType() { return 'application/octet-stream' }
  getReceivedBytes() { return 5 } getTotalBytes() { return 5 } cancel() { this.emit('done', {}, 'cancelled') }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-file-task-')); roots.push(root)
  const workspace = { id: 'workspace', name: 'Files', hostId: 'local', path: join(root, 'workspace'), kind: 'folder' as const }
  await mkdir(workspace.path); await writeFile(join(workspace.path, 'source.bin'), Buffer.from([1, 3, 5]))
  const files = new WorkspaceFiles(() => new LocalExecutionHost()), resolveWorkspace = () => workspace
  const assets = new BrowserTaskAssets(new BrowserTaskAssetFileStore(join(root, 'assets.json')))
  const journal = new BrowserOperationJournal(new BrowserOperationFileStore(join(root, 'journal.json')))
  const uploads = new BrowserUploads(join(root, 'uploads'), files, resolveWorkspace), downloads = new BrowserDownloads(join(root, 'downloads'), files, resolveWorkspace)
  const children: any[] = [], window = { contentView: { children, addChildView: (view: any) => children.push(view), removeChildView: (view: any) => children.splice(children.indexOf(view), 1) }, isDestroyed: () => false, getContentBounds: () => ({x:0,y:0,width:800,height:600}), webContents: { isDestroyed: () => false, send() {} } }
  const manager = new BrowserViewManager(window as never, { defaultProfileId: () => 'default', resolvePartition: () => 'persist:private' }, new BrowserRefLedgerStore(join(root, 'refs.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} }, journal, new BrowserStepEvidenceStore(join(root, 'evidence')), new BrowserResultArtifactStore(join(root, 'results')), undefined, assets, downloads, uploads)
  managers.push(manager); await manager.create(browserId, url, workspace.id, undefined, undefined, 'responsive', { agent: { hostId: 'local', agentSessionId: 'fixture-agent' } }); await manager.create('neighbor', url + '/neighbor', workspace.id)
  const page = children[0].webContents, neighbor = children[1].webContents
  const originalDownloadListeners=page.session.listenerCount('will-download')
  page.onRelease = async (id: number) => {
    if (id === 2 || id === 3) page.open(id === 2 ? 'confirm' : 'prompt')
    if (id === 4) { expect(page.session.listenerCount('will-download')).toBe(originalDownloadListeners+1); const download = new Download(); page.session.emit('will-download', {}, download, page); await writeFile(download.path, Buffer.from([2, 4, 6, 8, 0])); download.emit('done', {}, 'completed') }
  }
  const imported = await importTaskRecording(assets, { id: 'original-recording', browserId, navigationId: 'recorded', url, revision: 1, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [
    { id: 'real-trigger', sequence: 1, recordedAt: 1, navigationId: 'recorded', source: 'native-human', method: 'click', url, args: [], target: target('Confirm') }
  ] })
  const createVersion = async (definition = content()) => { const old = await assets.get(imported.id); const edited = await manager.saveTaskAssetDraft(browserId, imported.id, old!.revision, definition); return manager.publishTaskAsset(browserId, imported.id, edited.revision) }
  return { root, workspace, assets, journal, uploads, downloads, manager, page, neighbor, imported, createVersion }
}
const params = { file: 'source.bin', answer: sentinel }
describe('saved task file and dialog composition through original owners', () => {
  it('compiled CLI edit/publish/run reaches the real Manager upload, same-operation answers and pre-registered readable download', async () => {
    const f = await fixture(); const before = await f.manager.target('neighbor')
    const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [], execute: request => executeBrowserTaskControl(request, f.manager, true) }); await server.start()
    const call = async (args: string[], input = '') => { const reply = await runCompiledObjectCli(['browser','task',...args], objectCliEnvironment(f.root), input); expect(reply.code, reply.stderr).toBe(0); return objectCliReceipt(JSON.parse(reply.stdout)).result as any }
    try {
      const edited = await call(['edit','--browser',browserId,'--asset',f.imported.id,'--expected-revision',String(f.imported.revision),'--input','-'], JSON.stringify({...content(),steps:content().steps.filter(step=>step.id!=='prompt')}))
      await call(['publish','--browser',browserId,'--asset',f.imported.id,'--expected-revision',String(edited.asset.revision)])
      await f.manager.returnControl(browserId)
      const { run } = await call(['run','--browser',browserId,'--asset',f.imported.id,'--version','1'], JSON.stringify(params))
      expect(run).toMatchObject({ status: 'completed', nextStep: 3 }); expect(run.operationIds).toHaveLength(3)
      expect(f.page.selectedBytes).toEqual([Buffer.from([1,3,5])]); expect(f.page.chosen).toEqual([{ name: 'source.bin', byteLength: 3 }])
      expect(f.page.answers).toEqual([{ type: 'confirm', accept: true }])
      expect(f.page.clicks).toEqual([2,4]); expect(f.neighbor.clicks).toEqual([])
      const downloads = await f.downloads.list({ workspaceId: f.workspace.id, browserId }); expect(downloads).toHaveLength(1); expect(downloads[0]!.status).toBe('completed')
      const bytes = await f.downloads.read(downloads[0]!.reference!, { workspaceId: f.workspace.id, browserId }); expect(Buffer.from(bytes.data,'base64')).toEqual(Buffer.from([2,4,6,8,0]))
      expect(await f.manager.target('neighbor')).toEqual(before)
      const disk = await readFile(join(f.root,'assets.json'),'utf8'), journal = await readFile(join(f.root,'journal.json'),'utf8')
      expect(disk).not.toContain(sentinel); expect(disk).not.toContain('source.bin'); expect(journal).not.toContain(sentinel); expect(journal).not.toContain('source.bin')
      const restored = new BrowserTaskAssets(new BrowserTaskAssetFileStore(join(f.root,'assets.json'))); expect((await restored.state(browserId)).runs).toMatchObject([{ id: run.id, status:'completed', nextStep:3 }])
    } finally { await server.stop() }
  }, 30_000)

  it('portable preserves the complete new definition and rebinds only step identities without copying review, values or runs', async () => {
    const f = await fixture(), asset = await f.createVersion(); const bundle = await f.assets.exportPortable(asset.id,asset.revision,1)
    expect(bundle.definition.steps).toMatchObject([{kind:'upload',parameterKeys:['file']},{dialog:{type:'confirm',action:'accept'}},{dialog:{promptParameterKey:'answer'}},{kind:'click'}])
    const input = browserTaskImportInput('neighbor',bundle); const imported = await f.assets.importPortable(input)
    expect(imported.draft.steps.every(step=>!step.reviewed)).toBe(true); expect(imported.draft.steps.map(step=>step.id)).not.toEqual(asset.draft.steps.map(step=>step.id))
    expect(imported.draft.parameters).toEqual(asset.draft.parameters); expect(imported.draft.completion?.criteria[0]).toMatchObject({stepId: imported.draft.steps[3]!.id})
    expect(JSON.stringify(imported)).not.toContain(sentinel); expect((await f.assets.state('neighbor')).runs).toEqual([])
    expect(renameBrowserTaskParameter(asset.draft.steps[0]!,'file','fresh').parameterKeys).toEqual(['fresh'])
    expect(renameBrowserTaskParameter(asset.draft.steps[2]!,'answer','fresh').dialog?.promptParameterKey).toBe('fresh')
    await expect(f.assets.edit(asset.id,asset.revision,{...content(),steps:[{...content().steps[1]!,dialog:{type:'beforeunload',action:'accept'}}]})).rejects.toThrow('Only the person')
    await expect(f.assets.edit(asset.id,asset.revision,{...content(),steps:[{...content().steps[0]!,parameterKeys:['missing']}]})).rejects.toThrow('parameter')
  })

  it('actual task editor preserves fresh upload/prompt bindings through parameter rename and the same Main save owner', async () => {
    const f=await fixture(), asset=await f.createVersion(), host=document.createElement('div');document.body.append(host)
    const renderer=createRoot(host);let saved: BrowserTaskContent|undefined, saving: Promise<void>|undefined
    await act(async()=>renderer.render(createElement(BrowserTaskAssetEditor,{asset,dialogTypes:f.manager.target(browserId)!.dialogTypes,recording:null,onImport:()=>{},onSaveDraft:draft=>{saving=f.manager.saveTaskAssetDraft(browserId,asset.id,asset.revision,draft).then(value=>{saved=value.draft});return saving},onSaveVersion:async()=>{},onLocateStep:()=>{},onRun:async()=>{},onStop:()=>{}})))
    try {
      expect(host.querySelector('[aria-label="Task step 1 file 1 parameter"]')).not.toBeNull()
      expect(host.querySelector('[aria-label="Task step 3 prompt parameter"]')).not.toBeNull()
      expect(host.textContent).toContain('Prompt dialogs are unavailable in this Browser host')
      const file=host.querySelector<HTMLSelectElement>('[aria-label="Task step 1 file 1 parameter"]')!
      await act(async()=>{file.value='answer';file.dispatchEvent(new Event('change',{bubbles:true}))})
      const key=host.querySelector<HTMLInputElement>('[aria-label="Parameter 2 key"]')!
      await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(key,'fresh');key.dispatchEvent(new Event('input',{bubbles:true}))})
      const save=Array.from(host.querySelectorAll('button')).find(button=>button.textContent?.trim()==='Save draft')!
      await act(async()=>save.click());expect(saving).toBeDefined();await act(async()=>saving)
      expect(saved?.steps[0]?.parameterKeys,host.textContent).toEqual(['fresh']);expect(saved?.steps[2]?.dialog?.promptParameterKey).toBe('fresh')
      expect((await f.assets.get(asset.id))?.versions).toEqual(asset.versions)
    } finally {await act(async()=>renderer.unmount());host.remove()}
  })

  it('actual compiled target discovery exposes host dialog types and public task run refuses unsupported prompt before a trigger',async()=>{
    const f=await fixture(),asset=await f.createVersion(),before=await f.assets.state(browserId)
    const server=new AgentMuxControlServer({socketPath:join(f.root,'control.sock'),coreClients:()=>[],execute:request=>request.operation==='browser.targets'?Promise.resolve({operation:'browser.targets',targets:f.manager.targets(),coverage:'complete'}):executeBrowserTaskControl(request,f.manager,true)});await server.start()
    try{
      const discovery=await runCompiledObjectCli(['browser','targets'],objectCliEnvironment(f.root));expect(discovery.code,discovery.stderr).toBe(0)
      const result=objectCliReceipt(JSON.parse(discovery.stdout)).result
      expect(result.targets.find((target:any)=>target.id===browserId).dialogTypes).toEqual(['alert','confirm','beforeunload'])
      const projected=f.manager.target(browserId)!;expect(parseBrowserTarget(projected).dialogTypes).toEqual(projected.dialogTypes)
      for(const types of [['prompt','prompt'],['invented'],[1],Array(5).fill('alert')])expect(()=>parseBrowserTarget({...projected,dialogTypes:types})).toThrow('dialog types')
      await f.manager.returnControl(browserId)
      const reply=await runCompiledObjectCli(['browser','task','run','--browser',browserId,'--asset',asset.id,'--version','1'],objectCliEnvironment(f.root),JSON.stringify(params))
      expect(reply.code).not.toBe(0);expect(JSON.parse(reply.stdout||reply.stderr).error.code).toBe('HOST_CAPABILITY_UNAVAILABLE')
      expect(f.page.clicks).toEqual([]);expect(f.page.selectedBytes).toEqual([]);expect(f.page.answers).toEqual([])
      expect((await f.assets.state(browserId)).runs).toEqual(before.runs);expect(f.manager.target('neighbor')?.status).toBe('ready')
    }finally{await server.stop()}
  })

  it('the original generic dialog owner answers a real protocol prompt fact with a fresh value without claiming Desktop support',async()=>{
    const observers=new Set<(method:string,params:any)=>void>(),commands:any[]=[],controller=new AbortController()
    const owner=installBrowserPageInterrupts({frames:new Map(),observe:(observe:any)=>{observers.add(observe);return()=>observers.delete(observe)},sendCommand:async(method:string,params:any)=>{commands.push({method,params});if(method==='Page.handleJavaScriptDialog')for(const observe of observers)observe('Page.javascriptDialogClosed',{});return{}}} as any,{signal:controller.signal})
    await owner.ready()
    try{
      const result=await owner.triggerAndAnswer(async()=>{for(const observe of observers)observe('Page.javascriptDialogOpening',{type:'prompt',url,message:'Page-authored'});return 'original click acknowledged'}, {type:'prompt',accept:true,promptText:sentinel},{beforeAnswer:()=>{},remainingMillis:()=>1000})
      expect(result.dialog).toEqual({type:'prompt',accepted:true});expect(commands.filter(row=>row.method==='Page.handleJavaScriptDialog')).toEqual([{method:'Page.handleJavaScriptDialog',params:{accept:true,promptText:sentinel}}])
    }finally{await owner.dispose()}
  })

  it.each(['upload','answer'] as const)('keeps a lost %s acknowledgement unknown without retry, values in durable facts or a changed neighbor', async lost => {
    const f=await fixture(), definition=content()
    definition.steps=[definition.steps[lost==='upload'?0:1]!];delete definition.completion
    const asset=await f.createVersion(definition)
    f.page.loseUploadReply=lost==='upload';f.page.loseAnswerReply=lost==='answer'
    const run=await f.manager.runTaskAsset({browserId,assetId:asset.id,version:1,parameters:params})
    expect(run.status).not.toBe('completed');expect(run.nextStep).toBe(0);expect(run.operationIds).toHaveLength(1)
    if(lost==='upload'){expect(f.page.selectedBytes).toEqual([Buffer.from([1,3,5])]);expect((await f.uploads.retained()).selectionCount).toBe(1)}
    else {expect(f.page.clicks).toEqual([2]);expect(f.page.answers).toEqual([{type:'confirm',accept:true}])}
    const restored=new BrowserTaskAssets(new BrowserTaskAssetFileStore(join(f.root,'assets.json')))
    expect((await restored.state(browserId)).runs).toMatchObject([{id:run.id,nextStep:0}])
    expect(f.neighbor.clicks).toEqual([])
    for(const file of ['assets.json','journal.json'])expect(await readFile(join(f.root,file),'utf8')).not.toContain(sentinel)
  })

  it.each(['missing.bin','../outside.bin'])('Workspace path %s sends no assignment and preserves the actual document and old version',async path=>{
    const f=await fixture(), definition=content();definition.steps=[definition.steps[0]!];delete definition.completion
    await writeFile(join(f.root,'outside.bin'),Buffer.from([9]))
    const asset=await f.createVersion(definition), run=await f.manager.runTaskAsset({browserId,assetId:asset.id,version:1,parameters:{file:path}})
    expect(run.status).not.toBe('completed');expect(f.page.selectedBytes).toEqual([]);expect(f.page.clicks).toEqual([])
    expect((await f.assets.get(asset.id))?.versions).toEqual(asset.versions);expect(f.page.url).toBe(url);expect(f.neighbor.url).toBe(url+'/neighbor')
  })

  it.each(['wrong-type','foreign-document','takeover'] as const)('refuses %s without answering, replaying or affecting the healthy neighbor',async cause=>{
    const f=await fixture(), definition=content();definition.steps=[definition.steps[1]!];definition.parameters=[];delete definition.completion
    const asset=await f.createVersion(definition)
    f.page.onRelease=async()=>{ if(cause==='takeover')f.manager.takeControl(browserId);f.page.open(cause==='wrong-type'?'prompt':'confirm',cause==='foreign-document'?url+'/other':url) }
    const run=await f.manager.runTaskAsset({browserId,assetId:asset.id,version:1,parameters:{}})
    expect(run.status).not.toBe('completed');expect(f.page.clicks).toEqual([2]);expect(f.page.answers.filter((a:any)=>a.accept)).toEqual([]);expect(f.neighbor.clicks).toEqual([])
  })
})
