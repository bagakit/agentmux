import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
const changes: Record<string, readonly [string,string]> = {
  'drop-service': ['error: latest.error, observationError: latest.observationError, windowFrozen: latest.windowFrozen, refresh: latest.refresh', 'error: latest.error, observationError: null, windowFrozen: false, refresh: latest.refresh'],
  'clear-without-refill': ['else void latest.refresh() }', 'else setLatest(current => ({ ...current, observationError: null, windowFrozen: false })) }'],
  'hidden-observation': ['enabled={readingEnabled && !historical}', 'enabled={!historical}']
}
export default defineConfig({ ...original, root,
  cacheDir: resolve(root,'.tmp/focus-observation-service-vitest-cache'),
  plugins: [...(original.plugins ?? []), { name:'focus-observation-service-loaded-source', enforce:'pre', transform(code,id) {
    const file=id.split('?')[0]!
    if(!file.startsWith(`${root}/apps/desktop/src/`) || !/\.[cm]?[jt]sx?$/u.test(file)) return
    const before=code, mutation=process.env.AGENTMUX_FOCUS_OBSERVATION_MUTATION
    if(mutation && file===`${root}/apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx`) {
      const change=changes[mutation]; if(!change) throw new Error(`Unknown observation mutation ${mutation}`)
      if(code.split(change[0]).length!==2) throw new Error(`Missing unique actual owner for ${mutation}`)
      code=code.replace(change[0],change[1])
    }
    const target=process.env.AGENTMUX_FOCUS_OBSERVATION_LOADED_SOURCE
    if(target) appendFileSync(target,JSON.stringify({path:relative(root,file),originalSHA256:createHash('sha256').update(before).digest('hex'),sha256:createHash('sha256').update(code).digest('hex'),bytes:Buffer.byteLength(code),...(code!==before?{mutation}: {})})+'\n')
    if(code!==before) return {code,map:null}
  }}],
  test: {...original.test,include:['apps/desktop/test/focus-native-observation-service.test.tsx'],passWithNoTests:false,maxWorkers:1,fileParallelism:false,testTimeout:15000}
})
