/**
 * Renders the brand/surface icon for a listening session's origin, from core's
 * classifyDevice `kind`. Apple/Android/Car are brand logos that live in
 * MaterialCommunityIcons (not the MaterialIcons set the rest of the app uses),
 * while web/desktop stay on MaterialIcons. Centralized so the player sheet and
 * the item screen's Recent Listens both show the same icon for the same session.
 */
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons'
import { Icon } from './icons'
import { classifyDevice, type DeviceKind } from '@hearthshelf/core'
import type { ABSDeviceInfo } from '@hearthshelf/core'

const MCI: Partial<
  Record<DeviceKind, React.ComponentProps<typeof MaterialCommunityIcons>['name']>
> = {
  apple: 'apple',
  android: 'android',
  car: 'car',
}

export function DeviceKindIcon({
  deviceInfo,
  size = 15,
  color,
}: {
  deviceInfo: ABSDeviceInfo | undefined
  size?: number
  color: string
}) {
  const { kind } = classifyDevice(deviceInfo)
  const mci = MCI[kind]
  if (mci) {
    return <MaterialCommunityIcons name={mci} size={size} color={color} />
  }
  // web / desktop use the MaterialIcons glyphs the app already ships.
  return <Icon name={kind === 'web' ? 'language' : 'computer'} size={size} color={color} />
}
