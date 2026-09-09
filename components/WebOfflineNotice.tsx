// components/WebOfflineNotice.tsx
/**
 * Nothing to say on native.
 *
 * Losing signal on a phone is not a failure here - the database is on the
 * device, the app keeps working from it, and anything written while offline
 * goes up when the connection returns. There is no warning to give.
 *
 * The web build has no such copy, and gets ./WebOfflineNotice.web.tsx instead.
 */

export default function WebOfflineNotice() {
  return null
}
