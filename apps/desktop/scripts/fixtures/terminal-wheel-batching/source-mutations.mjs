import assert from 'node:assert/strict'
// These mutate the installed production MouseService source before compiling it for Chromium.
// No assertion or fixture consumer is replaced; the same Native oracle observes every candidate.
const replace = (source, before, after) => {
  assert.equal(source.split(before).length - 1, 1, 'Production mutation must own exactly one source site')
  return source.replace(before, after)
}
export function mutateMouseSource(source, mutation) {
  if (mutation === 'source') return source
  if (mutation === 'source-restore-damping') return replace(source,
    '      // A reversed gesture owns its own fractional distance.',
    '      if (Math.abs(ev.deltaY) < 50) amount *= 0.3;\n      // A reversed gesture owns its own fractional distance.')
  if (mutation === 'source-retain-reversal') return replace(source,
    '      if (this._wheelPartialScroll * amount < 0) {\n        this._wheelPartialScroll = 0;\n      }', '')
  if (mutation === 'source-old-distance') return mutateMouseSource(mutateMouseSource(source, 'source-restore-damping'), 'source-retain-reversal')
  if (mutation === 'source-unbatch') {
    source = replace(source, 'this._coreService.triggerBinaryEvent(report.repeat(reportCount));',
      'for (let i = 0; i < reportCount; i++) this._coreService.triggerBinaryEvent(report);')
    source = replace(source, 'this._coreService.triggerDataEvent(report.repeat(reportCount), true);',
      'for (let i = 0; i < reportCount; i++) this._coreService.triggerDataEvent(report, true);')
    return replace(source, 'this._coreService.triggerDataEvent(sequence.repeat(reportCount), true);',
      'for (let i = 0; i < reportCount; i++) this._coreService.triggerDataEvent(sequence, true);')
  }
  if (mutation === 'source-drop-report') return replace(source, 'report.repeat(reportCount), true', 'report.repeat(Math.max(0, reportCount - 1)), true')
  if (mutation === 'source-coordinate-drift') return replace(source, '    e.col++;', '    e.col += 2;')
  if (mutation === 'source-legacy-reencoding') return replace(source,
    'this._coreService.triggerBinaryEvent(report.repeat(reportCount));', 'this._coreService.triggerDataEvent(report.repeat(reportCount), true);')
  if (mutation === 'source-cross-event') return replace(source,
    'this._coreService.triggerDataEvent(report.repeat(reportCount), true);',
    `if (e.button === CoreMouseButton.WHEEL) {
      const owner = this as MouseService & { mergedWheel?: string };
      if (owner.mergedWheel === undefined) {
        owner.mergedWheel = '';
        queueMicrotask(() => { const bytes = owner.mergedWheel!; delete owner.mergedWheel; this._coreService.triggerDataEvent(bytes, true); });
      }
      owner.mergedWheel += report.repeat(reportCount);
    } else this._coreService.triggerDataEvent(report.repeat(reportCount), true);`)
  throw new Error('Unknown production mutation: ' + mutation)
}
