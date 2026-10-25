import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { SettingsNavigation, type SettingsNavigationRequest } from '../../../src/renderer/src/components/SettingsNavigation'
import { settingsCatalog } from '../../../src/renderer/src/components/settings/settings-modules'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { channelFixture } from './facts'

const { proof, workspace } = channelFixture
function Fixture() {
  const [route, setRoute] = useState<SettingsNavigationRequest | null>(null)
  return <DesktopClientUiProvider><SettingsNavigation.Provider value={{
    open: section => { proof.routes.push(section); setRoute({ section }) }, openToolkit() {}, openHost() {}, chooseAgent() {}, openMoteLark() {},
    channelPresentation: settingsCatalog.channelPresentation,
    channelEntries: settingsCatalog.channelEntries,
    openChannel: channelOrigin => setRoute({ section: settingsCatalog.channelPresentation(channelOrigin.connection.application, channelOrigin.connection.adapterId)?.section ?? 'overview', channelOrigin })
  }}><WorkspaceWorkbench workspaceId={workspace.id} />
    {route ? <SettingsPanel initialSection={route.section} navigationRequest={route} onClose={() => setRoute(null)} /> : null}
  </SettingsNavigation.Provider></DesktopClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
proof.ready = true
