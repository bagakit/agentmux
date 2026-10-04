import { parse, type Spec, type Runtime } from 'vega'
import { compile, type TopLevelSpec } from 'vega-lite'

export type VegaMode = 'vega' | 'vega-lite'

/** This CPU work runs in a terminatable Worker, never in the App Renderer. */
export function compileVegaRuntime(content: string, mode: VegaMode): Runtime {
  const input = JSON.parse(content)
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a Vega chart specification.')
  if (typeof input.$schema === 'string') {
    const schemaMode = /^https?:\/\/vega\.github\.io\/schema\/vega-lite\/v[\d.]+\.json$/.test(input.$schema) ? 'vega-lite'
      : /^https?:\/\/vega\.github\.io\/schema\/vega\/v[\d.]+\.json$/.test(input.$schema) ? 'vega' : undefined
    if (schemaMode !== mode) throw new Error('The chart schema does not match this file format.')
  }
  const spec = mode === 'vega-lite' ? compile(input as TopLevelSpec).spec : input as Spec
  return parse(spec, undefined, { ast: true })
}
