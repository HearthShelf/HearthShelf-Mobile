// Compatibility augmentation while this checkout's Core submodule still points
// at the last published commit. The authoritative definitions live in
// HearthShelf-Core and this merges them into strict Mobile builds until that
// commit can be pushed and the submodule pointer advanced.
import '@hearthshelf/core'

declare module '@hearthshelf/core' {
  interface HSNote {
    spoiler: boolean
    updatedAt: number | null
  }

  interface HSClub {
    allowCommentEditing: boolean
    allowReplies: boolean
  }

  interface HSNoteReactionUser {
    userId: string
    username: string
    reactedAt: number
  }

  interface HSNoteReactionDetail {
    kind: NoteReactionKind
    users: HSNoteReactionUser[]
  }
}
