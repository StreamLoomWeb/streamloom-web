/**
 * Feature tips: one short, dismissible line at a time, on this device only. Nothing here is
 * sent anywhere. The ids are shown in this order, at most one tip per session.
 */
export const TIP_IDS = ['surprise', 'sleep', 'keys'] as const
export type TipId = (typeof TIP_IDS)[number]

const KEY = 'sl_tips_seen_v1'
let shownThisSession = false

function readSeen(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** The next unseen tip, or null when all are seen or one was already offered this session. */
export function nextTip(skip: readonly TipId[] = []): TipId | null {
  if (shownThisSession) return null
  const seen = readSeen()
  return TIP_IDS.find((id) => !seen.includes(id) && !skip.includes(id)) ?? null
}

export function markTipShown() {
  shownThisSession = true
}

export function markTipSeen(id: TipId) {
  try {
    const seen = readSeen()
    if (!seen.includes(id)) localStorage.setItem(KEY, JSON.stringify([...seen, id]))
  } catch {
    /* private mode: the tip may come back next session, which is harmless */
  }
}
