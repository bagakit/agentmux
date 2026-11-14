import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

const root=resolve(import.meta.dirname,'../../..'),mutation=process.env.AGENTMUX_SOURCE_NAV_MUTATION
const mutations:Record<string,[string,string,string]>={
  'old-filter':['apps/desktop/src/renderer/src/components/SourceFolderNavigation.tsx',
    'const key=spaceMountKey({runtimeId:fact.runtimeId,spaceId:fact.spaceId}),project=result.get(key)??{key,folders:[]};project.folders.push(fact);result.set(key,project)',
    'const key=spaceMountKey({runtimeId:fact.runtimeId,spaceId:fact.spaceId});try{const entry=(inputs as Record<string,{navigation?:unknown}>)[key];if(entry&&entry.navigation!==\'project\')continue}catch{};const project=result.get(key)??{key,folders:[]};project.folders.push(fact);result.set(key,project)'],
  'independent-mount':['apps/desktop/src/renderer/src/lib/source-launcher-request.ts',
    'store.openOriginalSpaceLocation({ target: input.target, resource,',
    'useAppStore.setState({selectedSpaceMount:\'legacy-mounted-destination\',mainSurface:\'workbench\'});store.openOriginalSpaceLocation({ target: input.target, resource,'],
  'configured-row':['apps/desktop/src/renderer/src/components/WorkspaceSidebar.tsx',
    'if (originalSource && originalSourceHostId) {','if (false) {'],
  'local-carrier':['apps/desktop/src/renderer/src/components/WorkspaceSidebar.tsx',
    'const originalSourceHostId = originalSource?.carrierHostId ?? sourceFolders.carrier?.id','const originalSourceHostId = sourceFolders.carrier?.id'],
  'mounted-fallback':['apps/desktop/src/renderer/src/store.ts',
    'delete next.selectedSpaceMount\n      return next\n    })\n  },\n  openOriginalSpaceLauncher',
    'next.selectedSpaceMount = key\n      return next\n    })\n  },\n  openOriginalSpaceLauncher'],
  'second-store':['apps/desktop/src/renderer/src/lib/source-launcher-request.ts',
    '  store.observeSpaceMount(input.target, { snapshot, reading: false })',
    '  store.observeSpaceMount(input.target, { snapshot, reading: false });useAppStore.setState(state=>({tabs:{...state.tabs,...Object.fromEntries(snapshot.scope.tabs.map(tab=>[tab.tabId,state.tabs[tab.tabId]??{id:tab.tabId}]))}}))'],
  'legacy-selection':['apps/desktop/src/renderer/src/lib/original-space-navigation.ts',
    'const space = graph.spaces.find(candidate => candidate.spaceId === target.reference.spaceId)','const space = undefined'],
  'implicit-utility':['apps/desktop/src/renderer/src/components/NewTabSurface.tsx',
    'disabled={busyKind !== null || !workspace || Boolean(sourceUnavailable)}','disabled={busyKind !== null || !workspace}'],
  'ordinary-projection':['apps/desktop/src/renderer/src/lib/original-space-navigation.ts',
    'const id = originalSourceTabProjectionId(target, tabId), workspaceId = originalSourceWorkspaceId(target), source = sourceAddress(target, tabId)',
    'const id = tabId, workspaceId = originalSourceWorkspaceId(target), source = sourceAddress(target, tabId)'],
  'unknown-retention':['apps/desktop/src/renderer/src/store.ts',
    'const projection = ordinaryLocalOccurrence ? { mountedSpaceInputs: reconciled.mountedSpaceInputs } : reconciled',
    'const projection = ordinaryLocalOccurrence ? { mountedSpaceInputs: reconciled.mountedSpaceInputs } : { tabs: {}, layouts: {} }'],
  'implicit-prewarm':['apps/desktop/src/renderer/src/components/NewTabSurface.tsx',
    'if (!sourceUnavailable && workspace && visible && presentationActive && inputRegionActive && !controlNavigation && sections.terminal === \'expanded\') {',
    'if (workspace && visible && presentationActive && inputRegionActive && !controlNavigation && sections.terminal === \'expanded\') {'],
  'capture-source':['apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts',
    'Object.entries(state.tabs).filter(([, tab]) => !tab.source)','Object.entries(state.tabs)'],
  'local-file-fallback':['apps/desktop/src/renderer/src/store.ts',
    'if (isOriginalSourceFileWorkspace(workspaceId)) return { status: \'error\', code: \'FILE_SOURCE_UNAVAILABLE\',',
    'if (false) return { status: \'error\', code: \'FILE_SOURCE_UNAVAILABLE\','],
  'source-active-reseat':['apps/desktop/src/renderer/src/store.ts',
    '    ? workbenchSpaceSelection.workspaceId : reseatActiveWorkspaceId(config, persisted.activeWorkspaceId)',
    '    ? reseatActiveWorkspaceId(config, persisted.activeWorkspaceId) : reseatActiveWorkspaceId(config, persisted.activeWorkspaceId)']
}
if(mutation)assert.ok(mutations[mutation],'Known Source navigation mutation')
const targets=Object.values(mutations).map(([path])=>path)
export default defineConfig({...source,cacheDir:resolve(root,'.cache/source-space-navigation-mutations',mutation??'control'),plugins:[...(source.plugins??[]),{
  name:'source-space-navigation-loaded-mutation',enforce:'pre',transform(original,id){
    const path=relative(root,id.split('?')[0]!)
    if(!targets.includes(path))return
    let code=original
    if(mutation){const [target,from,to]=mutations[mutation]!;if(path===target){assert.equal(code.split(from).length-1,1,`Unique mutation anchor: ${mutation}`);code=code.replace(from,to)}}
    const evidence=process.env.AGENTMUX_SOURCE_NAV_LOADED
    if(evidence){mkdirSync(dirname(evidence),{recursive:true});const sha=(value:string)=>createHash('sha256').update(value).digest('hex');appendFileSync(evidence,JSON.stringify({path,originalSHA256:sha(original),loadedSHA256:sha(code),mutated:code!==original,mutation:code!==original?mutation:null})+'\n')}
    if(code!==original)return{code,map:null}
  }
}],test:{...source.test,include:[
  'apps/desktop/test/source-folder-navigation.test.tsx','apps/desktop/test/ordinary-source-admission.test.tsx','apps/desktop/test/remote-route-admission.test.tsx',
  'apps/desktop/test/source-launcher-failure.test.tsx','apps/desktop/test/host-original-spaces-navigation.test.tsx',
  'apps/desktop/test/source-projection-reconciler.test.tsx',
  'apps/desktop/test/source-space-navigation-persistence.test.mts'
],setupFiles:[resolve(root,'apps/desktop/test/source-space-navigation-persistence.setup.mts')],maxWorkers:1,fileParallelism:false,passWithNoTests:false,testTimeout:30_000}
})
