/** Private Node harness only: unrelated image/resource APIs must never be exercised. */
const unavailable = (): never => { throw new Error('The schedule harness does not operate Electron surfaces.') }
export const nativeImage = { createFromBuffer: unavailable, createFromPath: unavailable }
export const app = { getAppMetrics: unavailable, getPath: unavailable }
