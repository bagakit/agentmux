// @vitest-environment happy-dom
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {expect,it,vi} from 'vitest'
import {applyWorkbenchRegionLayoutPreset,createWorkbenchViewLayout,splitWorkbenchRegion,workbenchRegionBounds,workbenchRegionPresetSize} from '../../../packages/core/src/spatial-layout/workbench-view-layout'
import {workbenchRegionPresetIcon,workbenchSplitDirectionIcon} from '../src/renderer/src/components/workbench-split-menu-icons'
import {mountThemeRuntime} from '../../../packages/client-ui/src/theme/runtime'
import {createSemanticIconElement,getSemanticIconCatalog,semanticIconHref,type SemanticIconId} from '@agentmux/client-ui/icons'
import {executeSettingsThemesControl} from '../src/main/settings-themes-control'
import type {ConfigOwner} from '../src/main/config-owner'

globalThis.IS_REACT_ACT_ENVIRONMENT=true
async function withOriginalIcon(Icon:ReturnType<typeof workbenchRegionPresetIcon>,check:(icon:SVGSVGElement,target:Element)=>void){
 vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}))
 const release=mountThemeRuntime(window,{appAppearance:'light'}),host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{
  await act(async()=>root.render(<Icon size={16}/>))
  const icon=host.querySelector('svg')!
  expect(icon.getAttribute('width')).toBe('16');expect(icon.getAttribute('height')).toBe('16')
  expect(icon.getAttribute('stroke')).toBe('currentColor')
  expect(host.querySelector('.semantic-icon-motion')).toBeNull()
  const target=document.getElementById(icon.querySelector('use')!.getAttribute('href')!.slice(1))!
  expect(target.children.length).toBeGreaterThan(0)
  const native=createSemanticIconElement(icon.dataset.semanticIcon as SemanticIconId,document,{size:16});host.append(native)
  expect(native.querySelector('use')!.getAttribute('href')).toBe(icon.querySelector('use')!.getAttribute('href'))
  expect(native.getAttribute('width')).toBe('16');expect(native.getAttribute('stroke')).toBe('currentColor')
  check(icon,target)
 }finally{await act(async()=>root.unmount());release();host.remove();vi.unstubAllGlobals()}
}
function rectBounds(rect:Element){
 const bounds=Object.fromEntries(['x','y','width','height'].map(key=>[key,Number(rect.getAttribute(key))])) as {x:number;y:number;width:number;height:number}
 expect(bounds.width).toBeGreaterThan(0);expect(bounds.height).toBeGreaterThan(0)
 return bounds
}
function samePositions(actual:number[],expected:number[]){
 const positions=[...new Set(actual)].sort((a,b)=>a-b),wanted=[...new Set(expected)].sort((a,b)=>a-b)
 expect(positions).toHaveLength(wanted.length)
 positions.forEach((position,index)=>expect(position).toBeCloseTo(wanted[index]!,4))
}
it.each(['columns-3','grid-4','grid-6','grid-9'] as const)('shows the actual %s cell arrangement through its original product icon factory',async preset=>{
 await withOriginalIcon(workbenchRegionPresetIcon(preset),(icon,target)=>{
  expect(icon.dataset.semanticIcon).toBe(`layout.${preset}`)
  expect(icon.querySelector('use')!.getAttribute('href')).toBe(semanticIconHref(`layout.${preset}`))
  const rects=[...target.querySelectorAll('rect')];expect(rects).toHaveLength(1)
  const frame=rectBounds(rects[0]!),xs=[0],ys=[0]
  for(const line of target.querySelectorAll('line')){
   const x1=Number(line.getAttribute('x1')),x2=Number(line.getAttribute('x2')),y1=Number(line.getAttribute('y1')),y2=Number(line.getAttribute('y2'))
   if(x1===x2){
    expect(Math.min(y1,y2)).toBeCloseTo(frame.y);expect(Math.max(y1,y2)).toBeCloseTo(frame.y+frame.height)
    expect(x1).toBeGreaterThan(frame.x);expect(x1).toBeLessThan(frame.x+frame.width)
    xs.push((x1-frame.x)/frame.width)
   }else{
    expect(y1).toBe(y2)
    expect(Math.min(x1,x2)).toBeCloseTo(frame.x);expect(Math.max(x1,x2)).toBeCloseTo(frame.x+frame.width)
    expect(y1).toBeGreaterThan(frame.y);expect(y1).toBeLessThan(frame.y+frame.height)
    ys.push((y1-frame.y)/frame.height)
   }
  }
  const added=Array.from({length:workbenchRegionPresetSize(preset)-1},(_,index)=>`added-${index}`)
  const actual=workbenchRegionBounds(applyWorkbenchRegionLayoutPreset(createWorkbenchViewLayout('original'),preset,added).root)
  expect(xs.length*ys.length).toBe(actual.length)
  samePositions(xs,actual.map(region=>region.bounds.x));samePositions(ys,actual.map(region=>region.bounds.y))
 })
})
it('marks the real newly split Region side in four distinct static menu drawings',async()=>{
 const drawings=new Set<string>()
 for(const direction of ['left','right','up','down'] as const){
  await withOriginalIcon(workbenchSplitDirectionIcon(direction),(icon,target)=>{
   expect(icon.dataset.semanticIcon).toBe(`layout.split-${direction}`)
   expect(icon.querySelector('use')!.getAttribute('href')).toBe(semanticIconHref(`layout.split-${direction}`))
   drawings.add(target.innerHTML)
   const rects=[...target.querySelectorAll('rect')];expect(rects).toHaveLength(2)
   const highlight=rects.find(rect=>rect.getAttribute('fill')==='currentColor'&&rect.getAttribute('stroke')==='none')!
   expect(highlight).toBeDefined()
   const frame=rectBounds(rects.find(rect=>rect!==highlight)!),area=rectBounds(highlight)
   const actual=workbenchRegionBounds(splitWorkbenchRegion(createWorkbenchViewLayout('original'),'original',direction,'new-region').root).find(region=>region.regionId==='new-region')!.bounds
   expect((area.x-frame.x)/frame.width).toBeCloseTo(actual.x)
   expect((area.y-frame.y)/frame.height).toBeCloseTo(actual.y)
   expect(area.width/frame.width).toBeCloseTo(actual.width)
   expect(area.height/frame.height).toBeCloseTo(actual.height)
  })
 }
 expect(drawings.size).toBe(4)
})

it('exposes new object, operation and editor drawings via the original public theme discovery owner',async()=>{
 const update=vi.fn();const result=await executeSettingsThemesControl({operation:'settings.resource.list',resource:'themes'},{current:{appearance:{customThemes:{}}},update} as unknown as ConfigOwner)
 expect('iconCatalog' in result).toBe(true);if(!('iconCatalog'in result))throw Error('Missing original public catalog')
 expect(result.iconCatalog).toEqual(getSemanticIconCatalog())
 for(const id of ['object.tab','action.resume-session','action.restore-defaults','file.notebook','editor.snooze-suggestions']){
  const role=result.iconCatalog.icons.find(i=>i.id===id);expect(role,id).toBeDefined();expect(result.iconCatalog.glyphs,id).toContain(role!.defaultGlyph)
 }
 expect(update).not.toHaveBeenCalled()
})
