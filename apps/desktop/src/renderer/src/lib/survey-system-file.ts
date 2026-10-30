import { isSystemWebFileRequest, type SystemWebFileRequest, type SystemWebFileResult } from '../../../shared/system-web-file'
import { openSystemPageInSurvey, type SystemPageHost } from './survey-system-page'

export async function openSystemFileInSurvey(host: SystemPageHost, request: SystemWebFileRequest, signal: AbortSignal): Promise<SystemWebFileResult> {
  if (!isSystemWebFileRequest(request)) throw new Error('The original OS webpage file address is invalid. Existing pages and drafts are kept.')
  return { ...await openSystemPageInSurvey(host, request, signal), operation: request.operation, requestId: request.requestId }
}
