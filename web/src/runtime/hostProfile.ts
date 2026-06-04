export type HostProfile = 'desktop' | 'wiki'

let hostProfile: HostProfile = 'desktop'

export function setHostProfile(profile: HostProfile): void {
  hostProfile = profile
}

export function getHostProfile(): HostProfile {
  return hostProfile
}

export function isWikiHostProfile(): boolean {
  return hostProfile === 'wiki'
}
