/**
 * One listening session on a user's page. Expanded, it answers "why didn't my book
 * get marked finished?": what ABS believes about the book, and the two failures we
 * can actually see.
 */
import { useState } from 'react'
import { Pressable, View } from 'react-native'
import { router } from 'expo-router'
import {
  fmtSessDate,
  formatDuration,
  formatTimestamp,
  sessionFinishDiagnostics,
  type ABSUserMediaProgress,
} from '@hearthshelf/core'
import { AdminButton } from '@/admin/AdminButton'
import type { AdminUserSession } from '@/api/admin/users'
import { DeviceKindIcon } from '@/ui/DeviceKindIcon'
import { Icon, icons } from '@/ui/icons'
import { AppText } from '@/ui/primitives'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'

function when(ms: number): string {
  const { day, time } = fmtSessDate(ms)
  return `${day} · ${time}`
}

function Fact({ label, value }: { label: string; value: string }) {
  const colors = useColors()
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md }}>
      <AppText variant="meta" color={colors.textMuted}>
        {label}
      </AppText>
      <AppText variant="meta" style={{ flexShrink: 1, textAlign: 'right' }}>
        {value}
      </AppText>
    </View>
  )
}

function Note({ children }: { children: string }) {
  const colors = useColors()
  return (
    <View style={{ flexDirection: 'row', gap: spacing.sm }}>
      <Icon name={icons.error} size={16} color={colors.destructive} />
      <AppText variant="meta" color={colors.textMuted} style={{ flex: 1 }}>
        {children}
      </AppText>
    </View>
  )
}

export function UserSessionRow({
  session,
  progress,
  last,
}: {
  session: AdminUserSession
  progress: ABSUserMediaProgress | undefined
  last: boolean
}) {
  const colors = useColors()
  const [open, setOpen] = useState(false)
  const { leftOff, startedAtSec, bookDuration, zeroDuration, stalledFinish } =
    sessionFinishDiagnostics(session, progress)
  const subtitle = [session.displayAuthor, formatDuration(session.timeListening)]
    .filter(Boolean)
    .join(' · ')

  return (
    <View
      style={{
        padding: spacing.md,
        gap: spacing.sm,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: colors.hairline,
      }}
    >
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}
      >
        <DeviceKindIcon deviceInfo={session.deviceInfo} size={18} color={colors.textMuted} />
        <View style={{ flex: 1 }}>
          <AppText variant="body" numberOfLines={1}>
            {session.displayTitle}
          </AppText>
          <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
            {subtitle}
          </AppText>
          <AppText variant="caption" color={colors.textMuted}>
            {when(session.updatedAt || session.startedAt)}
          </AppText>
        </View>
        <Icon name={open ? 'expand-less' : 'expand-more'} size={22} color={colors.textMuted} />
      </Pressable>

      {open ? (
        <View style={{ gap: spacing.sm }}>
          <Fact label="Started at" value={formatTimestamp(startedAtSec)} />
          <Fact
            label="Left off at"
            value={
              bookDuration > 0
                ? `${formatTimestamp(leftOff)} of ${formatTimestamp(bookDuration)}`
                : formatTimestamp(leftOff)
            }
          />
          {progress ? (
            <>
              <Fact
                label="Saved position"
                value={`${formatTimestamp(progress.currentTime)} · ${Math.round(
                  progress.progress * 100,
                )}% complete`}
              />
              <Fact
                label="Marked finished"
                value={
                  progress.isFinished
                    ? progress.finishedAt
                      ? `Yes · ${when(progress.finishedAt)}`
                      : 'Yes'
                    : 'No'
                }
              />
              <Fact
                label="Progress last saved"
                value={progress.lastUpdate ? when(progress.lastUpdate) : 'Never'}
              />
            </>
          ) : (
            <Fact label="Saved progress" value="None for this book" />
          )}
          {zeroDuration ? (
            <Note>
              This book has no length recorded, so it can never count as finished. Scan the book
              again to give it a length.
            </Note>
          ) : stalledFinish ? (
            <Note>
              They reached the end but the book is still unfinished. Marking it finished from the
              book page will clear this.
            </Note>
          ) : null}
          <AdminButton
            label="Book details"
            kind="secondary"
            icon="open-in-new"
            onPress={() => router.push(`/item/${session.libraryItemId}`)}
          />
        </View>
      ) : null}
    </View>
  )
}
