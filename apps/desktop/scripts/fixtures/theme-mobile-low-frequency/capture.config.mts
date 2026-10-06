import {defineConfig,mergeConfig} from 'vite'
import base from '../../../vite.web.config'
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
const inputs:Record<string,{source:string,transformed:string}>={};const mutant=process.env.MOBILE_LOW_FREQUENCY_MUTANT??''
export default mergeConfig(base,defineConfig({root:import.meta.dirname,worker:{format:'es'},plugins:[{name:'mobile-low-frequency-source-binding',enforce:'pre',transform(code,id){const original=code
 if(mutant==='compose'&&id.endsWith('/MobileApp.tsx')){const target="semanticIconComponent('action.compose')";if(code.split(target).length!==2)throw Error('Expected one compose semantic edge');code=code.replace(target,"semanticIconComponent('object.keyboard')")}

 if(mutant==='target'&&id.endsWith('/MobileApp.tsx')){const edge="{workface.panel === 'terminal' ? <ThemeObjectConversationIcon size={18} /> : <ThemeObjectTerminalIcon size={18} />}<span>";if(code.split(edge).length!==2)throw Error('One actual menu semantic target edge required');code=code.replace(edge,'<ThemeObjectTerminalIcon size={18} /><span>')}
 if(!id.includes('node_modules')&&!id.startsWith('\0'))inputs[id]={source:createHash('sha256').update(original).digest('hex'),transformed:createHash('sha256').update(code).digest('hex')};return{code,map:null}
},generateBundle(){this.emitFile({type:'asset',fileName:'candidate-inputs.json',source:JSON.stringify({mutant,inputs},null,2)})}}],build:{target:'esnext',minify:false,outDir:resolve(process.env.NATIVE_COLOR_PROOF_DIR!,mutant?`mobile-low-frequency-${mutant}-mutant`:'mobile-low-frequency-site'),emptyOutDir:true}}))
