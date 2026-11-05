/** Open RSS feeds. */
import { ABS_ENDPOINTS, type ABSRssFeed } from '@hearthshelf/core'
import { adminRequest } from '@/api/abs'

export async function getRssFeeds(): Promise<ABSRssFeed[]> {
  const res = await adminRequest<{ feeds?: ABSRssFeed[] }>(ABS_ENDPOINTS.feeds)
  return res.feeds ?? []
}

export function closeRssFeed(feedId: string): Promise<unknown> {
  return adminRequest<unknown>(ABS_ENDPOINTS.feedClose(feedId), { method: 'POST' })
}
