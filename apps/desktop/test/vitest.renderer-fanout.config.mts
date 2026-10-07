import { resolve, relative } from 'node:path'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'
const root = source.root!
const baseline: Record<string, string> = process.env.AGENTMUX_RENDERER_BASELINE
  ? JSON.parse(readFileSync(process.env.AGENTMUX_RENDERER_BASELINE, 'utf8')) : {}
const mutations = {
 'reactions-global': ['apps/desktop/src/renderer/src/lib/conversation-reactions.tsx', "useObservedAppStore('reactions', enabled, scope, ", 'useAppStore(', 3],
 'workbench-global': ['apps/desktop/src/renderer/src/lib/workbench-session-subscriptions.ts', "useObservedAppStore('workbenchTab', true, scope, ", 'useAppStore(', 4],
 'attention-no-cache': ['apps/desktop/src/renderer/src/lib/session-visibility.ts', 'if (!previous || facts.some((fact, index) => fact !== previous![index]))', 'if (true)', 1],
 'notices-no-cache': ['apps/desktop/src/renderer/src/lib/session-service-notices.ts', 'if (known && facts.every((fact, index) => fact === known.facts[index]))', 'if (known && false && facts.every((fact, index) => fact === known.facts[index]))', 1],
 'fingerprint-no-cache': ['apps/desktop/src/renderer/src/lib/use-service-notices.ts', 'if (known && facts.length === known.facts.length && facts.every((fact, index) => fact === known.facts[index]))', 'if (known && false && facts.length === known.facts.length && facts.every((fact, index) => fact === known.facts[index]))', 1],
 'index-no-cache': ['apps/desktop/src/renderer/src/lib/session-presentation.ts', 'let index = sessionIndexes.get(sessions)', 'let index = undefined as ReadonlyMap<string, SessionSnapshot> | undefined', 1]
} as const
const counter = (name: string) => `;globalThis.__rendererFanoutCounts ??= {}; globalThis.__rendererFanoutCounts[${JSON.stringify(name)}] = (globalThis.__rendererFanoutCounts[${JSON.stringify(name)}] ?? 0) + 1;`
const instrument = [
 ['apps/desktop/src/renderer/src/lib/workbench-session-subscriptions.ts', /(?=return Object.fromEntries\(modes.map)/, 'workbenchModes'],
 ['apps/desktop/src/renderer/src/lib/session-name-metadata.ts', /export function sessionNamesForReferences\([^]*?\): Record<string, AgentSessionNameMetadata> \{/, 'tabMetadata'],
 ['apps/desktop/src/renderer/src/lib/conversation-reactions.tsx', /const session = sessionPresentationById\(state.sessions\).get\(sessionId\)/, 'reactionProvider'],
 ['apps/desktop/src/renderer/src/lib/session-service-notices.ts', /export function sessionServiceNotices\([^]*?\): ServiceNoticeItem\[\] \{/, 'sessionNotices'],
 ['apps/desktop/src/renderer/src/lib/session-visibility.ts', /export function visibleSessionIds\([^]*?\): Set<string> \{/, 'visibility'],
 ['apps/desktop/src/renderer/src/lib/notification-read-identity.ts', /export function compactNotificationIdentity\([^]*?\): string \{/, 'fingerprintHash']
] as const
export default defineConfig({ ...source, cacheDir: resolve(root, '.tmp/renderer-fanout-vitest-cache'),
 plugins: [{name:'actual-renderer-fanout-source',enforce:'pre',transform(original,id){
  const file=relative(root,id.split('?')[0]!), mutation=process.env.AGENTMUX_RENDERER_MUTATION as keyof typeof mutations | undefined
  let code=baseline[file] ?? original, changed=false
  if(mutation){ const [path,find,replacement,count]=mutations[mutation]; if(file===path){
   assert.equal(code.split(find).length-1,count,'Unique actual source mutation anchor'); code=code.split(find).join(replacement);changed=true
  }}
  const effective=code
  for(const [path,pattern,name] of instrument) if(file===path && !process.env.AGENTMUX_RENDERER_BASELINE){
   assert.equal([...code.matchAll(new RegExp(pattern.source,'g'))].length,1,'Unique loaded source instrumentation')
   code=code.replace(pattern,match=>match+counter(name))
  }
  if(process.env.AGENTMUX_RENDERER_LOADED&&(file.startsWith('apps/desktop/src/')||file.startsWith('packages/'))) appendFileSync(process.env.AGENTMUX_RENDERER_LOADED,
   JSON.stringify({path:file,sourceSHA:createHash('sha256').update(original).digest('hex'),effectiveSHA:createHash('sha256').update(effective).digest('hex'),transformedSHA:createHash('sha256').update(code).digest('hex'),mutation:changed?mutation:null,instrumented:effective!==code})+'\n')
  if(code!==original)return{code,map:null}
 }}], test:{...source.test,include:process.env.AGENTMUX_RENDERER_ADJACENT?[
  'apps/desktop/test/renderer-session-subscription-performance.test.tsx','apps/desktop/test/focus-selected-consumer-cost.test.tsx',
  'apps/desktop/test/session-visibility.test.ts','apps/desktop/test/attention-topic-visibility.test.ts','apps/desktop/test/attention-visibility-authority.test.ts',
  'apps/desktop/test/provider-failure-focus.test.tsx','apps/desktop/test/run-service-projection.test.ts','apps/desktop/test/service-window-notice-component.test.tsx',
  'apps/desktop/test/session-pane-reactions.integration.test.tsx'
 ]:['apps/desktop/test/renderer-fanout-cost.test.tsx'],passWithNoTests:false,testTimeout:30000,environment:'node',setupFiles:[]}
})
