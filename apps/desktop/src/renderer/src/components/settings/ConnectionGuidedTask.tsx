import type { ConnectionRecord } from '@agentmux/core/connections'
import type { ConnectionManagementModel } from './useConnectionManagementSetup'
import { BotSetupGuide } from './BotSetupGuide'

/** A single current action over the original Setup view; management remains independent. */
export function ConnectionGuidedTask({ record, model, onLibrary, onConsole }: { record: ConnectionRecord; model: ConnectionManagementModel; onLibrary: () => void; onConsole: () => Promise<void> }) {
  const task = model.task
  const perform = () => {
    if (task.kind === 'action') model.advance(task.action)
    else if (task.kind === 'console') void onConsole()
    else if (task.kind === 'status') model.checkPublicationStatus()
    else if (task.kind === 'original') {
      const configuration = model.view?.applicationConfiguration, original = configuration?.unresolved
      if (original && original.connectionId !== record.config.connectionId) { onLibrary(); return }
      model.inspectOriginalConfiguration()
    } else void model.checkGuidedSettings()
  }
  return <div className="connector-guided-task" data-guided-task={task.kind}>
    <BotSetupGuide stage={task.kind === 'original' ? 'attention' : 'connect'} />
    <div><strong>{task.title}</strong><p>{task.summary}</p></div>
    <button className="primary-button" data-guided-primary disabled={model.busy} onClick={perform}>{model.busy ? model.guidedCheck ? 'Checking bot settings…' : 'Working…' : task.label}</button>
  </div>
}
