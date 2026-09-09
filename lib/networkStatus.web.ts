// lib/networkStatus.web.ts
/**
 * Online-ness in the browser.
 *
 * NetInfo's real answer comes from native reachability probes that have no
 * counterpart here, so this uses what the browser actually knows.
 *
 * navigator.onLine is weaker than the native check: it reports whether there
 * is a network interface, not whether anything is reachable across it. That is
 * accepted rather than worked around, because on web this value is only used
 * to explain a failure that has already happened - the web build talks to
 * Supabase for every read anyway, so a wrong "true" here surfaces as the
 * request failing, which is handled, not as work being silently queued.
 */

export async function isOnline(): Promise<boolean> {
  if (typeof navigator === 'undefined') return true
  return navigator.onLine !== false
}
