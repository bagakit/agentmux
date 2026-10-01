const scope = process.argv[process.argv.indexOf('--scope') + 1]
if (scope === 'adjacent-paths' || scope === 'metadata-paths') await import('./verify-project-path-mutations.mjs')
else if (scope === 'explorer') await import('./verify-explorer-interaction-mutations.mjs')
else if (scope === 'history') await import('./verify-git-history-mutations.mjs')
else if (scope === 'integration') await import('./verify-explorer-integration-mutations.mjs')
else throw new Error(`Unknown Explorer mutation scope: ${scope}`)
