import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

/**
 * Shared helpers for specs that spawn a real `wrangler pages dev` process
 * (`workerd-smoke.spec.ts`, `service-worker-retired.spec.ts`) — polling for readiness, capturing its
 * output for a failure message, and a teardown that actually reaches the real server. Previously
 * duplicated near-verbatim in both specs; extracted here so a fix to any of it (a poll interval,
 * a timeout message, the kill reliability below) only has to be made once.
 */

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitUntilReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      // Any response at all means the dev server is up; a 404 for a route the fixture/build
      // doesn't happen to serve at this exact path is expected and fine.
      if (res.status) return
    } catch (err) {
      lastError = err
    }
    await wait(500)
  }
  throw new Error(`wrangler pages dev did not become ready within ${timeoutMs}ms: ${String(lastError)}`)
}

export interface LoggedProcess {
  process: ChildProcess
  /** Accumulated stdout+stderr so far — read this on failure; stays quiet on a passing run. */
  log(): string
}

/**
 * Spawns a command with its output captured for a failure message, detached into its own
 * process group so `killLoggedProcess` can reliably tear the whole tree down. This matters
 * specifically for `npx wrangler pages dev ...`: depending on the npm/npx version, the real
 * `wrangler` server can run as a further child of the `npx` process rather than replacing it in
 * place, so a bare `.kill()` on just the top-level process is not guaranteed to reach it — an
 * orphaned dev server can then be left bound to the port for the next run to collide with.
 */
export function spawnLogged(command: string, args: string[], options: SpawnOptions = {}): LoggedProcess {
  const child = spawn(command, args, { stdio: 'pipe', ...options, detached: true })
  let log = ''
  child.stdout?.on('data', (d) => (log += String(d)))
  child.stderr?.on('data', (d) => (log += String(d)))
  return { process: child, log: () => log }
}

/** Kills the whole process group `spawnLogged` started, not just its top-level process. */
export function killLoggedProcess(logged: LoggedProcess | null | undefined): void {
  const pid = logged?.process.pid
  if (!pid) return
  try {
    // A negative pid targets the process group `detached: true` made this process the leader
    // of (POSIX only — falls through to the plain kill below on a platform where this throws).
    process.kill(-pid, 'SIGTERM')
  } catch {
    logged?.process.kill()
  }
}
