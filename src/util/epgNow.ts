import type { EpgProgram } from '../api/types'

export function getCurrentProgram(programs: EpgProgram[], nowMs: number): EpgProgram | undefined {
  return programs.find((p) => {
    const start = new Date(p.start_time).getTime()
    const end = new Date(p.end_time).getTime()
    return nowMs >= start && nowMs < end
  })
}

export function getNextProgram(programs: EpgProgram[], nowMs: number): EpgProgram | undefined {
  return programs.find((p) => new Date(p.start_time).getTime() > nowMs)
}

/** Fraction of `program` elapsed at `nowMs`, clamped to [0, 1]. */
export function programProgress(program: EpgProgram, nowMs: number): number {
  const start = new Date(program.start_time).getTime()
  const end = new Date(program.end_time).getTime()
  if (end <= start) return 0
  return Math.min(1, Math.max(0, (nowMs - start) / (end - start)))
}
