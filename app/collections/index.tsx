/** Browse collections. Thin route over the shared list surface. */
import { ListsBrowse } from '@/ui/lists/ListsBrowse'
import { COLLECTION_KIND } from '@/ui/lists/kind'

export default function CollectionsScreen() {
  return <ListsBrowse descriptor={COLLECTION_KIND} />
}
