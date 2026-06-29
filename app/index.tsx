import { useAuth } from '@clerk/expo'
import { Redirect } from 'expo-router'
import { ActivityIndicator, View } from 'react-native'

/** Route gate: send signed-out users to /sign-in, signed-in users to /home. */
export default function Index() {
  const { isLoaded, isSignedIn } = useAuth()

  if (!isLoaded) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    )
  }

  return <Redirect href={isSignedIn ? '/home' : '/sign-in'} />
}
