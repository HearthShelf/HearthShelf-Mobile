# HearthShelf Fold

Foldable-specific reimagining of the mobile `-Final` redesign suite.

Open `index.html` in a browser. The prototype covers Home, Library, Player,
Book, Stats & Clubs, Settings, system/connection states, and a tabletop player
posture. The Player companion pane is interactive without JavaScript: select
Chapters, Queue, Recent, or Notes to swap the right leaf.

## Design position

The fold acts as a book spine, not as a target or decorative centerline.

- The left leaf owns focus, selection, and playback.
- The right leaf owns context, detail, lists, and editing.
- The hinge plus 24 px on each side is a non-interactive safety zone.
- Player transport is centered within the left leaf and never moves when the
  companion pane changes.
- In tabletop posture, artwork and glanceable status live above the horizontal
  fold; scrubber and transport live below it.

## Player seam verdict

Do not put the play button on the seam. It is a visually tempting composition,
but a poor physical control: hinge widths vary, the target can be occluded or
split, neither thumb reaches it comfortably, and opening a panel risks shifting
the control under an active finger. Keeping transport centered in the left leaf
also preserves the player's spatial memory across Chapters, Queue, Recent, and
Notes.

## Implementation rules

- Segment the window using real display-feature/hinge bounds where available;
  do not branch on device model names.
- Treat compact, expanded dual-pane, and tabletop as layout/posture classes.
- Keep leaf scroll positions independent.
- Give every touch target at least 48 dp with 8 dp separation.
- Remount virtualized grids when their column count changes.
- Preserve the FINAL five-tab ownership model and the distinction between phone
  Focus view and the native vehicle experience.
- Honor reduced motion with right-pane cross-fades instead of whole-screen pushes.

