import { useEffect, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import type { ABSLibraryItemDetail } from '@hearthshelf/core'
import { formatDuration, formatTimestamp, stripHtml } from '@hearthshelf/core'
import { coverUrl, getItemDetail } from '@/api/abs'
import { playItemById } from '@/player/playback'
import {
  AppText,
  Centered,
  Cover,
  IconButton,
  Loading,
  PrimaryButton,
  Screen,
  icons,
} from '@/ui/primitives'
import { colors, spacing } from '@/ui/theme'

export default function ItemDetailScreen() {
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const [detail, setDetail] = useState<ABSLibraryItemDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    void (async () => {
      try {
        const d = await getItemDetail(id)
        if (!cancelled) setDetail(d)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id])

  const play = () => {
    if (id) {
      void playItemById(id)
      router.push('/player')
    }
  }

  if (error) {
    return (
      <Screen>
        <Header onBack={() => router.back()} />
        <Centered>
          <AppText variant="meta" color={colors.destructive}>
            {error}
          </AppText>
        </Centered>
      </Screen>
    )
  }

  if (!detail) {
    return (
      <Screen>
        <Header onBack={() => router.back()} />
        <Loading />
      </Screen>
    )
  }

  const meta = detail.media.metadata
  const chapters = detail.media.chapters ?? []
  // The detail media shape omits the flat `duration`; derive it from the last
  // chapter's end (full-book absolute seconds) when chapters are present.
  const duration = chapters.length > 0 ? chapters[chapters.length - 1].end : 0
  const description = meta.description ? stripHtml(meta.description) : ''

  return (
    <Screen>
      <Header onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 160 }} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <Cover uri={coverUrl(detail.id)} width={150} aspectRatio={2 / 3} />
          <AppText variant="hero" style={styles.title}>
            {meta.title || 'Untitled'}
          </AppText>
          <AppText variant="label" color={colors.textMuted}>
            {meta.authorName || 'Unknown author'}
          </AppText>
          {meta.narratorName ? (
            <AppText variant="meta" color={colors.textFaint}>
              Narrated by {meta.narratorName}
            </AppText>
          ) : null}
          <View style={styles.stats}>
            {duration > 0 ? (
              <AppText variant="meta" color={colors.textMuted}>
                {formatDuration(duration)}
              </AppText>
            ) : null}
            {chapters.length > 0 ? (
              <AppText variant="meta" color={colors.textMuted}>
                {chapters.length} chapters
              </AppText>
            ) : null}
            {meta.publishedYear ? (
              <AppText variant="meta" color={colors.textMuted}>
                {meta.publishedYear}
              </AppText>
            ) : null}
          </View>
          <PrimaryButton label="Play" icon={icons.play} onPress={play} style={styles.playBtn} />
        </View>

        {description ? (
          <View style={styles.section}>
            <AppText variant="meta" color={colors.textMuted} style={{ lineHeight: 20 }}>
              {description}
            </AppText>
          </View>
        ) : null}

        {chapters.length > 0 ? (
          <View style={styles.section}>
            <AppText variant="title" style={{ marginBottom: spacing.sm }}>
              Chapters
            </AppText>
            {chapters.slice(0, 12).map((c, i) => (
              <View key={`${c.id ?? i}`} style={styles.chapterRow}>
                <AppText variant="meta" numberOfLines={1} style={{ flex: 1 }}>
                  {c.title || `Chapter ${i + 1}`}
                </AppText>
                <AppText variant="caption" color={colors.textMuted}>
                  {formatTimestamp(c.start)}
                </AppText>
              </View>
            ))}
            {chapters.length > 12 ? (
              <AppText variant="caption" color={colors.textFaint} style={{ marginTop: spacing.xs }}>
                +{chapters.length - 12} more
              </AppText>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  )
}

function Header({ onBack }: { onBack: () => void }) {
  return (
    <View style={styles.header}>
      <IconButton name={icons.back} onPress={onBack} />
    </View>
  )
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  hero: { alignItems: 'center', paddingHorizontal: spacing.xl, gap: spacing.xs },
  title: { textAlign: 'center', marginTop: spacing.md },
  stats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  playBtn: { alignSelf: 'stretch', marginTop: spacing.lg },
  section: { paddingHorizontal: spacing.xl, marginTop: spacing.xl },
  chapterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.hairline,
  },
})
