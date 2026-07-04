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
