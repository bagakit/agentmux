import { quote } from 'shlex'
import { parseExecutorArgs } from '../../lib/executors'

/** Draft display only. The command stays one literal file name, including spaces. */
export function ExecutorLaunchPreview({ command, args }: { command: string; args: string }) {
  let preview: string | undefined
  let hint = 'Enter an executable name or path to preview the launch.'
  try {
    const argv = parseExecutorArgs(args)
    if (command.trim()) preview = [command.trim(), ...argv].map(quote).join(' ')
  } catch {
    hint = 'Complete the argument quoting to preview the launch.'
  }
  return <div className="settings-executor-preview" aria-label="Configured launch preview">
    <span>Launch preview <small>Executable + arguments</small></span>
    {preview === undefined ? <p>{hint}</p> : <code>{preview}</code>}
  </div>
}
