export const createFormatWorker = () => new Worker(new URL('./format-worker.ts', import.meta.url), { type: 'module' })
export const createDotWorker = () => new Worker(new URL('./dot-worker.ts', import.meta.url), { type: 'module' })
export const createNotebookWorker = () => new Worker(new URL('./data-notebook.worker.ts', import.meta.url), { type: 'module' })
