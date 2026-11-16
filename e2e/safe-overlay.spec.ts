import { test, expect } from '@playwright/test'
import { decodeSafeChannels, isSafeChannel } from '../src/api/r2Contract'
import { dispatchFastTrack, dispatchLevelSafeTree } from '../functions/api/_lib/fastTrack'

/**
 * The safe-list overlay rule and the dispatch that follows a save (ADR-0059). Pure functions and a
 * stubbed `fetch`: no browser, no network.
 */

test.describe('safe overlay rule', () => {
  test('a valid document lists exactly the safe ids; an empty list is valid', () => {
    expect(decodeSafeChannels({ schema: 1, ids: ['a', 'b'] })).toEqual(new Set(['a', 'b']))
    expect(decodeSafeChannels({ schema: 1, ids: [] })).toEqual(new Set())
  })

  test('a bad shape is refused so the published flags stand', () => {
    for (const bad of [null, [], 'x', {}, { schema: 2, ids: [] }, { schema: 1 }, { schema: 1, ids: 'a' }, { schema: 1, ids: ['a', 3] }]) {
      expect(decodeSafeChannels(bad)).toBeNull()
    }
  })

  test('the overlay beats the flag in both directions; no overlay uses the flag', () => {
    const overlay = new Set(['a'])
    expect(isSafeChannel({ id: 'a', safe: false }, overlay)).toBe(true)
    expect(isSafeChannel({ id: 'b', safe: true }, overlay)).toBe(false)
    expect(isSafeChannel({ id: 'b', safe: true }, new Set())).toBe(false)
    expect(isSafeChannel({ id: 'b', safe: true }, null)).toBe(true)
    expect(isSafeChannel({ id: 'b' }, null)).toBe(false)
  })
})

test.describe('dispatch', () => {
  const realFetch = globalThis.fetch
  test.afterEach(() => { globalThis.fetch = realFetch })

  function stub(status: number) {
    const bodies: unknown[] = []
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(null, { status })
    }) as typeof fetch
    return bodies
  }

  test('level-safe-tree sends the event with no payload', async () => {
    const bodies = stub(204)
    expect(await dispatchLevelSafeTree({ GITHUB_DISPATCH_TOKEN: 't' })).toBe('dispatched')
    expect(bodies).toEqual([{ event_type: 'level-safe-tree' }])
  })

  test('a missing token is reported, not thrown; a refusal rejects', async () => {
    const bodies = stub(204)
    expect(await dispatchLevelSafeTree({})).toBe('not-configured')
    expect(bodies).toHaveLength(0)
    stub(403)
    await expect(dispatchLevelSafeTree({ GITHUB_DISPATCH_TOKEN: 't' })).rejects.toThrow(/403/)
  })

  test('fast-track still sends its ids', async () => {
    const bodies = stub(204)
    await dispatchFastTrack({ GITHUB_DISPATCH_TOKEN: 't' }, ['x'])
    expect(bodies).toEqual([{ event_type: 'fast-track-pick', client_payload: { channelIds: ['x'] } }])
  })
})
