import base from '../scripts/fixtures/settings-overview/vitest.config.mts'
export default {...base,resolve:{...base.resolve,conditions:['browser','module','development|production']},esbuild:{jsx:'automatic'},test:{...base.test,include:['apps/desktop/test/toolkit-agent-cards-performance.test.tsx']}}
