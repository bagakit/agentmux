// @vitest-environment happy-dom
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {expect,it,vi} from 'vitest'
import {applyWorkbenchRegionLayoutPreset,createWorkbenchViewLayout,workbenchRegionBounds} from '../../../packages/core/src/spatial-layout/workbench-view-layout'
import {workbenchRegionPresetIcon} from '../src/renderer/src/components/workbench-split-menu-icons'
import {mountThemeRuntime} from '../../../packages/client-ui/src/theme/runtime'
import {getSemanticIconCatalog,semanticIconHref} from '@agentmux/client-ui/icons'
import {executeSettingsThemesControl} from '../src/main/settings-themes-control'
import type {ConfigOwner} from '../src/main/config-owner'

globalThis.IS_REACT_ACT_ENVIRONMENT=true
it('shows the actual six-region preset orientation through its original product icon factory',async()=>{
 vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}))
 const release=mountThemeRuntime(window,{appAppearance:'light'}),host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{
  const Icon=workbenchRegionPresetIcon('grid-6');await act(async()=>root.render(<Icon size={14}/>))
  const icon=host.querySelector('svg')!;expect(icon.dataset.semanticIcon).toBe('layout.grid-6')
  const target=document.getElementById(icon.querySelector('use')!.getAttribute('href')!.slice(1))!
  const rects=[...target.querySelectorAll('rect')];expect(rects).toHaveLength(6)
  const actual=workbenchRegionBounds(applyWorkbenchRegionLayoutPreset(createWorkbenchViewLayout('original'),'grid-6',['2','3','4','5','6']).root)
  const columns=new Set(actual.map(r=>r.bounds.x.toFixed(5))).size,rows=new Set(actual.map(r=>r.bounds.y.toFixed(5))).size
  expect(new Set(rects.map(r=>r.getAttribute('x'))).size).toBe(columns)
  expect(new Set(rects.map(r=>r.getAttribute('y'))).size).toBe(rows)
  expect(icon.querySelector('use')!.getAttribute('href')).toBe(semanticIconHref('layout.grid-6'))
 }finally{await act(async()=>root.unmount());release();host.remove();vi.unstubAllGlobals()}
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
