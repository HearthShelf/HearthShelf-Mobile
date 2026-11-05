/**
 * The log of one task run, refreshed while open. Mount it with a `key` per run and
 * unmount it on `onClose`.
 *
 * The polling hook sits here, outside <Sheet>, because a bottom sheet draws in a
 * portal above the navigator, where focus hooks have no screen to attach to.
 */
import { useEffect, useRef } from 'react'
import { StyleSheet, View } from 'react-native'
import { BottomSheetFlatList } from '@gorhom/bottom-sheet'
import type { JobLogLine } from '@hearthshelf/core'
import { getRunLogs } from '@/api/admin/jobs'
import { AppText, Sheet, type SheetRef } from '@/ui/primitives'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'
import { AdminButton } from './AdminButton'
import { useAdminResource } from './useAdminResource'

const LOG_POLL_MS = 3000
const SNAP_POINTS = ['75%']

function LogLine({ line }: { line: JobLogLine }) {
  const colors = useColors()
  const time = new Date(line.at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const tone = line.level === 'error' ? colors.destructive : colors.text
  return (
    <AppText variant="mono" color={tone}>
      <AppText variant="mono" color={colors.textMuted}>
        {time}{' '}
      </AppText>
      {line.level === 'info' ? '' : `[${line.level.toUpperCase()}] `}
      {line.message}
    </AppText>
  )
}

export function JobLogSheet({
  runId,
  title,
  onClose,
}: {
  runId: string
  title: string
  onClose: () => void
}) {
  const colors = useColors()
  const sheet = useRef<SheetRef>(null)
  const logs = useAdminResource(() => getRunLogs(runId), { pollMs: LOG_POLL_MS })

  useEffect(() => {
    sheet.current?.present()
  }, [])

  const failed = Boolean(logs.error) && !logs.data
  return (
    <Sheet ref={sheet} title={title} kicker="Task log" snapPoints={SNAP_POINTS} onDismiss={onClose}>
      {failed ? (
        <View style={styles.note}>
          <AppText variant="meta" color={colors.textMuted}>
            {"Couldn't load this log."}
          </AppText>
          <AdminButton label="Try again" kind="secondary" onPress={logs.reload} />
        </View>
      ) : logs.data?.length ? (
        <BottomSheetFlatList
          data={logs.data}
          keyExtractor={(line: JobLogLine) => String(line.seq)}
          renderItem={({ item }: { item: JobLogLine }) => <LogLine line={item} />}
          contentContainerStyle={styles.lines}
        />
      ) : (
        <AppText variant="meta" color={colors.textMuted}>
          {logs.loading ? 'Loading the log.' : 'No log lines yet.'}
        </AppText>
      )}
    </Sheet>
  )
}

const styles = StyleSheet.create({
  note: { gap: spacing.md },
  lines: { gap: spacing.xs, paddingBottom: spacing.xl },
})
