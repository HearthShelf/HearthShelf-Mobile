/** Frame for a library edit section. The draft is opened by the library screen, so
 *  a section reached any other way has nothing to edit. */
import { useLocalSearchParams, useRouter } from 'expo-router'
import { icons } from '@/ui/icons'
import { EmptyState } from '@/ui/states'
import { AdminGate } from './AdminGate'
import { useLibraryDraft, type LibraryDraftState } from './LibraryDraft'

type Render = (state: LibraryDraftState) => React.ReactNode

export function LibraryDraftScreen({ children }: { children: Render }) {
  return (
    <AdminGate>
      <DraftOrMissing>{children}</DraftOrMissing>
    </AdminGate>
  )
}

function DraftOrMissing({ children }: { children: Render }) {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const state = useLibraryDraft(id)
  if (state) return children(state)
  return (
    <EmptyState
      icon={icons.notInterested}
      title="This library isn't open"
      body="Open it from your libraries to make changes."
      cta="Go to libraries"
      onCta={() => router.replace('/settings/admin/libraries')}
    />
  )
}
