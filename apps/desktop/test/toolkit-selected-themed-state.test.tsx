// @vitest-environment happy-dom
import { act } from 'react'
import { it, expect, vi } from 'vitest'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { semanticIconHref } from '@agentmux/client-ui/icons'
import { ToolkitSettingsPane } from '../src/renderer/src/components/settings/ToolkitSettingsPane'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor',()=>({default:()=>null}))
const dom=composerDOM()
it('actual selected custom tool consumes a selection role independently of confirm and keeps its original draft and row action',async()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}unobserve(){}})
 const cleanup=mountThemeRuntime(window),update=vi.fn(),run=vi.fn(),tools=['a','b'].map(id=>({id,revision:'revision-'+id,name:'Original tool '+id,icon:'terminal' as const,enabled:true,statusBar:'icon' as const,workspacePath:fixturePath('work'),script:'Original unsaved source',args:[]}))
 try{await dom.render(<ToolkitSettingsPane tools={tools} active performance={{enabled:false,statusBar:'icon'}} writer={{add:vi.fn(),update}} onSave={vi.fn()} onRemoveTool={vi.fn()} onRunTool={run}/>);const row=dom.container.querySelector<HTMLButtonElement>('[data-tool-id="a"]')!;expect(row,'actual nonempty selected toolkit row').not.toBeNull();expect(row.getAttribute('aria-pressed')).toBe('true');expect(row.querySelector('use[href="'+semanticIconHref('status.selected')+'"]')).not.toBeNull();expect(row.querySelector('[aria-label="Selected tool"]')?.getAttribute('width')).toBe('12')
 const custom=structuredClone(GRAPHITE_THEME);custom.id='custom.toolkit-selected';custom.name='Selection independent of confirmation';custom.icons={'status.selected':{kind:'paths',paths:[{d:'M12 3L21 20H3Z'}]},'action.confirm':{kind:'paths',paths:[{d:'M4 4H20V20H4Z'}]}};await act(async()=>{expect(previewTheme(custom).applied).toBe(true)});expect(dom.container.querySelector('[data-tool-id="a"]')).toBe(row);expect(document.getElementById(semanticIconHref('status.selected').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M12 3L21 20H3Z');await act(async()=>row.click());expect(dom.container.querySelector('.toolkit-workbench')?.getAttribute('data-view')).toBe('editor');expect(dom.container.querySelector('[data-tool-editor]')?.getAttribute('data-tool-editor')).toBe('a');expect(dom.container.querySelector<HTMLInputElement>('.toolkit-editor__name input')?.value).toBe('Original tool a');expect(update).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled()
 }finally{await dom.render(null);cleanup();vi.restoreAllMocks()}
})
