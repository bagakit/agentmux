import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Private diagnostic: conditional debugger observations return false and never pause or schedule work. */
export async function observeOriginalStageDelivery(cdp, desktopRoot) {
  const assets = join(desktopRoot, 'out/renderer/assets')
  const candidates = []
  for (const file of await readdir(assets)) {
    if (!file.endsWith('.js')) continue
    const source = await readFile(join(assets, file), 'utf8')
    if (source.includes('function observeBrowserStageGeometry(stage, update, active)')) candidates.push({ file, source })
  }
  assert.equal(candidates.length, 1, 'Observe exactly one actual compiled stage owner')
  const { file, source } = candidates[0], lines = source.split('\n'), ids = []
  const anchors = [
    ['intersection', 'const ratio = entries[0].intersectionRatio;', 'entries[0].target', 'intersectionRatio:entries[0].intersectionRatio'],
    ['binding', 'const resize = new ResizeObserver(', 'stage', 'active'],
    ['update', 'cancelAnimationFrame(frame);', 'stage', 'frame,browserId:tab.browserId'],
    ['frame', 'const navigatorCoversBrowser = toolsOpen && window.innerWidth <= 900;', 'stage', 'browserId:tab.browserId'],
    ['synchronize', 'synchronizer.observe(rendererCssBoundsToWindowDip(bounds, api.ui.getZoomFactor()));', 'stage', 'browserId:tab.browserId,bounds'],
    ['cleanup', 'stopObserving();', 'stage', 'browserId:tab.browserId']
  ]
  // Narrow duplicate frame cancellation to the actual update function rather than its cleanup.
  const effectStart = source.indexOf('const synchronizer = new LatestBrowserBoundsSynchronizer(')
  const updateStart = source.indexOf('const update = () => {', effectStart)
  assert.ok(effectStart >= 0 && updateStart > effectStart)
  const updateEnd = source.indexOf('frame = requestAnimationFrame', updateStart)
  assert.ok(updateEnd > updateStart)
  const geometryStart=source.indexOf('function observeBrowserStageGeometry(stage, update, active)')
  const geometryEnd=source.indexOf('const VIEWPORT_LABELS',geometryStart)
  assert.ok(geometryStart>=0&&geometryEnd>geometryStart)
  await cdp.evaluate(`(()=>{
    const log=globalThis.__agentMuxPrivateStageDelivery={events:[],scrolls:[],omitted:0};
    log.scrollListener=event=>{if(log.scrolls.length>=128)return;const e=event.target;log.scrolls.push({time:performance.now(),tag:e.tagName??'document',classes:typeof e.className==='string'?e.className:'',scrollTop:e.scrollTop??document.scrollingElement.scrollTop,scrollLeft:e.scrollLeft??document.scrollingElement.scrollLeft})};
    document.addEventListener('scroll',log.scrollListener,true);return true;
  })()`)
  await cdp.call('Debugger.enable')
  for (const [label, anchor, target, facts] of anchors) {
    const positions = lines.flatMap((line, index) => line.includes(anchor) ? [index] : [])
      .filter(index => label !== 'update' || (lines.slice(0,index).join('\n').length >= updateStart && lines.slice(0,index).join('\n').length < updateEnd))
      .filter(index => label !== 'binding' || (lines.slice(0,index).join('\n').length >= geometryStart && lines.slice(0,index).join('\n').length < geometryEnd))
    assert.equal(positions.length, 1, `Nonempty unique actual stage anchor: ${label}`)
    const condition = `(()=>{try{const e=${target};if(e?.matches('[data-native-browser-stage]')){const log=globalThis.__agentMuxPrivateStageDelivery??={events:[],omitted:0};if(log.events.length<512){const r=e.getBoundingClientRect();log.events.push({stage:${JSON.stringify(label)},time:performance.now(),rect:{x:r.x,y:r.y,width:r.width,height:r.height},${facts}})}else log.omitted++}}catch{}return false})()`
    const result = await cdp.call('Debugger.setBreakpointByUrl', { url:pathToFileURL(join(assets,file)).href, lineNumber:positions[0], condition })
    ids.push(result.breakpointId)
  }
  return async () => {
    const result = await cdp.evaluate(`(()=>{const log=globalThis.__agentMuxPrivateStageDelivery;document.removeEventListener('scroll',log.scrollListener,true);return {installed:true,events:log.events,scrolls:log.scrolls,omitted:log.omitted,stages:Array.from(document.querySelectorAll('[data-native-browser-stage]')).map(stage=>{const parents=[];for(let e=stage;e&&parents.length<12;e=e.parentElement){const r=e.getBoundingClientRect(),s=getComputedStyle(e);parents.push({tag:e.tagName,classes:e.className,id:e.id,rect:{x:r.x,y:r.y,width:r.width,height:r.height},scrollTop:e.scrollTop,scrollLeft:e.scrollLeft,overflow:s.overflow,display:s.display,tabbarHeight:s.getPropertyValue('--pane-tabbar-height')})}return parents})}})()`)
    for (const breakpointId of ids) await cdp.call('Debugger.removeBreakpoint', {breakpointId})
    return result
  }
}
