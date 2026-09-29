import { useEffect, useState } from 'react'
import type { EnrichedChannel } from '../hooks/useChannels'
import { useEpg } from '../hooks/useChannels'
import { getCurrentProgram, getNextProgram, programProgress } from '../util/epgNow'
import { LOGO_SIZE, logoUrl, handleLogoError } from '../util/logo'
import { getTranslation, requestTranslations, useTranslateEnabled } from '../util/translate'

/**
 * Preview card for the channel a viewer has rested on in the player's guide drawer: logo and
 * now/next only. It plays nothing and opens no second video; the caller warms the connection
 * through `src/util/preconnect.ts`.
 */
export function FlipPreview({ channel }: { channel: EnrichedChannel }) {
  const { programs } = useEpg(channel.id)
  const [now] = useState(() => Date.now())
  const current = getCurrentProgram(programs, now)
  const next = current ? getNextProgram(programs, now) : undefined
  const translate = useTranslateEnabled()
  useEffect(() => {
    if (!translate) return
    const titles = [current?.title, next?.title].filter((t): t is string => !!t)
    if (titles.length) requestTranslations(titles)
  }, [translate, current, next])
  const show = (t: string) => (translate && getTranslation(t)) || t
  const logo = logoUrl(channel.logo)

  return (
    <div className="player__flip" aria-live="polite">
      <div className="player__flip-head">
        {logo && (
          <img src={logo} alt="" width={LOGO_SIZE} height={LOGO_SIZE} decoding="async" onError={handleLogoError} className="player__flip-logo" />
        )}
        <strong className="player__flip-name">{channel.name}</strong>
      </div>
      {current ? (
        <>
          <p className="player__flip-now">Now: {show(current.title)}</p>
          <div className="player__flip-bar" aria-hidden="true">
            <span style={{ width: `${Math.round(programProgress(current, now) * 100)}%` }} />
          </div>
          {next && <p className="player__flip-next">Next: {show(next.title)}</p>}
        </>
      ) : (
        <p className="player__flip-next">No schedule for this channel</p>
      )}
    </div>
  )
}
