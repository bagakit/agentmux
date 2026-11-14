import type { AgentMuxZoneFact } from '@agentmux/core/control'
import type { AppState } from '../../src/renderer/src/store'
import type { SurveyBrowserCreationPorts } from '../../src/renderer/src/lib/survey-browser-creation'
import type { SystemPageHost } from '../../src/renderer/src/lib/survey-system-page'
import type { SurveyPageAdmissionState } from '../../src/renderer/src/lib/survey-profile-binding'

declare const opening: SurveyBrowserCreationPorts
declare const system: SystemPageHost
declare const admission: SurveyPageAdmissionState
declare const application: AppState

// The owner still offers the exact required effects and original membership generation.
const prepared: AgentMuxZoneFact = opening.prepareZone('original-resource')
const confirmed: Promise<void> = opening.checkpointPreparation()
void [prepared, confirmed, opening.get().createBrowser, system.get().createSurveyBrowser, admission.registerSurveyBrowserPage]

// @ts-expect-error A page workflow cannot dispatch arbitrary application controls.
opening.get().executeControl
// @ts-expect-error A page workflow cannot start the generic, globally saving Zone factory.
opening.get().createWorkbenchZone
// @ts-expect-error System presentation cannot select or start an unrelated Agent.
system.get().selectSession
// @ts-expect-error Membership admission cannot change application navigation.
admission.setMainSurface
// @ts-expect-error The globally saving asynchronous factory cannot supply synchronous preparation.
const forbiddenPreparation: SurveyBrowserCreationPorts['prepareZone'] = workspaceId => application.createWorkbenchZone({ workspaceId, spaceIds: [] })
void forbiddenPreparation
