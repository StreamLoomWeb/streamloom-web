import { useEffect, useMemo, useState } from 'react'
import {
  K_ANON,
  bucketLabel,
  isoWeekKey,
  monthKey,
  type BucketKind,
} from '../../functions/api/_lib/telemetryContract'
import './Admin.css'
import './Analytics.css'

/**
 * The owner's analytics dashboard (ADR-0047, WO-22), at `/admin/analytics`.
 *
 * Under the same Cloudflare Access application as `/admin` (`admin/*`). Everything on this page
 * comes from `/api/stats`, which verifies the Access JWT itself; the page holds no credential
 * and, signed out, shows only that it is signed out. One reader, so it is plain: a headline row,
 * a few one-hue sparklines and histograms, and a table under every chart so no number is
 * carried by colour alone.
 *
 * What the numbers are: installs, not people (a cleared browser is a new install); percentiles
 * from histograms are bounds ("p95 < 2 s"); watch time is an estimate from bucket midpoints;
 * a country or region under `K_ANON` opens shows folded (`ZZ` / `*`), which means "fewer than
 * 20 opens there that day", not "nobody".
 */

type Phase = 'loading' | 'ready' | 'unauthorised' | 'unavailable' | 'failed'

interface DailyRow {
  day: string
  platform: string
  appOpens: number
  dau: number
  wau: number
  mau: number
  installs: number
  plays: number
  playFails: number
  playEnds: number
  guideOpens: number
  searches: number
  zeroSearches: number
  points: number
  source: 'wae' | 'd1'
}

interface PerfPanel {
  metric: string
  kind: BucketKind
  edges: number[]
  counts: number[]
  total: number
  p50: number | null
  p95: number | null
  p99: number | null
}

interface Stats {
  generatedAt: string
  contract: number
  windows: { headlineDays: number; waeDays: number; seriesDays: number }
  sources: {
    wae: { ok: boolean; error?: string; queries: number; truncated: string[] }
    d1: { ok: boolean; error?: string; rowsRead: number }
  }
  today: { day: string; appOpens: number; dau: number; installs: number; plays: number; playFails: number; playEnds: number; guideOpens: number; searches: number; points: number }
  daily: DailyRow[]
  hours: { hour: number; appOpens: number; plays: number }[]
  geo: { rows: { platform: string; country: string; region: string; app_opens: number; plays: number; play_fails: number }[]; kAnon: number; days: number; truncated: boolean }
  channels: { platform: string; channelId: string; plays: number; playFails: number; successRate: number | null; playEnds: number; watchBuckets: number[]; watchEstMin: number }[]
  errorClasses: { errorClass: string; n: number }[]
  perf: PerfPanel[]
  vsf: { plays: number; playFails: number; rate: number | null }
  ebvs: { playEnds: number; exits: number; share: number | null }
  watch: { playEnds: number; estMinutes: number; buckets: number[]; edges: number[] }
  search: { total: number; zero: number; zeroShare: number | null }
  health: { candidates: number; k: number; minHours: number; cap: number; windowHours: number; streams: { streamKey: string; channelId: string; playFails: number; hours: number }[] }
  budget: {
    waePointsToday: number
    waePointsPeakDay: number
    waeReadsPerUncachedLoad: number
    waeReadsPerDayIfUncached: number
    d1RowsReadPerLoad: number
    d1RowsWrittenLastRollup: number | null
    lastRollup: { day: string; ranAt: string; points: number; rowsWritten: number; reportsListed: number } | null
    caps: { waePointsPerDay: number; waeReadsPerDay: number; d1RowsReadPerDay: number; d1RowsWrittenPerDay: number; workersRequestsPerDay: number; rule: number }
  }
  queries: Record<string, string>
}

const fmt = (n: number | null | undefined): string => (n == null ? '—' : n.toLocaleString('en-GB'))
const pct = (x: number | null | undefined, digits = 1): string => (x == null ? '—' : `${(x * 100).toFixed(digits)}%`)

/** A percentile from a histogram is a bound: "< 2 s", or ">= 15 s" past the last edge. */
function bound(kind: BucketKind, value: number | null, edges: number[]): string {
  if (value === null) return '—'
  if (value === Infinity) return `≥ ${bucketLabel(kind, edges.length).replace('>=', '')}`
  const unit = kind === 'ratio' ? `${Math.round(value * 1000) / 10}%` : value >= 1000 ? `${value / 1000} s` : `${value} ms`
  return `< ${unit}`
}

