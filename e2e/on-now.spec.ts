import { test, expect } from '@playwright/test'
import { decodeEpgSummary } from '../src/api/r2Contract'
import type { SummaryProgramme } from '../src/api/r2Contract'
import { onNowForRow, programmeOnAir } from '../src/util/onNow'
import { channelAffinity, compareAffinity } from '../src/util/sessionAffinity'

/**
 * Category rows' "live now" strip (feasibility study recs. 1 and 2): the guide
 * summary decode, the on-air join and the session-affinity ranking. Pure code,
 * no browser.
 */

const GEN = 1_757_000_000_000
const MIN = 60_000

test.describe('decodeEpgSummary', () => {
  test('drops a malformed row or programme alone, never the whole object', () => {
    const decoded = decodeEpgSummary([
      ['a', [[0, 30, 'Ok'], [30, 0, 'zero length'], ['1', 30, 'string offset'], [60, 30, 7]]],
      ['', [[0, 30, 'no id']]],
      'junk',
      ['b', 'not a list'],
      ['c', []],
      ['d', [[-15, 60, 'Airing at publish']]],
    ])
    expect(decoded && [...decoded]).toEqual([
      ['a', [[0, 30, 'Ok']]],
      ['d', [[-15, 60, 'Airing at publish']]],
    ])
    expect(decodeEpgSummary({})).toBeNull()
  })
})

test.describe('programmeOnAir', () => {
  const programmes: SummaryProgramme[] = [[-15, 60, 'First'], [45, 30, 'Second']]

  test('start inclusive, end exclusive, negative offsets allowed', () => {
    expect(programmeOnAir(programmes, GEN, GEN - 15 * MIN)?.title).toBe('First')
    expect(programmeOnAir(programmes, GEN, GEN + 44 * MIN)?.title).toBe('First')
    expect(programmeOnAir(programmes, GEN, GEN + 45 * MIN)?.title).toBe('Second')
    expect(programmeOnAir(programmes, GEN, GEN + 75 * MIN)).toBeNull()
    expect(programmeOnAir(programmes, GEN, GEN - 16 * MIN)).toBeNull()
    expect(programmeOnAir(undefined, GEN, GEN)).toBeNull()
  })

  test('reports when the programme ends', () => {
    expect(programmeOnAir(programmes, GEN, GEN)?.endsAt).toBe(GEN + 45 * MIN)
  })
})

test.describe('session affinity', () => {
  test('outranks the curated order only past the threshold, and never filters', () => {
    expect(compareAffinity(1, 0)).toBe(0)
    expect(compareAffinity(0, 1)).toBe(0)
    expect(compareAffinity(2, 1)).toBeLessThan(0)
    expect(compareAffinity(1, 3)).toBeGreaterThan(0)
    expect(compareAffinity(4, 4)).toBe(0)
  })

  test('ignores the row\'s own category', () => {
    const affinity = new Map([['sports', 5], ['news', 2]])
    expect(channelAffinity(['sports', 'news'], affinity, 'sports')).toBe(2)
    expect(channelAffinity(['sports', 'news'], affinity)).toBe(7)
  })
})

test.describe('onNowForRow', () => {
  const ch = (id: string, categoryIds: string[]) => ({ id, categoryIds })
  const row = [ch('one', ['sports']), ch('two', ['sports', 'news']), ch('three', ['sports', 'kids']), ch('off', ['sports'])]
  const summary = new Map<string, SummaryProgramme[]>([
    ['one', [[0, 60, 'Match']]],
    ['two', [[0, 60, 'Sports desk']]],
    ['three', [[0, 60, 'Junior league']]],
    ['off', [[90, 60, 'Later']]],
  ])

  test('keeps the row order with no affinity, and leaves out what is not on air', () => {
    const live = onNowForRow(row, 'sports', summary, GEN, GEN + 10 * MIN, new Map())
    expect(live.map((e) => e.channel.id)).toEqual(['one', 'two', 'three'])
    expect(live[0].title).toBe('Match')
  })

  test('moves a channel up once its other categories clear the threshold', () => {
    const once = onNowForRow(row, 'sports', summary, GEN, GEN, new Map([['kids', 1]]))
    expect(once.map((e) => e.channel.id)).toEqual(['one', 'two', 'three'])
    const twice = onNowForRow(row, 'sports', summary, GEN, GEN, new Map([['kids', 2], ['sports', 9]]))
    expect(twice.map((e) => e.channel.id)).toEqual(['three', 'one', 'two'])
  })
})
