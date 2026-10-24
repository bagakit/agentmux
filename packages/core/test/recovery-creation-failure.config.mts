import base from './hook-postcommit-observation.vitest.config.mts'

export const recoveryCreationFailurePattern = 'authoritatively not-applied Start|authoritative not-applied Start|negative receipt|exact creation receipt for retired|reconciles an applied.*Start|retains an unknown Start|preserves an uncertain start reservation'

export default {
  ...base,
  resolve: { alias: [
    { find: '@agentmux/identity/runtime-source', replacement: new URL('../../identity/dist/runtime-source.js', import.meta.url).pathname },
    ...base.resolve.alias
  ] },
  test: { ...base.test,
    include: ['packages/core/test/durable-direct-resume.test.ts', 'packages/core/test/agent-session-restart.test.ts', 'packages/core/test/retired-session-reopen.test.ts'],
    testNamePattern: recoveryCreationFailurePattern,
    testTimeout: 20_000, hookTimeout: 20_000, passWithNoTests: false, maxWorkers: 1
  }
}