/** Sums the series across platforms into one row per day. */
function byDay(daily: DailyRow[]): DailyRow[] {
  const map = new Map<string, DailyRow>()
  for (const r of daily) {
    const cur = map.get(r.day)
    if (!cur) {
      map.set(r.day, { ...r, platform: 'all' })
      continue
    }
    cur.appOpens += r.appOpens
    cur.dau += r.dau
    cur.wau += r.wau
    cur.mau += r.mau
    cur.installs += r.installs
    cur.plays += r.plays
    cur.playFails += r.playFails
    cur.playEnds += r.playEnds
    cur.guideOpens += r.guideOpens
    cur.searches += r.searches
    cur.zeroSearches += r.zeroSearches
    cur.points += r.points
  }
  return [...map.values()].sort((a, b) => a.day.localeCompare(b.day))
}

function sumBy<T>(rows: T[], key: (r: T) => string, value: (r: T) => number): { key: string; value: number }[] {
  const map = new Map<string, number>()
  for (const r of rows) map.set(key(r), (map.get(key(r)) ?? 0) + value(r))
  return [...map.entries()].map(([k, v]) => ({ key: k, value: v })).sort((a, b) => a.key.localeCompare(b.key))
}

// ---- Small charts: one hue (the theme accent), thin marks, a title per mark for hover ----

function Sparkline({ points, label }: { points: { key: string; value: number }[]; label: string }) {
  const w = 240
  const h = 48
  if (points.length === 0) return <div className="an-empty">No data yet</div>
  const max = Math.max(1, ...points.map((p) => p.value))
  const step = points.length > 1 ? w / (points.length - 1) : 0
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - (p.value / max) * (h - 4) - 2).toFixed(1)}`).join(' ')
  const last = points[points.length - 1]
  return (
    <svg className="an-spark" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${label}, ${points.length} points, latest ${last.value}`}>
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => (
        <circle key={p.key} cx={i * step} cy={h - (p.value / max) * (h - 4) - 2} r="5" fill="transparent">
          <title>{`${p.key}: ${fmt(p.value)}`}</title>
        </circle>
      ))}
    </svg>
  )
}

function Bars({ values, labels, title }: { values: number[]; labels: string[]; title: string }) {
  const max = Math.max(1, ...values)
  const total = values.reduce((a, b) => a + b, 0)
  return (
    <div className="an-bars" role="img" aria-label={title}>
      {values.map((v, i) => (
        <div className="an-bar" key={labels[i]} title={`${labels[i]}: ${fmt(v)}${total ? ` (${pct(v / total)})` : ''}`}>
          <div className="an-bar__fill" style={{ height: `${Math.max(v > 0 ? 3 : 0, (v / max) * 100)}%` }} />
          <span className="an-bar__label">{labels[i]}</span>
        </div>
      ))}
    </div>
  )
}

function Budget({ label, used, cap, rule, unit }: { label: string; used: number | null; cap: number; rule: number; unit: string }) {
  const share = used == null ? null : used / cap
  const state = share == null ? 'unknown' : share >= rule ? 'over' : share >= rule * 0.875 ? 'near' : 'ok'
  return (
    <div className={`an-budget an-budget--${state}`}>
      <div className="an-budget__row">
        <span>{label}</span>
        <span>
          {fmt(used)} / {fmt(cap)} {unit} · {pct(share, 2)} of cap
          {state === 'over' ? ' · over the 80% rule ⚠' : state === 'near' ? ' · approaching 80% ●' : state === 'ok' ? ' · within budget ✓' : ''}
        </span>
      </div>
      <div className="an-budget__track">
        <div className="an-budget__rule" style={{ left: `${rule * 100}%` }} />
        <div className="an-budget__fill" style={{ width: `${Math.min(100, (share ?? 0) * 100)}%` }} />
      </div>
    </div>
  )
}

