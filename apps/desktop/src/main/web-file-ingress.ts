import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { mintObjectId } from '@agentmux/core/object-id'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { isSystemWebFilePath, type SystemWebFileRequest } from '../shared/system-web-file.js'
import { SystemPageIngress, type SystemPageExecutor } from './system-page-ingress.js'

export class WebFileIngress extends SystemPageIngress<SystemWebFileRequest> {
  receive(path: string): void {
    if (!isSystemWebFilePath(path)) { this.issue(`This OS file is not an absolute HTML/XHTML path: ${path}. Existing pages and drafts are kept.`); return }
    this.enqueue({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: mintObjectId(), operation: 'browser.openFileFromSystem', path, url: pathToFileURL(path).href })
  }
  override ready(execute: SystemPageExecutor<SystemWebFileRequest>, report: (message: string) => void): void {
    super.ready(async (request, signal) => {
      // Check the original path at dispatch, without creating/replacing a Browser for an unreadable file.
      if (!(await stat(request.path)).isFile()) throw new Error('The original OS webpage path is not a regular file.')
      await access(request.path, constants.R_OK)
      signal.throwIfAborted()
      return execute(request, signal)
    }, report)
  }
}

/** Register before readiness. argv and open-url never imply a file-open permission. */
export function registerSystemWebFileEvents(app: Pick<Electron.App, 'on'>, files: WebFileIngress, reveal: () => void): void {
  app.on('open-file', (event, path) => { event.preventDefault(); files.receive(path); reveal() })
}
