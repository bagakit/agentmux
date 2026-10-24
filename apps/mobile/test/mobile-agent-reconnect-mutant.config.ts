import { mergeConfig } from 'vitest/config'
import base from '../vitest.config'

// Restore the missed-bootstrap behavior only in the loaded production hook.
export default mergeConfig(base, { plugins: [{
  name: 'omit-reference-reconnect-reconciliation', enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!id.split('?')[0]!.endsWith('/src/conversation/use-mobile-agent-references.ts')) return
    const marker = "} else if (event.type === 'connection-state' && event.state === 'restored') {"
    if (!code.includes(marker)) throw new Error('Reconnect mutation did not match the loaded production module')
    return code.replace(marker, "} else if (false && event.type === 'connection-state' && event.state === 'restored') {")
  }
}] })
