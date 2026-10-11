import ts from 'typescript'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vitest/config'
import current from './renderer-v8-profile.config.mts'
export default defineConfig({
  ...current,
  cacheDir: '.cache/performance-scene',
  plugins: [
    ...(current.plugins ?? []),
    {
      name: 'scene-resource-boundary-source-inverse',
      enforce: 'pre',
      transform(code, id) {
        if (
          process.env.AGENTMUX_SCENE_UNIT_MUTATION !== 'resource-fence' ||
          !id.endsWith('/renderer-performance-scene.ts')
        )
          return
        const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true),
          owner = source.statements.find(
            (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'parseRendererSceneResources'
          )
        if (!owner || !ts.isFunctionDeclaration(owner) || !owner.body)
          throw new Error('Actual resource owner inverse anchor is absent')
        const declarations = owner.body.statements.flatMap((node) =>
          ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []
        )
        const binding = declarations.find((node) => node.name.getText(source) === 'matches')
        if (!binding?.initializer || !ts.isArrowFunction(binding.initializer))
          throw new Error('Actual resource identity predicate inverse is absent')
        const body = binding.initializer.body,
          result = code.slice(0, body.getStart(source)) + 'true' + code.slice(body.end)
        if (process.env.AGENTMUX_SCENE_UNIT_LOADED)
          appendFileSync(
            process.env.AGENTMUX_SCENE_UNIT_LOADED,
            JSON.stringify({
              owner: id,
              originalSHA256: createHash('sha256').update(code).digest('hex'),
              loadedSHA256: createHash('sha256').update(result).digest('hex'),
              mutation: 'resource-fence',
              applied: true
            }) + '\n'
          )
        return { code: result, map: null }
      }
    }
  ],
  test: { ...current.test, include: ['apps/desktop/test/performance-scene.test.ts'], testTimeout: 15000 }
})
