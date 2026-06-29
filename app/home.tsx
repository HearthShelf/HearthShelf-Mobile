import { useAuth } from '@clerk/clerk-expo'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { fetchLinkedServers } from '@/api/controlPlane'
import { connectServer } from '@/api/connect'
import { setSession, clearSession } from '@/api/session'
import { clearTrack } from '@/player/store'
import { setAutoSession, clearAutoSession } from '@/player/autoBridge'
import { coverUrl, getItemsInProgress, getLibraries, getLibraryItems, itemAuthor, itemTitle } from '@/api/abs'
import type { ABSLibraryItem } from '@hearthshelf/core'
import { playItemById } from '@/player/playback'
import { NowPlayingBar } from '@/player/NowPlayingBar'

type Status =
  | { phase: 'connecting' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; serverName: string }

export default function HomeScreen() {
  const { getToken, signOut } = useAuth()
  const router = useRouter()
  const [status, setStatus] = useState<Status>({ phase: 'connecting' })
  const [items, setItems] = useState<ABSLibraryItem[]>([])

  // signOut() clears the Clerk session, but this screen isn't the auth gate, so
  // nothing redirects on its own. Tear down our state and navigate explicitly.
  async function handleSignOut() {
    clearTrack()
    clearAutoSession()
    await clearSession()
    await signOut()
    router.replace('/sign-in')
  }

  // Clerk's getToken is a fresh function every render; keep it in a ref so the
  // connect callback stays stable and the mount effect doesn't loop forever.
  const getTokenRef = useRef(getToken)
  getTokenRef.current = getToken

  const connect = useCallback(async () => {
    // The control plane verifies a token minted from the 'hearthshelf' Clerk JWT
    // template (it carries the verified email/username claims) - NOT the default
    // session token. Must match the web app (ClerkTokenBridge).
    const token = () => getTokenRef.current({ template: 'hearthshelf' })
    setStatus({ phase: 'connecting' })
    try {
      const servers = await fetchLinkedServers(token)
      if (servers.length === 0) throw new Error('No linked servers on this account')
      const server = servers[0]

      const { serverUrl, token: absToken } = await connectServer(token, server.id, server.url)
      await setSession({ serverUrl, token: absToken })
      // Hand the server URL + token to the native Android Auto service so the
      // car can browse + play headlessly.
      setAutoSession(serverUrl, absToken)

      // Continue Listening first; fall back to the first library's items.
      let list = await getItemsInProgress()
      if (list.length === 0) {
        const libs = await getLibraries()
        const firstBookLib = libs.find((l) => l.mediaType === 'book') ?? libs[0]
        if (firstBookLib) list = await getLibraryItems(firstBookLib.id, 0, 50)
      }
      setItems(list)
      setStatus({ phase: 'ready', serverName: server.name })
    } catch (e) {
      setStatus({ phase: 'error', message: (e as Error).message })
    }
  }, [])

  useEffect(() => {
    connect()
  }, [connect])

  if (status.phase === 'connecting') {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator />
        <Text style={styles.dim}>Connecting to your server…</Text>
      </SafeAreaView>
    )
  }

  if (status.phase === 'error') {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.error}>{status.message}</Text>
        <TouchableOpacity style={styles.retry} onPress={connect}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleSignOut}>
          <Text style={styles.signOut}>Sign out</Text>
        </TouchableOpacity>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>{status.serverName}</Text>
        <TouchableOpacity onPress={handleSignOut}>
          <Text style={styles.signOut}>Sign out</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.section}>
        {items.length} {items.length === 1 ? 'book' : 'books'} - tap to play
      </Text>
      <FlatList
        data={items}
        keyExtractor={(it) => it.id}
        contentContainerStyle={{ padding: 16 }}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.row} onPress={() => playItemById(item.id)}>
            <Image source={{ uri: coverUrl(item.id) }} style={styles.cover} />
            <View style={styles.meta}>
              <Text style={styles.bookTitle} numberOfLines={2}>
                {itemTitle(item)}
              </Text>
              <Text style={styles.bookAuthor} numberOfLines={1}>
                {itemAuthor(item)}
              </Text>
            </View>
          </TouchableOpacity>
        )}
      />
      <NowPlayingBar />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#14110f' },
  center: { flex: 1, backgroundColor: '#14110f', alignItems: 'center', justifyContent: 'center', gap: 12 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  title: { color: '#f3e9dd', fontSize: 22, fontWeight: '700' },
  section: { color: '#a99', fontSize: 13, paddingHorizontal: 16, paddingTop: 4 },
  row: { flexDirection: 'row', gap: 12, paddingVertical: 8, alignItems: 'center' },
  cover: { width: 56, height: 56, borderRadius: 6, backgroundColor: '#332b25' },
  meta: { flex: 1 },
  bookTitle: { color: '#f3e9dd', fontSize: 16, fontWeight: '600' },
  bookAuthor: { color: '#a99', fontSize: 13, marginTop: 2 },
  dim: { color: '#a99' },
  error: { color: '#e88', textAlign: 'center', paddingHorizontal: 24 },
  retry: { backgroundColor: '#c4633a', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 },
  retryText: { color: '#fff', fontWeight: '600' },
  signOut: { color: '#a99', fontSize: 14 },
})
