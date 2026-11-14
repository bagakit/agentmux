// Actual production entrypoint; no gallery, bridge replacement or second Survey owner.
import '../../../src/renderer/src/main'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { updateThemeSelection } from '@agentmux/client-ui/theme'
import { useLauncherState, checkpointLauncherState } from '../../../src/renderer/src/lib/launcher-state'
import { warmLauncherId } from '../../../src/renderer/src/lib/warm-terminal-preview'
import { browserProfiles } from '../../../src/renderer/src/lib/browser-profiles'
import { api } from '../../../src/renderer/src/lib/api'
Object.assign(window, { profileSurveyNative: {
 read() { const s = useAppStore.getState(); return { loading: s.loading, tabs: s.tabs, layouts: s.layouts, activeWorkspaceId: s.activeWorkspaceId, mainSurface: s.mainSurface, surveySelection: s.surveyZoneSelection, surveyCollectedZones: s.surveyCollectedZones, surveyPageReferences: (s as unknown as Record<string, unknown>).surveyPageReferences, surveyProfileView:(s as unknown as Record<string,unknown>).surveyProfileView, configWorkspaces:s.config?.workspaces.map(({id,name,path,kind})=>({id,name,path,kind})), error: s.error, launcherDrafts: useLauncherState.getState().drafts, workbenchSpaceSelection: s.workbenchSpaceSelection } },
 async prepareTask(workspaceId: string) { await useAppStore.getState().selectWorkspace(workspaceId); useAppStore.getState().openLauncher({workspaceId,reveal:true}); const state=useAppStore.getState(), tab=Object.values(state.tabs).find(tab=>Object.values(tab.regions).some(region=>region.kind==='launcher'&&region.workspaceId===workspaceId)); if(!tab)throw Error('Original Launcher preparation did not create its real Region'); const region=Object.values(tab.regions).find(region=>region.kind==='launcher'&&region.workspaceId===workspaceId)!; const key=warmLauncherId({tabGroupId:state.layouts[workspaceId]!.activeGroupId,regionId:region.regionId}); if(!useLauncherState.getState().setDraft(key,'prompt','Keep this original mixed task input'))throw Error('Original Launcher draft owner refused this input'); await checkpointLauncherState(); await prepareRendererUpdate(); return this.read() },
 async prepareLegacyWorkspace(workspaceId: string) { await useAppStore.getState().selectWorkspace(workspaceId); useAppStore.getState().openLauncher({workspaceId,reveal:true}); await prepareRendererUpdate(); return this.read() },
 selectPage(reference: { regionId: string; browserId: string }) { const s = useAppStore.getState(); s.setSurveyZoneSelection({kind:'page', ...reference} as never); s.setMainSurface('survey') },
 appearance(mode: 'dark' | 'light') { updateThemeSelection({...useAppStore.getState().config!.appearance,appAppearance:mode}) },
 refreshProfiles() { return browserProfiles.refresh() },
 checkpoint() { return prepareRendererUpdate('quit') },
 api,
} })
