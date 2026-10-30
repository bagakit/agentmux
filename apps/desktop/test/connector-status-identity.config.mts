import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './connector-details-modern.config.mts'
const root = resolve(import.meta.dirname, '../../..'), mutant = process.env.CONNECTOR_STATUS_MUTANT
if (mutant && !['time','popup'].includes(mutant)) throw Error('Unknown status identity mutation')
export default defineConfig({ ...base, cacheDir: resolve(root, '.cache/connector-status-identity'), plugins: [...base.plugins!, {
  name: 'actual-group-status-identity', enforce: 'pre', transform(source, id) {
    const file = relative(root,id.split('?')[0]!)
    if (!/^(apps\/(desktop|host)|packages\/(core|connectors|client-ui))\/src\/.+\.[cm]?[jt]sx?$/u.test(file)) return
    let loaded = source
    if (mutant==='time' && file==='packages/core/src/connection-diagnosis.ts') {
      const before='receivedAt: latest.receivedAt ?? null';if(source.split(before).length!==2)throw Error('Original custody projection anchor changed')
      loaded=source.replace(before,'receivedAt: latest.receivedAt ?? latest.input?.createdAt ?? 1')
    }
    if (mutant==='popup' && file==='apps/desktop/src/renderer/src/components/ConnectorHeaderLinks.tsx') {
      const lines=source.split('\n').filter(line=>line.includes('<ConnectorGroupStatus key='));if(lines.length!==1)throw Error('Actual popup consumer anchor changed')
      loaded=source.replace(lines[0],'      {null /* mutant removes actual group activity consumer */}')
    }
    const marker=process.env.CONNECTOR_STATUS_LOADED
    if(!marker)return loaded===source?undefined:{code:loaded,map:null}
    const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),row={file,source:sha(source),loaded:sha(loaded),mutation:source===loaded?null:mutant}
    return {code:"import{appendFileSync as __statusLoaded}from'node:fs';__statusLoaded("+JSON.stringify(marker)+','+JSON.stringify(JSON.stringify(row)+'\n')+');\n'+loaded,map:null}
  }
}],test:{...base.test,include:['apps/desktop/test/connector-status-identity.test.tsx'],testNamePattern:/actual SDK custody|keeps legacy|keeps the latest original/,globalSetup:[],passWithNoTests:false,fileParallelism:false,testTimeout:35000,hookTimeout:20000}})
