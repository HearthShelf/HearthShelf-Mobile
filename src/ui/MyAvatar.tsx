/**
 * The signed-in user's own profile photo.
 *
 * The server serves every user's photo from the same public route
 * (GET /hs/avatars/:absUserId), ranking upload -> Gravatar -> synced sign-in
 * photo -> 404, so "my photo" is the same lookup the club and leaderboard
 * surfaces already do for other people - it just needs MY ABS user id, which is
 * not the account id `useAuth()` returns.
 *
 * That id arrives with /api/me, which can resolve after this mounts, hence the
 * subscription: initials first, real photo the moment the id lands. A 404 (no
 * photo, no Gravatar) falls back to initials inside <Avatar>.
 */
import { useSyncExternalStore } from 'react'
import { avatarUrl } from '@/api/abs'
import { getMeId, subscribeMeId } from '@/api/me'
import { Avatar } from '@/ui/primitives'

export function MyAvatar({ size, name, hue }: { size: number; name: string; hue?: string }) {
  const meId = useSyncExternalStore(subscribeMeId, getMeId, getMeId)
  const uri = meId ? avatarUrl(meId) : undefined
  return <Avatar uri={uri || undefined} size={size} name={name} hue={hue} />
}
