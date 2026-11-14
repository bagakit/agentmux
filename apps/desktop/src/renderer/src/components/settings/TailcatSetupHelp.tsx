import type { TailcatKeyRole } from '@agentmux/core'
import type { HostConfig } from '../../../../shared/contracts'
import { tailcatSetupContext, tailcatSetupPrompt, createTailcatSetupTask } from '../../lib/tailcat-setup-task'
import { MoteTaskAction } from '../MoteTaskAction'

export function TailcatSetupHelp({ host, role }: { host: HostConfig; role: TailcatKeyRole }) {
  const context = tailcatSetupContext(host, role)
  return <div className="host-tailcat-help" data-tailcat-help={role}>
    <p>Need help with installation or setup? On this Mac: <code>brew install tailcat</code></p>
    <MoteTaskAction scopeKey={JSON.stringify(context)} preview={tailcatSetupPrompt(context, null)} createTask={() => createTailcatSetupTask(context)} />
  </div>
}
