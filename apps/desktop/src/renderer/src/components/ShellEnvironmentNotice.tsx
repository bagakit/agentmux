import { useAppStore } from '../store'
import { ServiceWindowNotice } from './ServiceWindowNotice'

export function ShellEnvironmentNotice() {
  const warning = useAppStore((state) => state.environmentWarning)
  return <ServiceWindowNotice notice={warning ? {
    kind: 'process-degraded',
    notice: {
      step: 'Local shell environment is incomplete',
      mode: warning,
      restore: 'Check your shell startup scripts, then restart AgentMux and create a new Agent or terminal. Existing processes keep their original environment.'
    }
  } : null} />
}
