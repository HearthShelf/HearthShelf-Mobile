/**
 * TEMPORARY diagnostics dump. Gathers a full device/runtime snapshot and shows it
 * as one selectable text blob to copy/paste out of a TestFlight build. Used to
 * chase the iOS layout-scaling bug (are window dimensions coming through right?)
 * and as a general device-info capture.
 *
 * TO REMOVE: delete this file, its row in app/(tabs)/more.tsx (the "Diagnostics"
 * SettingsRow + its GROUP entry), and the route is gone. No other refs.
 *
 * The dump renders in a read-only multiline TextInput (still long-press selectable)
 * with a Copy button that writes to the clipboard via expo-clipboard, since the
 * Android long-press "Select All / Copy" menu is unreliable on a non-editable field.
 */
import { useMemo, useState } from 'react'
import {
  PixelRatio,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
  Dimensions,
} from 'react-native'
import { useSafeAreaInsets, useSafeAreaFrame } from 'react-native-safe-area-context'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Clipboard from 'expo-clipboard'
import { Screen, SectionHeader, AppText, PrimaryButton } from '@/ui/primitives'
import { spacing, radius, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { windowClass, adaptiveLibraryColumns } from '@/ui/responsive'
import { getSession } from '@/api/session'
import { showToast } from '@/ui/Toast'
import { testGoalCelebration } from '@/lib/goalCelebration'

/** Build the diagnostics text. Pure + synchronous so it can be regenerated on tap. */
function buildDump(args: {
  window: { width: number; height: number; scale: number; fontScale: number }
  screen: { width: number; height: number; scale: number; fontScale: number }
  frame: { x: number; y: number; width: number; height: number }
  insets: { top: number; bottom: number; left: number; right: number }
}): string {
  const { window, screen, frame, insets } = args
  const session = getSession()
  const cfg = Constants.expoConfig

  const lines: string[] = []
  const section = (t: string) => lines.push('', `== ${t} ==`)
  const kv = (k: string, v: unknown) => lines.push(`${k}: ${String(v)}`)

  lines.push('HEARTHSHELF DIAGNOSTICS')
  kv('generated', new Date().toISOString())

  section('App / Runtime')
  kv('app.version', cfg?.version ?? '(none)')
  kv('runtimeVersion', JSON.stringify(cfg?.runtimeVersion) ?? '(none)')
  kv('ios.buildNumber', cfg?.ios?.buildNumber ?? '(none)')
  kv('android.versionCode', cfg?.android?.versionCode ?? '(none)')
  kv('expoConfig.name', cfg?.name ?? '(none)')
  kv('appOwnership', Constants.appOwnership ?? '(standalone)')
  kv('executionEnvironment', Constants.executionEnvironment)
  kv('deviceName (Constants)', Constants.deviceName ?? '(none)')

  section('Platform')
  kv('OS', Platform.OS)
  kv('Version', String(Platform.Version))
  kv('isPad (ios)', Platform.OS === 'ios' ? String((Platform as { isPad?: boolean }).isPad) : 'n/a')
  kv(
    'isTV',
    String((Platform as { isTV?: boolean }).isTV),
  )
  kv('constants.reactNativeVersion', JSON.stringify(Platform.constants?.reactNativeVersion))
  kv(
    'constants.Model/systemName',
    Platform.OS === 'ios'
      ? String((Platform.constants as { systemName?: string })?.systemName)
      : String((Platform.constants as { Model?: string })?.Model),
  )
  kv(
    'newArch (fabric global)',
    String(!!(globalThis as { nativeFabricUIManager?: unknown }).nativeFabricUIManager),
  )

  section('LAYOUT / SCALING (the bug)')
  kv('useWindowDimensions.width', window.width)
  kv('useWindowDimensions.height', window.height)
  kv('useWindowDimensions.scale', window.scale)
  kv('useWindowDimensions.fontScale', window.fontScale)
  kv('Dimensions(screen).width', screen.width)
  kv('Dimensions(screen).height', screen.height)
  kv('Dimensions(screen).scale', screen.scale)
  kv('Dimensions(screen).fontScale', screen.fontScale)
  kv('safeAreaFrame.width', frame.width)
  kv('safeAreaFrame.height', frame.height)
  kv('safeAreaFrame.x/y', `${frame.x} / ${frame.y}`)
  kv('safeAreaInsets', `T${insets.top} B${insets.bottom} L${insets.left} R${insets.right}`)
  kv('PixelRatio.get()', PixelRatio.get())
  kv('PixelRatio.getFontScale()', PixelRatio.getFontScale())
  kv('--- derived ---', '')
  kv('windowClass(window.width)', windowClass(window.width))
  kv('windowClass(screen.width)', windowClass(screen.width))
  kv('libraryCols(window,comfortable)', adaptiveLibraryColumns(window.width, 'comfortable'))
  kv('libraryCols(screen,comfortable)', adaptiveLibraryColumns(screen.width, 'comfortable'))
  kv('window.width === screen.width?', window.width === screen.width)

  section('Device (expo-device)')
  kv('isDevice', Device.isDevice)
  kv('brand', Device.brand)
  kv('manufacturer', Device.manufacturer)
  kv('modelName', Device.modelName)
  kv('modelId', Device.modelId)
  kv('designName', Device.designName)
  kv('productName', Device.productName)
  kv('deviceYearClass', Device.deviceYearClass)
  kv('deviceType', Device.deviceType)
  kv('totalMemory (bytes)', Device.totalMemory)
  kv('osName', Device.osName)
  kv('osVersion', Device.osVersion)
  kv('osBuildId', Device.osBuildId)
  kv('platformApiLevel', Device.platformApiLevel)
  kv('supportedCpuArchitectures', JSON.stringify(Device.supportedCpuArchitectures))

  section('Connection')
  kv('hasSession', !!session)
  kv('serverUrl', session ? redactHost(session.serverUrl) : '(none)')
  kv('tokenLength', session ? session.token.length : 0)

  return lines.join('\n')
}

/** Keep the host visible for debugging but drop any query/token tail. */
function redactHost(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return '(unparseable)'
  }
}

