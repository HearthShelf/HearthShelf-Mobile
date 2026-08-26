import { useEffect, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Switch, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { getClub, setClubVisibility, updateClubPolicySettings } from '@/api/clubs'
import { AppText, IconButton, Loading, Screen, Touchable, icons } from '@/ui/primitives'
import { AppTabBar, tabFromParam, useGoToTab } from '@/ui/AppTabBar'
import { Toast, useToast } from '@/ui/Toast'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { haptics } from '@/ui/haptics'

export default function ClubAdminScreen() {
  const router = useRouter()
  const { id, from } = useLocalSearchParams<{ id: string; from?: string }>()
  const active = tabFromParam(from, 'home')
  const goToTab = useGoToTab()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const { message, show } = useToast()
  const [name, setName] = useState('Club admin')
  const [editing, setEditing] = useState(true)
  const [replies, setReplies] = useState(true)
  const [autoAdvance, setAutoAdvance] = useState(false)
  const [isPublic, setIsPublic] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!id) return
    void getClub(id).then((detail) => {
      if (detail) {
        setName(detail.club.name)
        setEditing(detail.club.allowCommentEditing)
        setReplies(detail.club.allowReplies)
        setAutoAdvance(detail.club.autoAdvanceOnAllFinished)
        setIsPublic(detail.club.isOpen)
      }
      setLoaded(true)
    })
  }, [id])

  // Visibility has its own endpoint, so it saves the moment it is flipped
  // rather than waiting for Save changes. Revert the switch if the server says no.
  const changeVisibility = async (next: boolean) => {
    setIsPublic(next)
    const ok = await setClubVisibility(id, next ? 'public' : 'closed')
    if (!ok) {
      setIsPublic(!next)
      return show('Could not change who can join')
    }
    haptics.mode()
    show(next ? 'Anyone on this server can join' : 'People can only join by invitation')
  }

  const save = async () => {
    if (!id || busy) return
    setBusy(true)
    const result = await updateClubPolicySettings(id, {
      allowCommentEditing: editing,
      allowReplies: replies,
      autoAdvanceOnAllFinished: autoAdvance,
    })
    setBusy(false)
    if (!result) return show('Could not save club settings')
    show('Club settings saved')
  }

  return (
    <Screen tabBar={<AppTabBar activeName={active} onPressTab={goToTab} />}>
      <View style={styles.header}>
        <IconButton
          name={icons.back}
          size={22}
          onPress={() => router.back()}
          accessibilityLabel="Back"
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText variant="title" numberOfLines={1}>
            Club admin
          </AppText>
          <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
            {name}
          </AppText>
        </View>
      </View>
      {!loaded ? (
        <Loading />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <AppText variant="eyebrow" color={colors.textMuted}>
            Who can join
          </AppText>
          <View style={styles.card}>
            <SettingRow
              title="Let anyone on this server join"
              description="Your club is listed so people can find it and join on their own."
              value={isPublic}
              onChange={(next) => void changeVisibility(next)}
              colors={colors}
            />
          </View>
          <AppText variant="caption" color={colors.textMuted} style={styles.help}>
            {isPublic
              ? 'Turn this off and people can only join if you invite them. Members already in the club stay in it.'
              : 'People can only join if you invite them.'}
          </AppText>
          <AppText variant="eyebrow" color={colors.textMuted} style={styles.section}>
            Discussion permissions
          </AppText>
          <View style={styles.card}>
            <SettingRow
              title="Allow member comment editing"
              description="Members can revise their own text and add or remove the spoiler flag."
              value={editing}
              onChange={setEditing}
              colors={colors}
            />
            <SettingRow
              title="Allow replies"
              description="Members can reply to existing top-level comments. Existing replies remain readable."
              value={replies}
              onChange={setReplies}
              colors={colors}
            />
          </View>
          <AppText variant="caption" color={colors.textMuted} style={styles.help}>
            These settings apply only to this club and are enforced by the server for every write.
          </AppText>
          <AppText variant="eyebrow" color={colors.textMuted} style={styles.section}>
            Reading pace
          </AppText>
          <View style={styles.card}>
            <SettingRow
              title="Move on when everyone has finished"
              description="Once everyone who started the book has finished it, the club marks it read and starts the next book in Up next. Anyone who never started it will not hold the club up."
              value={autoAdvance}
              onChange={setAutoAdvance}
              colors={colors}
            />
          </View>
          <AppText variant="caption" color={colors.textMuted} style={styles.help}>
            {autoAdvance
              ? 'HearthShelf checks every hour. With nothing in Up next, the club finishes the book and waits for you to pick what is next.'
              : 'You choose when this club starts its next book.'}
          </AppText>
          <Touchable
            style={[styles.save, busy && { opacity: 0.55 }]}
            disabled={busy}
            onPress={() => void save()}
            accessibilityRole="button"
          >
            <AppText variant="label" color={colors.onAccent}>
              {busy ? 'Saving…' : 'Save changes'}
            </AppText>
          </Touchable>
        </ScrollView>
      )}
      <Toast message={message} />
    </Screen>
  )
}

function SettingRow({
  title,
  description,
  value,
  onChange,
  colors,
}: {
  title: string
  description: string
  value: boolean
  onChange: (value: boolean) => void
  colors: Palette
}) {
  return (
    <View style={rowStyles.row}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText variant="label">{title}</AppText>
        <AppText
          variant="caption"
          color={colors.textMuted}
          style={{ marginTop: 4, lineHeight: 18 }}
        >
          {description}
        </AppText>
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.accent }} />
    </View>
  )
}

const rowStyles = StyleSheet.create({
  row: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
})

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    header: {
      minHeight: 64,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
    },
    content: { padding: spacing.lg, paddingBottom: spacing.xxl },
    card: {
      marginTop: spacing.sm,
      paddingHorizontal: spacing.md,
      borderRadius: radius.card,
      backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    help: { marginTop: spacing.md, lineHeight: 18 },
    section: { marginTop: spacing.xl },
    save: {
      minHeight: 48,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: spacing.xl,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
    },
  })
