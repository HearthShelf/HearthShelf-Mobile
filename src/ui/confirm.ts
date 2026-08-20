/**
 * One promise-based confirmation for destructive / hard-to-undo actions, so call
 * sites can `if (!(await confirm({...}))) return` instead of hand-rolling
 * Alert.alert callbacks. Wraps React Native's Alert (native on both platforms)
 * and fires the warning haptic on open, matching the app's destructive-action
 * feel (see haptics.warn).
 *
 * Reserve this for actions that lose data or are awkward to reverse - deleting a
 * download, bulk-marking a shelf finished, leaving a club. Reversible taps
 * (add to list, queue) should NOT gate behind a confirm.
 */
import { Alert } from 'react-native'
import { haptics } from './haptics'

export interface ConfirmOptions {
  /** Short title, e.g. "Remove download". */
  title: string
  /** Body text - name the thing and the count so the user knows the blast radius. */
  message?: string
  /** Label for the confirming button (defaults to "OK"). */
  confirmLabel?: string
  /** Label for the cancel button (defaults to "Cancel"). */
  cancelLabel?: string
  /** Style the confirm button as destructive (red on iOS). Defaults to true - the
   *  helper is for risky actions. Pass false for a neutral confirm. */
  destructive?: boolean
}

/** Show a confirm dialog; resolves true if the user confirms, false otherwise
 *  (cancel or dismiss). */
export function confirm({
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  destructive = true,
}: ConfirmOptions): Promise<boolean> {
  haptics.warn()
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: cancelLabel, style: 'cancel', onPress: () => resolve(false) },
        {
          text: confirmLabel,
          style: destructive ? 'destructive' : 'default',
          onPress: () => resolve(true),
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    )
  })
}

export interface ChooseOption<T extends string> {
  /** Value resolved when this button is pressed. */
  value: T
  /** Button label. */
  label: string
  /** Style the button as destructive (red on iOS). */
  destructive?: boolean
}

export interface ChooseOptions<T extends string> {
  title: string
  message?: string
  /** Buttons in display order. Keep to two or three - Alert stacks them
   *  vertically on iOS once there are more than two, and Android caps at three. */
  options: ChooseOption<T>[]
  cancelLabel?: string
}

/**
 * A confirm with more than two outcomes, for a fork where cancelling and
 * choosing the second branch are genuinely different intents - "the club
 * finished this book" vs "the club set it aside" vs "never mind". A plain
 * confirm would have to conflate one of those with dismissal.
 *
 * Resolves the chosen option's `value`, or null if the user cancels/dismisses.
 */
export function choose<T extends string>({
  title,
  message,
  options,
  cancelLabel = 'Cancel',
}: ChooseOptions<T>): Promise<T | null> {
  haptics.warn()
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        ...options.map((o) => ({
          text: o.label,
          style: o.destructive ? ('destructive' as const) : ('default' as const),
          onPress: () => resolve(o.value),
        })),
        { text: cancelLabel, style: 'cancel' as const, onPress: () => resolve(null) },
      ],
      { cancelable: true, onDismiss: () => resolve(null) },
    )
  })
}
