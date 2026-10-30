import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vitest/config'
import base from './mobile-mote-default-entry.config.mts'

const attention = `  if (hasRequest || presentation?.group === 'attention' || presentation?.stateMark === 'attention' || presentation?.stateMark === 'error' ||
    presentation?.state === 'error' || presentation?.state === 'waiting' || presentation?.state === 'blocked') return false`
const sourceFence = 'if (beforeAction && !beforeAction() || !current.current.visible || !current.current.connected || current.current.client !== client || current.current.agentSessionId !== agentSessionId) return false'
const mutations: Record<string, { file: string; before: string; after: string }> = {
  'show-unknown': { file: 'navigation/mobile-agent-status.ts', before: 'hasRequest = false): boolean {', after: 'hasRequest = false): boolean { return false;' },
  'attention': { file: 'navigation/mobile-agent-status.ts', before: attention, after: '  if (false) return false' },
  'request': { file: 'navigation/mobile-agent-status.ts', before: 'if (hasRequest ||', after: 'if (false ||' },
  'team-visible': { file: 'navigation/MobileMoteTeam.tsx', before: ': !ordinaryUnknownAgentStatus(member.presentation, Boolean(member.request)) &&', after: ': true &&' },
  'missing-details': { file: 'navigation/MobileAgentStatusDetails.tsx', before: 'if (!presentation && !onRefresh) return null', after: 'if (!presentation) return null' },
  'menu-presentation': { file: 'navigation/MobileAgentRow.tsx', before: '...(target.presentation ? { presentation: target.presentation } : {}),', after: '' },
  'menu-refresh': { file: 'navigation/MobileAgentRow.tsx', before: '...(target.refreshStatus ? { refreshStatus: target.refreshStatus } : {}),', after: '' },
  'app-source': { file: 'MobileApp.tsx', before: 'statusSource={menuTarget}', after: 'statusSource={undefined}' },
  'details-source': { file: 'navigation/MobileAgentStatusDetails.tsx', before: '{presentation.detail}</p>', after: '{"隐藏的原始原因"}</p>' },
  'menu-fence': { file: 'conversation/MobileAgentActions.tsx', before: sourceFence, after: 'if (false) return false' },
  'refresh-visible': { file: 'navigation/MobileSpatialNavigation.tsx', before: 'current.client !== client || !current.connected || current.home', after: 'current.client !== client || !current.connected || !current.visible || current.home' },
  'directory-fence': { file: 'navigation/MobileSpatialNavigation.tsx', before: 'current.client !== client || !current.connected || current.home', after: '!current.connected || current.home' }
}
const name = process.env.AGENTMUX_MOBILE_QUIET_MUTATION
if (name && !mutations[name]) throw Error('Unknown quiet status mutation: ' + name)
const files = ['navigation/mobile-agent-status.ts', 'navigation/MobileAgentStatusDetails.tsx', 'navigation/MobileSpatialNavigation.tsx',
  'navigation/MobileMoteTeam.tsx', 'navigation/MobileAgentRow.tsx', 'conversation/MobileAgentActions.tsx', 'MobileApp.tsx']
export default defineConfig({ ...base, plugins: [...base.plugins ?? [], { name: 'loaded-mobile-quiet-run-status', enforce: 'pre', transform(source, id) {
  const file = id.split('?')[0]!, target = files.find(value => file.endsWith('/apps/mobile/src/' + value))
  if (!target) return
  const mutation = name && mutations[name]
  if (mutation?.file === target && source.split(mutation.before).length !== 2) throw Error('Loaded quiet status mutation marker changed: ' + name)
  const code = mutation?.file === target ? source.replace(mutation.before, mutation.after) : source
  const trace = process.env.AGENTMUX_MOBILE_QUIET_TRACE
  if (name && !trace) throw Error('Loaded source mutation trace is required')
  const marker = { name: name ?? 'baseline', file, applied: code !== source,
    originalSha256: createHash('sha256').update(source).digest('hex'), loadedSha256: createHash('sha256').update(code).digest('hex') }
  if (trace) appendFileSync(trace, JSON.stringify({ phase: 'loaded', ...marker }) + '\n')
  return { code: code + '\n;globalThis.__mobileQuietRunStatusEvaluated ??= []; globalThis.__mobileQuietRunStatusEvaluated.push(' + JSON.stringify(marker) + ');\n', map: null }
} }], test: { ...base.test, include: ['apps/mobile/test/mobile-quiet-run-status.test.tsx'], testTimeout: 15000 } })
