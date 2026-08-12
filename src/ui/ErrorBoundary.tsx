/**
 * The app's only React error boundary.
 *
 * Why this exists: a render throw with no boundary unmounts the tree to a BLANK
 * WHITE SCREEN, and - because it is caught by React's reconciler rather than
 * reaching the global handler - it can reach Sentry as nothing at all. That is
 * the "the app crashes without actually crashing" report (HS-MOBILEAPP-13): the
 * process was alive, MainActivity was resumed, and there was not one JS error
 * event to look at. The bug was only found by attaching adb and reading a
 * Reanimated warning in logcat.
 *
 * So this does two jobs, and the reporting one matters more than the UI:
 *   1. Report the error to Sentry with a component stack, so this class of
 *      failure is never again invisible.
 *   2. Show a recoverable screen instead of white, so a listener is not stranded
 *      with an app that looks dead but is not.
 *
 * Deliberately a class component: React only supports error catching via
 * componentDidCatch/getDerivedStateFromError, which have no hook equivalent.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import * as Sentry from '@sentry/react-native'
import { AppText, PrimaryButton } from '@/ui/primitives'
import { breadcrumb } from '@/lib/crashLog'
import { spacing } from '@/ui/theme'

interface Props {
  children: ReactNode
  /** Names the boundary in reports, e.g. 'root'. */
  label?: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Disk trail first: it survives a subsequent hard crash and ships with the
    // next feedback report even if the Sentry send never completes.
    breadcrumb('fatal', `render error: ${error.message}`)
    try {
      Sentry.withScope((scope) => {
        scope.setTag('error_boundary', this.props.label ?? 'root')
        // The component stack is the whole point - a render throw's own stack is
        // usually minified framework frames, while this names OUR component.
        scope.setContext('react', { componentStack: info.componentStack })
        scope.setLevel('fatal')
        Sentry.captureException(error)
      })
    } catch {
      // Reporting must never throw from inside an error handler.
    }
  }

  private reset = () => {
    this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    // Intentionally plain: this renders when something upstream is already
    // broken, so it avoids theme context, animations, and navigation - any of
    // which could be the very thing that threw.
    return (
      <View style={styles.wrap}>
        <AppText variant="title">Something went wrong</AppText>
        <AppText variant="body" style={styles.body}>
          That screen ran into a problem. Your listening is safe - the report has
          been sent.
        </AppText>
        <PrimaryButton label="Try again" onPress={this.reset} />
      </View>
    )
  }
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md,
  },
  body: { textAlign: 'center' },
})
