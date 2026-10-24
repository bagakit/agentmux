import { mergeConfig } from 'vitest/config'
import base from '../vitest.config'

// Instrument the actual hook's candidate materialization while the existing
// Hosted reconnect consumer receives one controlled bootstrap of 160 peers.
// The optional loaded mutant restores synchronous publication for every event.
const peerCount = 160
const synchronousMutant = process.env.AGENTMUX_REFERENCE_SYNC_MUTANT === '1'
function replaceOnce(code: string, marker: string, replacement: string): string {
  if (code.split(marker).length !== 2) throw new Error('Reconnect cost probe did not match its loaded consumer or production hook')
  return code.replace(marker, replacement)
}
export default mergeConfig(base, { plugins: [{
  name: 'measure-reference-reconnect-materialization', enforce: 'pre' as const,
  transform(code: string, id: string) {
    const path = id.split('?')[0]!
    if (path.endsWith('/src/conversation/use-mobile-agent-references.ts')) {
      const materialize = 'if (current) setSnapshot({ client, sessionId, displayName, values: [...peers.values()].map(value => value.suggestion), issue })'
      code = replaceOnce(code, materialize, 'if (current) { (globalThis as any).__referenceReconnectEntries += peers.size; (globalThis as any).__referenceReconnectPublications++; setSnapshot({ client, sessionId, displayName, values: [...peers.values()].map(value => value.suggestion), issue }) }')
      if (synchronousMutant) code = replaceOnce(code, 'queueMicrotask(() => {', ';((fn: () => void) => fn())(() => {')
      return code
    }
    if (path.endsWith('/test/mobile-agent-reference-reconnect.test.tsx')) {
      code = replaceOnce(code, 'bootstrap.sessions = [session(), nextPeer]', `bootstrap.sessions = [session(), nextPeer, ...Array.from({ length: ${peerCount} }, (_, i) => ({ ...session('new-peer-' + i), providerId: 'new-provider-' + i }))]; (globalThis as any).__referenceReconnectEntries = 0; (globalThis as any).__referenceReconnectPublications = 0`)
      const anchor = '    const stale: AgentMuxClientEvent ='
      return replaceOnce(code, anchor, `    expect(client.agentSessions()).toHaveLength(${peerCount + 2}); expect((globalThis as any).__referenceReconnectPublications).toBeGreaterThan(0); console.info('REFERENCE_RECONNECT_COST ' + JSON.stringify({ peers: ${peerCount}, entries: (globalThis as any).__referenceReconnectEntries, publications: (globalThis as any).__referenceReconnectPublications })); expect((globalThis as any).__referenceReconnectEntries).toBeLessThanOrEqual(${2 * (peerCount + 3)});\n` + anchor)
    }
  }
}] })
