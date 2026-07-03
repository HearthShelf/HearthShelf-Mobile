export interface GoodreadsRow {
  title: string
  author: string
  isbn: string | null
  isbn13: string | null
  rating: number | null
  dateFinished: string | null
  exclusiveShelf: string
}

export function parseGoodreadsCsvText(csv: string): GoodreadsRow[] {
  const rows = parseCsv(csv)
  const [header, ...body] = rows
  const index = new Map(header.map((h, i) => [h, i]))
  return body
    .filter((r) => r.some((v) => v.trim()))
    .map((raw) => ({
      title: cell(raw, index, 'Title').trim(),
      author: cell(raw, index, 'Author').trim(),
      isbn: cleanIsbn(cell(raw, index, 'ISBN')),
      isbn13: cleanIsbn(cell(raw, index, 'ISBN13')),
      rating: parseRating(cell(raw, index, 'My Rating')),
      dateFinished: parseDate(cell(raw, index, 'Date Read')),
      exclusiveShelf: cell(raw, index, 'Exclusive Shelf').trim(),
    }))
}

export function isReadRow(row: GoodreadsRow): boolean {
  return row.exclusiveShelf === 'read'
}

function cell(row: string[], index: Map<string, number>, key: string): string {
  const i = index.get(key)
  return i == null ? '' : (row[i] ?? '')
}

function parseCsv(input: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    const next = input[i + 1]
    if (quoted) {
      if (ch === '"' && next === '"') {
        field += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        field += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') {
      field += ch
    }
  }
  row.push(field)
  rows.push(row)
  return rows
}

function cleanIsbn(raw: string | undefined): string | null {
  if (!raw) return null
  const m = raw.match(/^="?(.*?)"?$/)
  const value = (m ? m[1] : raw).trim()
  return value && value !== '0' ? value : null
}

function parseRating(raw: string | undefined): number | null {
  const n = Number(raw)
  return raw && Number.isFinite(n) && n > 0 ? n : null
}

function parseDate(raw: string | undefined): string | null {
  const trimmed = (raw || '').trim()
  if (!trimmed) return null
  const m = trimmed.match(/^(\d{4})\/(\d{2})\/(\d{2})$/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}
