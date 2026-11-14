import type { TailcatKeyRole } from '@agentmux/core'
import type { HostConfig } from '../../../../shared/contracts'
import { tailcatSetupContext, tailcatSetupPrompt, createTailcatSetupTask, type TailcatSetupFailure } from '../../lib/tailcat-setup-task'
import { MoteTaskAction } from '../MoteTaskAction'

export function TailcatSetupHelp({ host, role, failure, active = true }: { host: HostConfig; role: TailcatKeyRole; failure?: TailcatSetupFailure | undefined; active?: boolean }) {
  const context = tailcatSetupContext(host, role, failure)
  return <div className="host-tailcat-help" data-tailcat-help={role}>
    <p>{failure ? 'Ask Mote to help with this preparation step.' : 'Ask Mote to help connect these two Macs.'}</p>
    <details><summary>Install Tailcat manually</summary><p>On each Mac that needs the official CLI: <code>brew install tailcat</code></p></details>
    <MoteTaskAction active={active} scopeKey={JSON.stringify(context)} preview={tailcatSetupPrompt(context, null)} createTask={() => createTailcatSetupTask(context)} />
  </div>
}
