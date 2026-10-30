import { isSystemWebUrl, type SystemWebUrlRequest, type SystemWebUrlResult } from '../../../shared/system-web-url'
import { openSystemPageInSurvey, type SystemPageHost } from './survey-system-page'

export async function openSystemUrlInSurvey(host: SystemPageHost, request: SystemWebUrlRequest, signal: AbortSignal): Promise<SystemWebUrlResult> {
  if (!isSystemWebUrl(request.url)) throw new Error('The system link is not a valid HTTP(S) URL. Your current workface is kept.')
  return { ...await openSystemPageInSurvey(host, request, signal), operation: request.operation, requestId: request.requestId }
}