export function Analytics() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [stats, setStats] = useState<Stats | null>(null)
  const [detail, setDetail] = useState<string>('')
  const [reloadNonce, setReloadNonce] = useState(0)

  useEffect(() => {
    document.title = 'StreamLoom · Analytics'
    const robots = document.createElement('meta')
    robots.name = 'robots'
    robots.content = 'noindex, nofollow'
    document.head.appendChild(robots)
    return () => {
      robots.remove()
    }
  }, [])

  useEffect(() => {
    const ctl = new AbortController()
    fetch('/api/stats', { credentials: 'same-origin', cache: 'no-store', signal: ctl.signal })
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) {
          setPhase('unauthorised')
          return
        }
        if (res.status === 503) {
          setPhase('unavailable')
          return
        }
        if (!res.ok) {
          setDetail(`HTTP ${res.status}`)
          setPhase('failed')
          return
        }
        setStats((await res.json()) as Stats)
        setPhase('ready')
      })
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return
        setDetail(err instanceof Error ? err.message : 'request failed')
        setPhase('failed')
      })
    return () => ctl.abort()
  }, [reloadNonce])

  const days = useMemo(() => (stats ? byDay(stats.daily) : []), [stats])
  const weeks = useMemo(() => sumBy(days, (r) => isoWeekKey(r.day + 'T00:00:00Z'), (r) => r.wau), [days])
  const months = useMemo(() => sumBy(days, (r) => monthKey(r.day + 'T00:00:00Z'), (r) => r.mau), [days])
  const stickiness = useMemo(() => {
    const dauByMonth = new Map<string, number[]>()
    for (const r of days) {
      const m = monthKey(r.day + 'T00:00:00Z')
      dauByMonth.set(m, [...(dauByMonth.get(m) ?? []), r.dau])
    }
    return months.map((m) => {
      const daus = dauByMonth.get(m.key) ?? []
      const mean = daus.length ? daus.reduce((a, b) => a + b, 0) / daus.length : 0
      return { key: m.key, value: m.value > 0 ? Math.round((mean / m.value) * 1000) / 10 : 0 }
    })
  }, [days, months])

  if (phase === 'loading') return <div className="admin"><p className="admin__status">Loading analytics…</p></div>
  if (phase === 'unauthorised') {
    return (
      <div className="admin">
        <h1 className="admin__heading">Analytics</h1>
        <p className="admin__problem">
          This browser is not signed in through Cloudflare Access, so <code>/api/stats</code> answered 401. Open
          the page through the Access-protected hostname and sign in; nothing on this page is readable without it.
        </p>
      </div>
    )
  }
  if (phase === 'unavailable') {
    return (
      <div className="admin">
        <h1 className="admin__heading">Analytics</h1>
        <p className="admin__problem">
          The Access configuration for this project is missing or its signing keys could not be read (503). Nothing
          is shown until the owner steps in the README are complete.
        </p>
      </div>
    )
  }
  if (phase === 'failed' || !stats) {
    return (
      <div className="admin">
        <h1 className="admin__heading">Analytics</h1>
        <p className="admin__problem">Could not load the statistics ({detail}).</p>
        <button className="admin__btn" onClick={() => setReloadNonce((n) => n + 1)}>Try again</button>
      </div>
    )
  }

  const s = stats
  const last30 = days.slice(-s.windows.headlineDays)
  const vst = s.perf.find((p) => p.metric === 'video_start_time')
  const rebuffer = s.perf.find((p) => p.metric === 'rebuffer_ratio')
  const catalogueLoad = s.perf.find((p) => p.metric === 'catalogue_load')
  const guideOpen = s.perf.find((p) => p.metric === 'guide_open')
  const hourMax = Math.max(1, ...s.hours.map((h) => h.appOpens))

  return (
    <div className="admin an">
      <header className="an-head">
        <div>
          <h1 className="admin__heading">Analytics</h1>
          <p className="admin__sub">
            Aggregate counts, no identifier (ADR-0032/0047). Installs, not people. Generated {new Date(s.generatedAt).toUTCString()}, cached ten minutes.
          </p>
        </div>
        <button className="admin__btn" onClick={() => setReloadNonce((n) => n + 1)}>Reload</button>
      </header>

      {(!s.sources.wae.ok || !s.sources.d1.ok) && (
        <ul className="admin__warnings">
          {!s.sources.wae.ok && <li>Analytics Engine: {s.sources.wae.error ?? 'unavailable'} — the last {s.windows.waeDays} days are missing from every panel.</li>}
          {!s.sources.d1.ok && <li>D1: {s.sources.d1.error ?? 'unavailable'} — days older than {s.windows.waeDays} are missing from the series.</li>}
          {s.sources.wae.truncated.length > 0 && <li>Row limit reached for: {s.sources.wae.truncated.join(', ')} — those panels may be incomplete.</li>}
        </ul>
      )}

      <section className="an-tiles" aria-label="Today so far (UTC)">
        {[
          ['App opens today', s.today.appOpens],
          ['Daily active (first open today)', s.today.dau],
          ['New installs today', s.today.installs],
          ['Plays today', s.today.plays],
          ['Play failures today', s.today.playFails],
          ['Guide opens today', s.today.guideOpens],
          ['Searches today', s.today.searches],
          ['Data points today', s.today.points],
        ].map(([label, value]) => (
          <div className="an-tile" key={String(label)}>
            <span className="an-tile__value">{fmt(value as number)}</span>
            <span className="an-tile__label">{label}</span>
          </div>
        ))}
      </section>

      <section className="an-grid">
        <div className="an-card">
          <h2>Daily active installs (DAU)</h2>
          <Sparkline points={last30.map((r) => ({ key: r.day, value: r.dau }))} label="DAU" />
          <p className="an-note">Last {s.windows.headlineDays} days · {last30.length ? `latest ${fmt(last30[last30.length - 1].dau)}` : 'no data'}</p>
        </div>
        <div className="an-card">
          <h2>Weekly active (WAU)</h2>
          <Sparkline points={weeks.slice(-16)} label="WAU" />
          <p className="an-note">Per ISO week · {weeks.length ? `latest ${fmt(weeks[weeks.length - 1].value)}` : 'no data'}</p>
        </div>
        <div className="an-card">
          <h2>Monthly active (MAU)</h2>
          <Sparkline points={months.slice(-12)} label="MAU" />
          <p className="an-note">Per calendar month · {months.length ? `latest ${fmt(months[months.length - 1].value)}` : 'no data'}</p>
        </div>
        <div className="an-card">
          <h2>Stickiness (mean DAU ÷ MAU)</h2>
          <Sparkline points={stickiness.slice(-12)} label="Stickiness, percent" />
          <p className="an-note">{stickiness.length ? `latest ${stickiness[stickiness.length - 1].value}%` : 'no data'}</p>
        </div>
        <div className="an-card">
          <h2>New installs</h2>
          <Sparkline points={last30.map((r) => ({ key: r.day, value: r.installs }))} label="New installs" />
          <p className="an-note">First-ever opens per day · {fmt(last30.reduce((a, r) => a + r.installs, 0))} in {s.windows.headlineDays} days</p>
        </div>
        <div className="an-card">
          <h2>Hour of day (UTC), app opens</h2>
          <div className="an-hours" role="img" aria-label="App opens by hour of day">
            {s.hours.map((h) => (
              <div className="an-hour" key={h.hour} title={`${String(h.hour).padStart(2, '0')}:00 — opens ${fmt(h.appOpens)}, plays ${fmt(h.plays)}`}>
                <div className="an-hour__fill" style={{ height: `${(h.appOpens / hourMax) * 100}%` }} />
                {h.hour % 6 === 0 && <span className="an-hour__label">{String(h.hour).padStart(2, '0')}</span>}
              </div>
            ))}
          </div>
          <p className="an-note">Last {s.windows.headlineDays} days, receipt time truncated to the hour.</p>
        </div>
      </section>

      <section className="an-grid an-grid--wide">
        <div className="an-card">
          <h2>Countries and regions</h2>
          <p className="an-note">
            Last {s.geo.days} days, folded at {s.geo.kAnon} opens per day (ADR-0047): <code>ZZ</code> / <code>*</code> means “fewer than {K_ANON} opens there that day”, not “nobody”.
          </p>
          <table className="an-table">
            <thead><tr><th>Platform</th><th>Country</th><th>Region</th><th>App opens</th><th>Plays</th><th>Play failures</th></tr></thead>
            <tbody>
              {s.geo.rows.slice(0, 60).map((r) => (
                <tr key={`${r.platform}-${r.country}-${r.region}`}>
                  <td>{r.platform}</td><td>{r.country}</td><td>{r.region}</td><td>{fmt(r.app_opens)}</td><td>{fmt(r.plays)}</td><td>{fmt(r.play_fails)}</td>
                </tr>
              ))}
              {s.geo.rows.length === 0 && <tr><td colSpan={6} className="an-empty">No data yet</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="an-card">
          <h2>Top channels</h2>
          <p className="an-note">Last {s.windows.headlineDays} days by plays. Success rate is 1 − failures ÷ plays; watch time is an <em>estimate</em> from bucket midpoints.</p>
          <table className="an-table">
            <thead><tr><th>Channel</th><th>Platform</th><th>Plays</th><th>Success</th><th>Ends</th><th>Watch est. (min)</th><th>Watch buckets</th></tr></thead>
            <tbody>
              {s.channels.map((c) => (
                <tr key={`${c.platform}-${c.channelId}`}>
                  <td className="an-mono">{c.channelId}</td><td>{c.platform}</td><td>{fmt(c.plays)}</td><td>{pct(c.successRate)}</td><td>{fmt(c.playEnds)}</td><td>{fmt(c.watchEstMin)}</td>
                  <td className="an-mono" title={c.watchBuckets.map((n, i) => `${bucketLabel('watch', i)}: ${n}`).join('\n')}>{c.watchBuckets.join(' · ')}</td>
                </tr>
              ))}
              {s.channels.length === 0 && <tr><td colSpan={7} className="an-empty">No data yet</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="an-grid">
        <div className="an-card">
          <h2>Video start time (VST)</h2>
          {vst && (
            <>
              <dl className="an-kv">
                <dt>p50</dt><dd>{bound('latency', vst.p50, vst.edges)}</dd>
                <dt>p95</dt><dd>{bound('latency', vst.p95, vst.edges)}</dd>
                <dt>p99</dt><dd>{bound('latency', vst.p99, vst.edges)}</dd>
                <dt>Samples</dt><dd>{fmt(vst.total)}</dd>
              </dl>
              <Bars values={vst.counts} labels={vst.counts.map((_, i) => bucketLabel('latency', i))} title="Video start time distribution" />
            </>
          )}
          <p className="an-note">Percentiles from a histogram are bounds, printed as such.</p>
        </div>
        <div className="an-card">
          <h2>Video start failure (VSF)</h2>
          <dl className="an-kv">
            <dt>Rate</dt><dd>{pct(s.vsf.rate, 2)}</dd>
            <dt>Plays</dt><dd>{fmt(s.vsf.plays)}</dd>
            <dt>Failures</dt><dd>{fmt(s.vsf.playFails)}</dd>
          </dl>
          <table className="an-table an-table--compact">
            <thead><tr><th>Error class</th><th>Count</th></tr></thead>
            <tbody>
              {s.errorClasses.map((e) => <tr key={e.errorClass}><td className="an-mono">{e.errorClass}</td><td>{fmt(e.n)}</td></tr>)}
              {s.errorClasses.length === 0 && <tr><td colSpan={2} className="an-empty">No failures recorded</td></tr>}
            </tbody>
          </table>
          <p className="an-note">Stream faults only: a viewer's own network never counts (ADR-0032).</p>
        </div>
        <div className="an-card">
          <h2>Rebuffering ratio</h2>
          {rebuffer && (
            <>
              <dl className="an-kv">
                <dt>p50</dt><dd>{bound('ratio', rebuffer.p50, rebuffer.edges)}</dd>
                <dt>p95</dt><dd>{bound('ratio', rebuffer.p95, rebuffer.edges)}</dd>
                <dt>Samples</dt><dd>{fmt(rebuffer.total)}</dd>
              </dl>
              <Bars values={rebuffer.counts} labels={rebuffer.counts.map((_, i) => bucketLabel('ratio', i))} title="Rebuffering ratio distribution" />
            </>
          )}
        </div>
        <div className="an-card">
          <h2>Exit before video start (EBVS)</h2>
          <dl className="an-kv">
            <dt>Share</dt><dd>{pct(s.ebvs.share, 2)}</dd>
            <dt>Play ends</dt><dd>{fmt(s.ebvs.playEnds)}</dd>
            <dt>Under one second</dt><dd>{fmt(s.ebvs.exits)}</dd>
            <dt>Watch time (est.)</dt><dd>{fmt(s.watch.estMinutes)} min</dd>
          </dl>
          <Bars values={s.watch.buckets} labels={s.watch.buckets.map((_, i) => bucketLabel('watch', i))} title="Watch time distribution" />
        </div>
        <div className="an-card">
          <h2>Search</h2>
          <dl className="an-kv">
            <dt>Searches</dt><dd>{fmt(s.search.total)}</dd>
            <dt>Zero results</dt><dd>{fmt(s.search.zero)}</dd>
            <dt>Zero-result share</dt><dd>{pct(s.search.zeroShare)}</dd>
          </dl>
          <Sparkline points={last30.map((r) => ({ key: r.day, value: r.searches }))} label="Searches per day" />
          <p className="an-note">The query text is never sent; only whether it found nothing.</p>
        </div>
        <div className="an-card">
          <h2>Other latencies</h2>
          <dl className="an-kv">
            {catalogueLoad && (<><dt>Catalogue p95</dt><dd>{bound('latency', catalogueLoad.p95, catalogueLoad.edges)} ({fmt(catalogueLoad.total)})</dd></>)}
            {guideOpen && (<><dt>Guide p95</dt><dd>{bound('latency', guideOpen.p95, guideOpen.edges)} ({fmt(guideOpen.total)})</dd></>)}
          </dl>
        </div>
      </section>

      <section className="an-grid an-grid--wide">
        <div className="an-card">
          <h2>Streams over the health threshold</h2>
          <p className="an-note">
            Trailing {s.health.windowHours} h: at least {s.health.k} failures over at least {s.health.minHours} distinct hours, pinned channels excluded, at most {s.health.cap} listed.
            {' '}{fmt(s.health.candidates)} qualify now. A probe decides; nothing here changes what viewers see (ADR-0032).
          </p>
          <table className="an-table an-table--compact">
            <thead><tr><th>Stream key</th><th>Channel</th><th>Failures</th><th>Hours</th></tr></thead>
            <tbody>
              {s.health.streams.map((h) => <tr key={h.streamKey}><td className="an-mono">{h.streamKey}</td><td className="an-mono">{h.channelId}</td><td>{fmt(h.playFails)}</td><td>{h.hours}</td></tr>)}
              {s.health.streams.length === 0 && <tr><td colSpan={4} className="an-empty">None over the threshold</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="an-card">
          <h2>Free-tier budget (owner's 80% rule)</h2>
          <Budget label="WAE data points, today" used={s.budget.waePointsToday} cap={s.budget.caps.waePointsPerDay} rule={s.budget.caps.rule} unit="points" />
          <Budget label="WAE data points, busiest day in the series" used={s.budget.waePointsPeakDay} cap={s.budget.caps.waePointsPerDay} rule={s.budget.caps.rule} unit="points" />
          <Budget label="WAE SQL reads this dashboard could cause in a day" used={s.budget.waeReadsPerDayIfUncached} cap={s.budget.caps.waeReadsPerDay} rule={s.budget.caps.rule} unit="queries" />
          <Budget label="D1 rows read per uncached dashboard load" used={s.budget.d1RowsReadPerLoad} cap={s.budget.caps.d1RowsReadPerDay} rule={s.budget.caps.rule} unit="rows" />
          <Budget label="D1 rows written by the last rollup" used={s.budget.d1RowsWrittenLastRollup} cap={s.budget.caps.d1RowsWrittenPerDay} rule={s.budget.caps.rule} unit="rows" />
          <p className="an-note">
            {s.budget.lastRollup
              ? `Last rollup: ${s.budget.lastRollup.day}, ran ${s.budget.lastRollup.ranAt}, ${fmt(s.budget.lastRollup.points)} points, ${fmt(s.budget.lastRollup.reportsListed)} streams listed.`
              : 'No rollup has written to D1 yet.'}
            {' '}Each uncached load issues {s.budget.waeReadsPerUncachedLoad} WAE queries; answers are cached ten minutes.
          </p>
        </div>
      </section>

      <details className="an-card an-queries">
        <summary>The SQL sent to Analytics Engine ({Object.keys(s.queries).length} queries, the dialect that answered)</summary>
        {Object.entries(s.queries).map(([name, sql]) => (
          <pre key={name}><code>{sql}</code></pre>
        ))}
      </details>
    </div>
  )
}
