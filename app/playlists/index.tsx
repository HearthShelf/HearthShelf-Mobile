/** Browse playlists. Thin route over the shared list surface. */
import { ListsBrowse } from '@/ui/lists/ListsBrowse'
import { PLAYLIST_KIND } from '@/ui/lists/kind'

export default function PlaylistsScreen() {
  return <ListsBrowse descriptor={PLAYLIST_KIND} />
}
