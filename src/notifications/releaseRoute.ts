/**
 * Where a release notification should land.
 *
 * The three release signals are not the same destination. `reminder` and
 * `release` are about a book that is still upcoming, so the upcoming page is
 * right. But `available` fires precisely BECAUSE the book has arrived in the
 * library - sending that tap to the upcoming page shows a "coming soon" screen
 * for something the listener can play right now, which is what was reported
 * (HS-MOBILEAPP-7).
 *
 * Resolving the owned item needs a search + confirm round trip (see
 * findOwnedItemByAsin), so this is async and deliberately falls back to the
 * upcoming page on every failure: offline, not actually owned yet, or an ASIN
 * that matches nothing. Landing on the upcoming page is the old behaviour and
 * is never wrong enough to be worth an error.
 *
 * Shared by both tap paths - the push handler and the in-app inbox - so they
 * cannot drift apart.
 */
import { findOwnedItemByAsin } from '@/api/abs'

/** The in-app path a release notification for `asin` should open. */
export async function releaseNotificationRoute(asin: string, signal?: string): Promise<string> {
  const upcoming = `/upcoming/${encodeURIComponent(asin)}`
  if (signal !== 'available') return upcoming
  const itemId = await findOwnedItemByAsin(asin)
  return itemId ? `/item/${encodeURIComponent(itemId)}` : upcoming
}
