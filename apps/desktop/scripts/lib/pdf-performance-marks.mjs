import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'

// Private Vite transform for the next shared native proof. Never writes a product source file.
// Read globalThis.__agentmuxPdfPerformance.events from the rendered page after capture.
const helper = `
const __pdfMark = (name, detail = {}) => {
  const trace = globalThis.__agentmuxPdfPerformance ??= {events: [], readers: 0};
  trace.events.push({name, at: performance.now(), ...detail});
};
`
export function pdfPerformanceMarks() {
  const observed = [], sha = source => createHash('sha256').update(source).digest('hex')
  return {name: 'private-pdf-performance-marks', enforce: 'pre', api: {observed}, transform(source, id) {
    const file = id.split('?')[0]
    const pdf = file.endsWith('/packages/editor-extensions/src/pdf/PdfReader.tsx')
    const consumer = file.endsWith('/apps/desktop/src/renderer/src/components/FilePreviewPane.tsx')
    if (!pdf && !consumer) return
    let code = source
    const replace = (before, after) => {
      assert.equal(code.split(before).length - 1, 1, 'One exact private instrumentation anchor: ' + before)
      code = code.replace(before, after)
    }
    if (consumer) {
      replace("const PdfReader = lazy(async () => ({ default: (await import('@agentmux/editor-extensions/pdf')).PdfReader }))", `const PdfReader = lazy(async () => {
        __pdfMark('reader-module-start');
        const module = await import('@agentmux/editor-extensions/pdf');
        __pdfMark('reader-module-ready');
        return {default: module.PdfReader};
      })`)
    } else {
      replace('const lifetime = new AbortController()', `const lifetime = new AbortController()
      const traceReader = ++(globalThis.__agentmuxPdfPerformance ??= {events: [], readers: 0}).readers;
      const mark = (name, detail = {}) => __pdfMark(name, {reader: traceReader, ...detail});
      mark('reader-effect-start');`)
      replace("void import('pdfjs-dist').then(async engine => {", `mark('engine-module-start');
    void import('pdfjs-dist').then(async engine => {
      mark('engine-module-ready');`)
      replace("const components = await import('pdfjs-dist/web/pdf_viewer.mjs')", `mark('viewer-module-start');
      const components = await import('pdfjs-dist/web/pdf_viewer.mjs');
      mark('viewer-module-ready');`)
      replace("reader.currentScaleValue = mode.current === 'custom' ? String(reader.currentScale) : mode.current\n        reader.update()", `mark('layout-update-start');
        reader.currentScaleValue = mode.current === 'custom' ? String(reader.currentScale) : mode.current;
        reader.update();
        mark('layout-update-end');`)
      replace("const listeners = { pagesinit: initialized,", "const listeners = { pagerender: event => mark('page-render-start', {page: event.pageNumber}), pagesinit: initialized,")
      replace("if (event.pageNumber !== reader?.currentPageNumber) return", "mark('page-render-end', {page: event.pageNumber, error: Boolean(event.error)});\n        if (event.pageNumber !== reader?.currentPageNumber) return")
      replace("else update({ phase: 'ready', message: undefined })", `else {
          mark('current-page-ready', {page: event.pageNumber});
          update({ phase: 'ready', message: undefined });
          requestAnimationFrame(() => requestAnimationFrame(() => {if (!disposed) mark('after-two-raf', {page: event.pageNumber})}));
        }`)
      replace('void source.read(begin, end - begin, lifetime.signal).then(bytes => {', `mark('range-start', {begin, end});
          void source.read(begin, end - begin, lifetime.signal).then(bytes => {
            mark('range-end', {begin, end, bytes: bytes.length});`)
      replace('loading = engine.getDocument({', `const originalWorkerCreate = engine.PDFWorker.create;
      engine.PDFWorker.create = function (...args) {
        mark('worker-create-start');
        const worker = originalWorkerCreate.apply(this, args);
        worker.promise.then(() => mark('worker-ready'), () => mark('worker-failed'));
        return worker;
      };
      mark('get-document-start');
      try {
      loading = engine.getDocument({`)
      replace('loading.onPassword = (unlock:', `} finally { engine.PDFWorker.create = originalWorkerCreate }
      mark('get-document-return');
      loading.onPassword = (unlock:`)
      replace('return loading.promise.then(async document => {', "return loading.promise.then(async document => {\n        mark('document-ready');")
      replace('await document.getPage(1)', "mark('first-page-get-start');\n        await document.getPage(1);\n        mark('first-page-get-end');")
      replace('reader.setDocument(document)', "mark('viewer-set-document-start');\n        reader.setDocument(document);\n        mark('viewer-set-document-end');")
    }
    code = helper + code
    observed.push({file, original: sha(source), instrumented: sha(code)})
    return {code, map: null}
  }}
}
