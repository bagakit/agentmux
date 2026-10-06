import {defineConfig,mergeConfig} from 'vite'
import base from './capture.config.mts'
export default mergeConfig(base,defineConfig({build:{minify:false}}))
