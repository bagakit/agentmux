import {defineConfig} from 'vitest/config'
import {readFileSync,appendFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {isAbsolute,relative,resolve} from 'node:path'
import {candidateAlias,candidateModule} from '../../desktop/scripts/candidate-package-resolve.mjs'
import {mutations} from './mote-conversation-start.mutations.mjs'
const root=process.cwd(),selected=process.env.AGENTMUX_MOTE_START_MUTATION??'',hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
if(selected&&!Object.hasOwn(mutations,selected))throw Error('Unknown source mutation '+selected)
export default defineConfig({root,cacheDir:resolve(root,'.cache/mote-conversation-start-core'),resolve:{alias:[candidateAlias(root,{source:true})]},plugins:[{name:'mote-start-loaded-production',enforce:'pre',transform(source,id){
 const file=id.split('?')[0]!
 if(!isAbsolute(file)||id.includes('?')||!file.endsWith('.ts'))return
 const actual=candidateModule(root,file),path=relative(root,actual)
 if(!path.startsWith('packages/core/src/')&&!path.startsWith('apps/host/src/'))return
 const mutation=selected?mutations[selected as keyof typeof mutations]:null,applied=mutation?.owner===path
 let loaded=source
 if(applied){if(source.split(mutation!.from).length!==2)throw Error('Expected one executable mutation site '+selected);loaded=source.replace(mutation!.from,mutation!.to)}
 const fact={path,fileSHA256:hash(readFileSync(actual)),originalSHA256:hash(source),loadedSHA256:hash(loaded),mutation:applied?selected:null},log=process.env.AGENTMUX_MOTE_START_LOADED
 if(!log)return applied?loaded:undefined
 appendFileSync(log,JSON.stringify({...fact,stage:'loaded'})+'\n')
 return {code:loaded+'\nimport {appendFileSync as __moteStartAppend} from "node:fs";\n__moteStartAppend('+JSON.stringify(log)+','+JSON.stringify(JSON.stringify({...fact,stage:'evaluated'})+'\n')+');\n',map:null}
}}],test:{environment:'node',include:['apps/host/test/mote-conversation-start.test.ts'],fileParallelism:false,maxWorkers:1,testTimeout:45000,hookTimeout:15000,passWithNoTests:false,server:{deps:{inline:[/^@agentmux\//u]}}}})
