import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Private diagnostic only: original compiled statements, false conditions, no pause or native action. */
export async function observeOriginalOverlayPaint(ctx) {
  const file = join(ctx.desktopRoot, 'out/main/index.js')
  const source = await readFile(file, 'utf8'), lines = source.split('\n')
  const start = source.indexOf('class NativeOverlaySurfaces {')
  const end = source.indexOf('\nclass ', start + 1)
  assert.ok(start >= 0 && end > start, 'Nonempty actual compiled native overlay owner')
  const owner = source.slice(start, end)
  assert.ok(owner.includes('async paint(projection)') && owner.includes('async update(input)'), 'Observe the actual paint/update owner')
  const offset = source.slice(0, start).split('\n').length - 1
  const anchors = [
    ['update-empty-check', 'if (!input.length) {', 'inputCount:input.length,updateGeneration:generation'],
    ['border-radius', 'projection.view.setBorderRadius(region2.radius);', 'updateGeneration:generation,radius:region2.radius'],
    ['reorder-child', 'this.window.contentView.addChildView(projection.view);', 'updateGeneration:generation,radius:region2.radius'],
    ['update-await-ready', 'await projection.ready;', 'updateGeneration:generation', 'async update(input)', 'async refresh()'],
    ['update-after-ready', 'await boundedChromePaint(this.paint(projection));', 'updateGeneration:generation'],
    ['update-catch', 'if (generation !== this.generation || !this.current(projection)) continue;', 'updateGeneration:generation,error: String(error).slice(0,180)'],
    ['paint-entry', 'const revision = ++projection.revision;', ''],
    ['paint-await-ready', 'await projection.ready;', 'paintRevision:revision', 'async paint(projection)', 'finishLoadedPaint(projection, revision) {'],
    ['paint-ready-guard', 'if (!this.current(projection) || revision !== projection.revision) return;', 'paintRevision:revision', 'async paint(projection)', 'const image = await this.window.webContents.capturePage'],
    ['original-capture', 'const image = await this.window.webContents.capturePage(projection.region.bounds);', 'paintRevision:revision'],
    ['original-capture-returned', 'if (image.isEmpty()) throw new Error("Empty native Chrome frame");', 'paintRevision:revision'],
    ['image-assignment', 'await projection.view.webContents.executeJavaScript(`new Promise', 'paintRevision:revision'],
    ['loaded-paint', 'finishLoadedPaint(projection, revision) {', 'paintRevision:revision'],
    ['remove', '    ++projection.revision;', '']
  ]
  const key = '__agentMuxPrivateOriginalOverlayPaint', ids = []
  await ctx.probe.main.evaluate(`globalThis[${JSON.stringify(key)}]={events:[],omitted:0,observationFailures:0,start:Date.now()};true`)
  await ctx.probe.main.evaluate(`(()=>{
    const {WebContentsView}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(ctx.desktopRoot,'package.json'))})('electron');
    let prototype=WebContentsView.prototype;
    while(prototype&&!Object.hasOwn(prototype,'setBorderRadius'))prototype=Object.getPrototypeOf(prototype);
    if(!prototype)throw new Error('Original native radius method is unavailable');
    const descriptor=Object.getOwnPropertyDescriptor(prototype,'setBorderRadius'),original=descriptor.value;
    if(typeof original!=='function')throw new Error('Original native radius method is not a value');
    const log=globalThis[${JSON.stringify(key)}],events=[];
    const record=(receiver,radius,outcome,error)=>{if(events.length<64)events.push({elapsedMs:Date.now()-log.start,contentsId:receiver.webContents?.id,radius,outcome,...(error?{error:String(error).slice(0,220)}:{})})};
    const wrapped=function(radius){try{const result=Reflect.apply(original,this,arguments);record(this,radius,'returned');return result}catch(error){record(this,radius,'threw',error);throw error}};
    Object.defineProperty(prototype,'setBorderRadius',{...descriptor,value:wrapped});
    log.restoreRadius=()=>{const stillOwned=Object.getOwnPropertyDescriptor(prototype,'setBorderRadius')?.value===wrapped;if(stillOwned)Object.defineProperty(prototype,'setBorderRadius',descriptor);return{events,restored:stillOwned,mechanism:'Passive original native method observation; same receiver, arguments, value and thrown error'}};
    return true;
  })()`)
  await ctx.probe.main.call('Debugger.enable')
  try {
    for (const [label, anchor, facts, from, until] of anchors) {
      const rangeStart = from ? owner.indexOf(from) : 0
      const rangeEnd = until ? owner.indexOf(until, rangeStart + 1) : owner.length
      assert.ok(rangeStart >= 0 && rangeEnd > rangeStart, `Nonempty actual owner range: ${label}`)
      const ownerLines = owner.split('\n')
      const matches = ownerLines.flatMap((line, index) => {
        const position = ownerLines.slice(0, index).join('\n').length
        return line.includes(anchor) && position >= rangeStart && position < rangeEnd ? [offset + index] : []
      })
      assert.equal(matches.length, 1, `Unique original compiled statement: ${label}`)
      const condition = `(()=>{const log=globalThis[${JSON.stringify(key)}];try{if(log.events.length>=256){log.omitted++;return false}const p=${label === 'update-empty-check' ? 'null' : 'projection'};log.events.push({stage:${JSON.stringify(label)},elapsedMs:Date.now()-log.start,windowId:this.window.id,originalContentsId:this.window.webContents.id,generation:this.generation,disposed:this.disposed,requestedCount:this.requested.length,projectionCount:this.projections.size,projection:p&&{id:p.region.id,contentsId:p.view.webContents.id,revision:p.revision,paintStage:p.paintStage,current:this.projections.get(p.region.id)===p,radius:p.region.radius,bounds:{...p.region.bounds}},${facts}})}catch{log.observationFailures++}return false})()`
      const result = await ctx.probe.main.call('Debugger.setBreakpointByUrl', { url:pathToFileURL(file).href, lineNumber:matches[0], condition })
      assert.ok(result.locations.length > 0, `Original compiled statement resolves: ${label}`)
      ids.push(result.breakpointId)
    }
  } catch (error) {
    for (const breakpointId of ids) await ctx.probe.main.call('Debugger.removeBreakpoint', {breakpointId})
    await ctx.probe.main.evaluate(`globalThis[${JSON.stringify(key)}].restoreRadius();delete globalThis[${JSON.stringify(key)}];true`)
    throw error
  }
  return async () => {
    for (const breakpointId of ids) await ctx.probe.main.call('Debugger.removeBreakpoint', {breakpointId})
    return await ctx.probe.main.evaluate(`(()=>{const key=${JSON.stringify(key)},log=globalThis[key],nativeRadius=log.restoreRadius();delete globalThis[key];return {installed:true,mechanism:'False conditional breakpoints on original compiled Main statements; no native action or added scheduling',events:log.events,omitted:log.omitted,observationFailures:log.observationFailures,nativeRadius}})()`)
  }
}