export default function DiagnosticsScreen() {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const window = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const frame = useSafeAreaFrame()
  const [nonce, setNonce] = useState(0)

  const dump = useMemo(
    () =>
      buildDump({
        window,
        screen: Dimensions.get('screen'),
        frame,
        insets,
      }),
    // nonce forces a fresh capture on "Refresh"
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [window, insets, frame, nonce],
  )

  return (
    <Screen>
      <SectionHeader title="Diagnostics" />
      <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: spacing.sm }}>
        <AppText variant="caption" color={colors.textMuted}>
          Tap Copy, then paste into a message. Temporary debug tool.
        </AppText>
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <View style={{ flex: 1 }}>
            <PrimaryButton
              label="Copy"
              onPress={() => {
                void Clipboard.setStringAsync(dump).then(() => showToast('Diagnostics copied'))
              }}
            />
          </View>
          <View style={{ flex: 1 }}>
            <PrimaryButton label="Refresh" onPress={() => setNonce((n) => n + 1)} />
          </View>
        </View>
        <PrimaryButton label="Test goal celebration" onPress={() => void testGoalCelebration()} />
      </View>
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingTop: 0 }}
        style={{ flex: 1 }}
      >
        <TextInput
          value={dump}
          editable={false}
          multiline
          scrollEnabled={false}
          selectTextOnFocus
          style={styles.dump}
        />
      </ScrollView>
    </Screen>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    dump: {
      fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
      fontSize: 12,
      lineHeight: 18,
      color: colors.text,
      backgroundColor: colors.card,
      borderRadius: radius.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      padding: spacing.md,
    },
  })
