import {defineConfig,mergeConfig} from 'vite'
import base from './color-capture.config.mts'
import {resolve} from 'node:path'
export default mergeConfig(base,defineConfig({plugins:[{name:'excalidraw-color-counterfactual',enforce:'pre',transform(code,id){if(id.endsWith('/lib/excalidraw-icons.ts')){const target='style.textContent = EXCALIDRAW_UI_THEME_CSS';if(code.split(target).length!==2)throw Error('Expected one native UI projection edge');return{code:code.replace(target,"style.textContent = ''"),map:null}}}}],build:{outDir:resolve(process.env.NATIVE_ICON_PROOF_DIR!,'exca-color-mutant')}}))
