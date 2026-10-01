import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
import original from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
const mutations = {
  'one-occurrence': ['apps/desktop/src/renderer/src/App.tsx', '(targets[tabId] ??= []).push(target)', '(targets[tabId] = [target])'],
  'independent-capture': ['apps/desktop/src/renderer/src/components/BrowserPresentationStage.tsx', 'if (media.current) return Promise.resolve()', 'if (false) return Promise.resolve()'],
  'global-visibility': ['apps/desktop/src/renderer/src/App.tsx', "visible: target.visible !== false && mainSurface === 'workbench' && !settingsRoute", 'visible: target.visible !== false']
} as const
export default defineConfig({ ...original, root, define: { __AGENTMUX_WEB_PREVIEW__: 'false' },
  plugins: [...(original.plugins ?? []), { name: 'loaded-native-product-owner', enforce: 'pre', transform(source,id) {
    const path=id.split('?')[0]!
    if(!path.startsWith(root+'/apps/desktop/src/'))return
    let code=source
    const mutation=process.env.AGENTMUX_NATIVE_PRODUCT_MUTATION as keyof typeof mutations|undefined
    if(mutation){const change=mutations[mutation];assert.ok(change,'Known product mutation');if(path===resolve(root,change[0])){
      assert.equal(source.split(change[1]).length-1,1,'Unique loaded product anchor');code=source.replace(change[1],change[2])}}
    const mutated=code!==source
    const factoryBoundary=path===resolve(root,'apps/desktop/src/renderer/src/lib/api.ts')
    if(factoryBoundary) {
      const needle='export const api = __AGENTMUX_WEB_PREVIEW__ ? mockApi : requireDesktopApi()'
      assert.equal(code.split(needle).length-1,1,'Actual maintained data factory');code=code.replace(needle,'export const api = mockApi')
    }
    if(process.env.AGENTMUX_NATIVE_PRODUCT_LOADED)appendFileSync(process.env.AGENTMUX_NATIVE_PRODUCT_LOADED,JSON.stringify({path:relative(root,path),sourceSHA256:createHash('sha256').update(source).digest('hex'),loadedSHA256:createHash('sha256').update(code).digest('hex'),mutated,factoryBoundary,mutation:mutation??null})+'\n')
    return code===source?undefined:{code,map:null}
  }}],
  cacheDir:resolve(root,'.tmp/native-product-vitest-cache'),
  test:{...original.test,include:['apps/desktop/test/browser-presentation-product.test.tsx'],passWithNoTests:false,fileParallelism:false,maxWorkers:1,testTimeout:15000}
})
