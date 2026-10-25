import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { AgentConnectorDialog } from '../../../src/renderer/src/components/AgentConnectorDialog'
import { SettingsNavigation } from '../../../src/renderer/src/components/SettingsNavigation'
import { MoteWorkfaceContext } from '../../../src/renderer/src/lib/mote-workface'
import { channelFixture } from './facts'

const { proof, settingsCatalog, session, connection, hostingTarget, target } = channelFixture

/** The original product Dialog and providers; Workbench routing is covered by the real owner consumers. */
function SharingDialogFixture() {
  const [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => { Object.assign(proof, { dialogReady: true }) }, [])
  return <DesktopClientUiProvider><SettingsNavigation.Provider value={{
    open: section => { proof.routes.push(section) }, openToolkit() {}, openHost() {}, chooseAgent() {}, openMoteLark() {},
    channelPresentation: settingsCatalog.channelPresentation, channelEntries: settingsCatalog.channelEntries,
    openChannel: origin => { proof.routes.push(origin.connection.adapterId) }
  }}><MoteWorkfaceContext.Provider value={null}>
    <button type="button" id="sharing-fixture-open" className="small-button" style={{ alignSelf: 'flex-start', margin: 24 }} ref={trigger} onClick={() => setOpen(true)}>Open original group</button>
    {open ? <AgentConnectorDialog mode="details" original={{ target, session, name: session.label, connectionId: connection.config.connectionId,
      hostingTarget, bindingId: 'preview-original-binding-0', channel: 'feishu', identity: { providerId: session.providerId, executorId: session.executorId ?? undefined } }}
      onClose={() => setOpen(false)} returnFocus={() => trigger.current} /> : null}
  </MoteWorkfaceContext.Provider></SettingsNavigation.Provider></DesktopClientUiProvider>
}

createRoot(document.getElementById('root')!).render(<SharingDialogFixture />)
proof.ready = true
