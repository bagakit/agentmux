import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { appendFileSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs'
import { resolve,relative } from 'node:path'
const root=fileURLToPath(new URL('../../../',import.meta.url)), evidence=process.env.AGENTMUX_APPLICATION_ACCESS_EVIDENCE,mutant=process.env.AGENTMUX_APPLICATION_ACCESS_MUTANT??'baseline'
const edits: Record<string,{before:string;after:string}>={
  verification:{before:'&& covers(observed,j.profile)) {',after:"&& observed.status === 'ready') {"},
  reconciliation:{before:"this.invoke(j.profile.target,j.profile,'operation',{operationId,intentDigest:j.intentDigest},signal)",after:"this.invoke(j.profile.target,j.profile,'import',{operationId,intentDigest:j.intentDigest},signal)"}
}
if(mutant!=='baseline'&&!edits[mutant])throw new Error('Unknown application access mutation')
const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
export default defineConfig({root,resolve:{alias:{'@agentmux/client-ui/theme':fileURLToPath(new URL('../../client-ui/src/theme/index.ts',import.meta.url))}},
  plugins:[{name:'bound-application-access-source',enforce:'pre',transform(input,id){
    if(id.includes('?')||!evidence)return
    const path=relative(root,id);if(!path.match(/^(packages\/core\/src\/|apps\/desktop\/src\/main\/application-access-owner\.ts)/u))return
    const original=readFileSync(id,'utf8');if(original!==input)throw new Error('Production source was already transformed')
    let code=input,applied=false
    if(path==='packages/core/src/application-access-owner.ts'&&edits[mutant]){const edit=edits[mutant]!;if(code.split(edit.before).length!==2)throw new Error('Mutation must bind exactly one actual owning expression');code=code.replace(edit.before,edit.after);applied=true;writeFileSync(resolve(evidence,'loaded-owner.ts'),code)}
    mkdirSync(evidence,{recursive:true});appendFileSync(resolve(evidence,'loaded-source.jsonl'),JSON.stringify({path,sourceSHA256:sha(original),consumedSHA256:sha(code),applied,mutant})+'\n')
    return applied?{code,map:null}:undefined
  }}],test:{include:['packages/core/test/application-access.test.ts','apps/desktop/test/application-access-main.test.ts'],exclude:['**/node_modules/**','**/dist/**'],pool:'forks',maxWorkers:1,testTimeout:30000,hookTimeout:30000}})
