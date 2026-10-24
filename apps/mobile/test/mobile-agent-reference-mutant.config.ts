import { mergeConfig } from 'vitest/config'
import base from '../vitest.config'

// Restore an unconditional directory clone in the loaded hook, not the shared source tree.
export default mergeConfig(base, { plugins: [{
  name: 'restore-unrequested-reference-directory-read', enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!id.split('?')[0]!.endsWith('/src/conversation/use-mobile-agent-references.ts')) return
    const marker = '  const [snapshot, setSnapshot] = useState<' 
    if (!code.includes(marker)) throw new Error('Reference mutation did not match the loaded production module')
    return code.replace(marker, '  if (!requested && client) client.agentSessions()\n' + marker)
  }
}] })
