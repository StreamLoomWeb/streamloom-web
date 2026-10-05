/** The third-party libraries the web app ships, for Settings → About → Open-Source Licences. */
export interface Licence {
  name: string
  licence: string
}

export const LICENCES: readonly Licence[] = [
  { name: 'hls.js', licence: 'Apache License 2.0' },
  { name: 'mpegts.js', licence: 'Apache License 2.0' },
  { name: 'React and React DOM', licence: 'MIT License' },
  { name: 'React Router', licence: 'MIT License' },
]

export const SUPPORT_EMAIL = 'support@softarchium.com'

/** The same subject and body template the app's Report a Channel row opens. */
export const REPORT_CHANNEL_HREF =
  `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Streamloom: channel report')}` +
  `&body=${encodeURIComponent('Channel name:\nCountry:\nWhat is wrong:\n')}`
