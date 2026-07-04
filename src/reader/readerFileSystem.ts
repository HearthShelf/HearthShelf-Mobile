/**
 * FileSystem adapter for @epubjs-react-native/core.
 *
 * The Reader component expects a `fileSystem()` hook returning a fixed shape
 * (documentDirectory, read/write/delete, downloadFile, getFileInfo, ...) that it
 * uses to stage epub.js/jszip into the WebView and, for URL sources, to download
 * the book. The published @epubjs-react-native/expo-file-system provider imports
 * these off the modern `expo-file-system` entry - but on SDK 57 the classic
 * functions moved to `expo-file-system/legacy`, so that provider's names resolve
 * to undefined and the reader breaks. This adapter binds the same interface to
 * the legacy entry, which is where the app already reads its download engine
 * from (see src/player/downloads.ts).
 *
 * We only ever pass base64 sources (see the reader screen), so downloadFile is a
 * defensive stub - present to satisfy the interface, not exercised.
 */
import {
  documentDirectory,
  cacheDirectory,
  bundleDirectory,
  readAsStringAsync,
  writeAsStringAsync,
  deleteAsync,
  getInfoAsync,
  downloadAsync,
} from 'expo-file-system/legacy'

export interface ReaderFileSystem {
  file: string | null
  progress: number
  downloading: boolean
  size: number
  error: string | null
  success: boolean
  documentDirectory: string | null
  cacheDirectory: string | null
  bundleDirectory: string | undefined
  readAsStringAsync: (
    fileUri: string,
    options?: { encoding?: 'utf8' | 'base64' },
  ) => Promise<string>
  writeAsStringAsync: (
    fileUri: string,
    contents: string,
    options?: { encoding?: 'utf8' | 'base64' },
  ) => Promise<void>
  deleteAsync: (fileUri: string) => Promise<void>
  downloadFile: (
    fromUrl: string,
    toFile: string,
  ) => Promise<{ uri: string | null; mimeType: string | null }>
  getFileInfo: (
    fileUri: string,
  ) => Promise<{ uri: string; exists: boolean; isDirectory: boolean; size: number | undefined }>
}

export function useReaderFileSystem(): ReaderFileSystem {
  return {
    file: null,
    progress: 0,
    downloading: false,
    size: 0,
    error: null,
    success: false,
    documentDirectory: documentDirectory ?? null,
    cacheDirectory: cacheDirectory ?? null,
    bundleDirectory: bundleDirectory ?? undefined,
    readAsStringAsync: (fileUri, options) =>
      readAsStringAsync(fileUri, options?.encoding === 'base64' ? { encoding: 'base64' } : {}),
    writeAsStringAsync: (fileUri, contents, options) =>
      writeAsStringAsync(
        fileUri,
        contents,
        options?.encoding === 'base64' ? { encoding: 'base64' } : {},
      ),
    deleteAsync: (fileUri) => deleteAsync(fileUri, { idempotent: true }),
    downloadFile: async (fromUrl, toFile) => {
      const res = await downloadAsync(fromUrl, toFile)
      return { uri: res.uri, mimeType: res.headers['content-type'] ?? null }
    },
    getFileInfo: async (fileUri) => {
      const info = await getInfoAsync(fileUri)
      return {
        uri: fileUri,
        exists: info.exists,
        isDirectory: info.exists ? info.isDirectory : false,
        size: info.exists ? (info as { size?: number }).size : undefined,
      }
    },
  }
}
