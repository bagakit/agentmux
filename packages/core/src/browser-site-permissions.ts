/** Host observations; a page or an Agent cannot manufacture an approval. */
export type BrowserSitePermission = 'camera' | 'microphone' | 'geolocation' | 'notifications'
export type BrowserSitePermissionRequest = {
  requestId: string
  browserId: string
  navigationId: string
  profileId: string | null
  origin: string
  embeddingOrigin: string
  permissions: BrowserSitePermission[]
}
export type BrowserSitePermissionDecision = {
  origin: string
  embeddingOrigin: string
  permission: BrowserSitePermission
  allow: boolean
  scope: 'document' | 'profile'
}
export type BrowserSitePermissionState = {
  requests: BrowserSitePermissionRequest[]
  decisions: BrowserSitePermissionDecision[]
  warning?: string
}
export type BrowserSitePermissionAnswer = {
  requestId: string
  navigationId: string
  allow: boolean
  remember: boolean
}
