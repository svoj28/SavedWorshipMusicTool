// lib/networkSync.web.ts
/**
 * There is nothing to catch up on, so this does nothing.
 *
 * On native, startNetworkSync waits for the connection to come back and
 * flushes rows that were written while it was gone. That only makes sense
 * because native keeps a database across sessions. The web build holds its
 * database in memory and pushes every write as it happens, so a row that has
 * not reached Supabase yet is a request in flight, not a backlog on disk -
 * and re-running a flush on reconnect would have nothing to find.
 *
 * Kept as a no-op with the same shape so App.tsx does not have to know which
 * platform it is starting.
 */

export function startNetworkSync(): void {}

export function stopNetworkSync(): void {}
