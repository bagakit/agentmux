import {defineConfig,mergeConfig} from 'vite'
import base from '../../../vite.web.config'
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
const inputs:Record<string,{source:string,transformed:string}>={};const mutant=process.env.DIRECTION_ICON_MUTANT==='1'
export default mergeConfig(base,defineConfig({root:import.meta.dirname,worker:{format:'es'},plugins:[{name:'mobile-key-source-binding',enforce:'pre',transform(code,id){const original=code
 if(mutant&&id.endsWith('/terminal/MobileTerminalViewer.tsx')){const target='<SemanticIcon name={icon} size={16} />';if(code.split(target).length!==2)throw Error('Expected one directional rendering edge');code=code.replace(target,'<SemanticIcon name="object.keyboard" size={16} />')}
 if(!id.includes('node_modules')&&!id.startsWith('\0'))inputs[id]={source:createHash('sha256').update(original).digest('hex'),transformed:createHash('sha256').update(code).digest('hex')};return{code,map:null}
},generateBundle(){this.emitFile({type:'asset',fileName:'candidate-inputs.json',source:JSON.stringify({mutant,inputs},null,2)})}}],build:{target:'esnext',minify:false,outDir:resolve(process.env.NATIVE_COLOR_PROOF_DIR!,mutant?'mobile-keys-mutant':'mobile-keys-site'),emptyOutDir:true}}))
