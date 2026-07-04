/**
 * System time-format helpers. The app stores clock times as 24-hour "HH:MM"
 * strings (stable, locale-independent) but displays them in the user's system
 * format (12-hour with AM/PM, or 24-hour), matching what the OS clock shows.
 */

/** True if the device's locale/clock uses 12-hour (AM/PM) time. */
export function uses12HourClock(): boolean {
  try {
    const opts = new Intl.DateTimeFormat([], { hour: 'numeric' }).resolvedOptions() as {
      hour12?: boolean
      hourCycle?: string
    }
    if (typeof opts.hour12 === 'boolean') return opts.hour12
    if (opts.hourCycle) return opts.hourCycle === 'h11' || opts.hourCycle === 'h12'
  } catch {
    // Intl missing/limited: fall back to formatting a known PM time and sniffing.
  }
  const probe = new Date(2000, 0, 1, 13, 0, 0).toLocaleTimeString()
  return /am|pm/i.test(probe)
}

/** Parse a stored "HH:MM" (24-hour) string into {h, m}. Invalid -> 00:00. */
export function parseHHMM(value: string): { h: number; m: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value?.trim() ?? '')
  if (!match) return { h: 0, m: 0 }
  const h = Math.min(23, Math.max(0, parseInt(match[1], 10)))
  const m = Math.min(59, Math.max(0, parseInt(match[2], 10)))
  return { h, m }
}

/** Serialize an hour/minute back to the stored "HH:MM" 24-hour form. */
export function toHHMM(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Format an hour/minute for display in the system's 12h/24h format. */
export function formatClock(h: number, m: number): string {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** Format a stored "HH:MM" string for display in the system format. */
export function formatHHMM(value: string): string {
  const { h, m } = parseHHMM(value)
  return formatClock(h, m)
}
