# HearthShelf Fold — final direction

Open `index.html` in a browser. The prototype is intentionally focused on the
four decisions that survived the GPT/Opus comparison:

- **Home:** GPT's two-leaf continuation/discovery composition.
- **Library:** Opus's connected grid + selected-book detail, with an explicit
  route into GPT's full two-leaf book page.
- **Book:** GPT's focused full-detail treatment.
- **Player:** GPT's stable player/companion ownership, redrawn to match the
  shipping mobile player's current hierarchy (queue + identity header,
  whole-book progress, cover, chapter scrubber, five-part transport, and
  customizable action row).

## Navigation decision

The permanent left rail was rejected because it takes useful width from every
left-leaf surface. The final uses the app's existing floating-glass language and
adds a foldable placement preference:

- **Left:** dock belongs to the left leaf.
- **Both:** dock spans the display but leaves a non-interactive seam gap.
- **Right:** dock belongs to the right leaf.

The grip is draggable and snaps to those three positions. The Tune button opens
the same three choices, so drag is an enhancement rather than the only control.
The choice persists in `localStorage` in this prototype.

## Foldable implementation rules

- Resolve real hinge/display-feature bounds; do not branch on device models.
- Keep the hinge and its safety gutters free of required touch targets.
- Preserve each pane's scroll/selection state when a book moves between split
  and full detail.
- Preserve player geometry while companion panels change.
- Use at least 48dp targets and visible alternatives for every gesture.
- Respect reduced motion; the prototype collapses transitions automatically.
