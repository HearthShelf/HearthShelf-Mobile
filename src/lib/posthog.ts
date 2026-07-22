import PostHog from 'posthog-react-native'
import { POSTHOG_PROJECT_TOKEN, POSTHOG_HOST } from './config'

// A placeholder token that satisfies the SDK constructor but keeps the client
// disabled. The constructor requires a non-empty string; `disabled: true` ensures
// no events are sent while POSTHOG_PROJECT_TOKEN is not set.
const PLACEHOLDER = 'placeholder_key'

const isConfigured =
  !!POSTHOG_PROJECT_TOKEN && POSTHOG_PROJECT_TOKEN !== 'phc_your_project_token_here'

if (__DEV__ && !isConfigured) {
  console.error(
    'EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN variable required by PostHog is missing or ' +
      'un-configured, this causes events to be silently missed. ' +
      'This error stops appearing once EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN is configured',
  )
}

export const posthog = new PostHog(isConfigured ? POSTHOG_PROJECT_TOKEN : PLACEHOLDER, {
  host: POSTHOG_HOST,
  disabled: !isConfigured,
  captureNativeAppLifecycleEvents: true,
})

// Forward uncaught global JS errors to PostHog. Chain with the existing handler
// so Sentry and the on-disk crash reporter still see every fatal error.
const _prevGlobalHandler = ErrorUtils.getGlobalHandler()
ErrorUtils.setGlobalHandler((error, isFatal) => {
  posthog.captureException(error)
  _prevGlobalHandler?.(error, isFatal)
})
