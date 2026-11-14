import assert from 'node:assert/strict'
import type { BrowserWindow, WebContentsView } from 'electron'

/** Compare the original DOM destination with its actual native child, not visibility alone. */
export async function admissionGeometry(window: BrowserWindow, evaluate: (expression: string) => Promise<any>, page: any, url: string, observe?: (geometry: any) => void) {
  const ids = JSON.stringify({ regionId: page.region.regionId, browserId: page.region.browserId })
  const dom = await evaluate(`(()=>{
    const ids=${ids},visible=e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};
    const regions=[...document.querySelectorAll('[data-workbench-region-id]')].filter(e=>e.dataset.workbenchRegionId===ids.regionId&&visible(e));
    const region=regions[0],slot=region?.closest('.workbench-region-slot'),stage=document.querySelector('.global-survey-surface .survey-page-content');
    if(!region||!slot||!stage)return null;
    const native=region.querySelector('[data-native-browser-stage="'+ids.browserId+'"]'),toolbar=region.querySelector('.browser-toolbar'),surface=region.querySelector('.browser-surface');
    if(!native||!toolbar||!surface)return null;
    const preceding=(parent,child)=>[...parent.children].slice(0,[...parent.children].indexOf(child));
    const body=surface.querySelector('.browser-body'),presentation=native.closest('.browser-presentation');
    if(!body)return null;
    const serviceRows=[...preceding(surface,body).filter(e=>e!==toolbar),...(presentation?preceding(presentation,native):[])]
      .filter(e=>visible(e)&&e.getBoundingClientRect().height>0&&!['absolute','fixed'].includes(getComputedStyle(e).position))
      .map(e=>({className:e.className,role:e.getAttribute('role'),rect:rect(e),marginTop:parseFloat(getComputedStyle(e).marginTop)||0,marginBottom:parseFloat(getComputedStyle(e).marginBottom)||0,
        hasContent:Boolean(e.textContent?.trim()||e.querySelector('button,input,svg,[role="status"],[role="alert"]'))})).sort((a,b)=>a.rect.y-b.rect.y);
    return{visibleRegionCount:regions.length,stage:rect(stage),slot:rect(slot),region:rect(region),toolbar:rect(toolbar),nativeStage:rect(native),
      serviceRows,
      hosts:[...slot.children].map(e=>({className:e.className,visible:visible(e),rect:rect(e)}))};
  })()`)
  const nativeViews = window.contentView.children.filter((view: any) => view.webContents && !view.webContents.isDestroyed() && view.webContents.getURL() === url) as WebContentsView[]
  const native=nativeViews.map(view=>({contentsId:view.webContents.id,visible:view.getVisible(),bounds:view.getBounds()}))
  observe?.({ ...dom, nativeInstances:native })
  assert.ok(dom, 'The original Survey Region, destination slot, toolbar and native stage must exist')
  assert.equal(dom.visibleRegionCount, 1, 'Only one visible original Region presentation may consume the destination')
  for (const dimension of ['x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(dom.slot[dimension] - dom.stage[dimension]) <= 2, 'Exact Region destination fills the available Survey stage: ' + dimension)
    assert.ok(Math.abs(dom.region[dimension] - dom.slot[dimension]) <= 2, 'Exact Region presentation fills the original Survey stage: ' + dimension)
  }
  assert.equal(dom.hosts.filter((host: any) => host.visible).length, 1, 'One visible retained DOM host consumes the exact Region destination')
  assert.ok(Math.abs(dom.toolbar.y - dom.region.y) <= 2, 'The original toolbar starts at the top of its Region')
  let consumed=dom.toolbar.y+dom.toolbar.height
  for(const row of dom.serviceRows){
    assert.equal(row.hasContent,true,'Only actual visible Browser controls or service rows consume space above the native stage')
    assert.ok(Math.abs(row.rect.y-consumed-row.marginTop)<=2,'The original Browser service rows follow the toolbar without an unexplained gap')
    consumed=row.rect.y+row.rect.height+row.marginBottom
  }
  assert.ok(Math.abs(dom.nativeStage.y-consumed)<=2,'The native stage directly follows the original toolbar and actual visible service rows')
  assert.equal(nativeViews.length, 1, 'One exact original native Browser consumes this presentation')
  const view = nativeViews[0]!
  const bounds = view.getBounds()
  for (const dimension of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(bounds[dimension] - dom.nativeStage[dimension]) <= 2, 'Native bounds match the original rendered stage: ' + dimension)
  return { ...dom, native: { instances: nativeViews.length, contentsId: view.webContents.id, visible: view.getVisible(), bounds } }
}
