import owning from './vitest.owning.config.mts'
export default { ...owning, test: { ...owning.test, include: ['apps/desktop/test/browser-task-reliability-pane.test.tsx'] } }
