import base from './node-publishing.config.mts'
export default {...base,test:{...base.test,include:['packages/core/test/node-locator.test.ts','packages/core/test/node-locator.integration.test.ts']}}
