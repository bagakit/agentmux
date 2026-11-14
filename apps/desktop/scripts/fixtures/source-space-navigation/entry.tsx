import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { useAppStore } from '../../../src/renderer/src/store'
import { composerConfig } from '../../../test/helpers/composer-dom-fixture'
import { api } from '../../../src/renderer/src/lib/api'

import { createClientUiRoot as createRoot } from '../../../test/helpers/client-ui-render'
import '../../../src/renderer/src/styles/index.css'

const facts=JSON.parse(new URLSearchParams(location.search).get('facts')!)
Object.assign(api.spaceMounts,{call:async()=>{throw Error('Additional Source calls are unavailable in this visibility proof')},watch:async()=>{throw Error('Additional Source watch is unavailable in this visibility proof')}})
useAppStore.setState({config:{...composerConfig,workspaces:[]},mountedSpaceInputs:{},mountedSpaceObservations:{},activeWorkspaceId:null,workbenchSpaceSelection:null,tabs:{},layouts:{},spaceZoneBindings:{}})
useAppStore.getState().mountSpace(facts.target)
useAppStore.getState().observeSpaceMount(facts.target,{snapshot:facts.snapshot,reading:false})

export function SourceNavigationScene(){return <WorkspaceWorkbench workspaceId={facts.target.workspaceId} visible/>}
createRoot(document.getElementById('root')!).render(<SourceNavigationScene/>)
