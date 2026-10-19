/**
 * Contact details: the emails, phones, addresses, links and social accounts of a
 * person in a tree, in the same shapes a network contact keeps them. Network
 * contacts and people share these parsers, so "cell: 555 0100" means the same
 * thing in both places and a person's card can become a contact without loss.
 */
import { clean } from './db.js'

export type Labeled = { label: string | null; value: string }
export type Address = { label: string | null; lines: string }

/** Everything a person's contact card holds. Stored as one JSON column on people. */
export type PersonContact = { emails: Labeled[]; phones: Labeled[]; addresses: Address[]; links: Labeled[]; socials: Labeled[] }
export const CONTACT_KEYS = ['emails', 'phones', 'addresses', 'links', 'socials'] as const
export const emptyContact = (): PersonContact => ({ emails: [], phones: [], addresses: [], links: [], socials: [] })

/**
 * "home: jane@example.com" per line, or a JSON array of {label, value}. The label
 * is optional; a value with no colon-prefixed word is just a value.
 */
export function parseLabeled(input: unknown, max = 20, valueMax = 300): Labeled[] {
  const rows: Labeled[] = Array.isArray(input)
    ? input.map((v: any) => (typeof v === 'string' ? splitLabel(v) : { label: clean(v?.label, 40), value: String(v?.value ?? '') }))
    : String(input ?? '').split(/\r?\n/).map(splitLabel)
  return rows.map((r) => ({ label: clean(r.label, 40), value: clean(r.value, valueMax) ?? '' })).filter((r) => r.value).slice(0, max)
}

function splitLabel(line: string): Labeled {
  // A label is one or two short words before a colon; "https://..." and "+1 (555): x" are not labels.
  const m = line.match(/^\s*([A-Za-z][A-Za-z ]{0,24}):\s*(.+)$/)
  if (m && !/^(https?|mailto|tel)$/i.test(m[1]!.trim())) return { label: m[1]!.trim().toLowerCase(), value: m[2]!.trim() }
  return { label: null, value: line.trim() }
}

/** Addresses: blank-line separated blocks, each optionally starting "home:" on its first line. */
export function parseAddresses(input: unknown, max = 10): Address[] {
  const blocks: Address[] = Array.isArray(input)
    ? input.map((v: any) => ({ label: clean(v?.label, 40), lines: String(v?.lines ?? v?.value ?? '') }))
    : String(input ?? '')
        .split(/\r?\n\s*\r?\n/)
        .map((block) => {
          const first = splitLabel(block.split(/\r?\n/)[0] ?? '')
          const rest = block.split(/\r?\n/).slice(1)
          return { label: first.label, lines: [first.value, ...rest].join('\n') }
        })
  return blocks
    .map((b) => ({ label: clean(b.label, 40), lines: b.lines.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n').slice(0, 600) }))
    .filter((b) => b.lines)
    .slice(0, max)
}

export const formatLabeled = (rows: Labeled[]) => rows.map((r) => (r.label ? `${r.label}: ${r.value}` : r.value)).join('\n')
export const formatAddresses = (rows: Address[]) => rows.map((r) => (r.label ? `${r.label}: ${r.lines}` : r.lines)).join('\n\n')

export const parseEmails = (input: unknown) => parseLabeled(input).map((e) => ({ ...e, value: e.value.toLowerCase() }))
export const parsePhones = (input: unknown) => parseLabeled(input, 20, 60)
export const parseLinks = (input: unknown) => parseLabeled(input, 20, 2000).filter((l) => /^https?:\/\//i.test(l.value))

/** Social networks by the names people type, and how a handle becomes a profile URL. */
const SOCIAL: Record<string, (h: string) => string | null> = {
  instagram: (h) => `https://instagram.com/${h}`,
  facebook: (h) => `https://facebook.com/${h}`,
  x: (h) => `https://x.com/${h}`,
  twitter: (h) => `https://x.com/${h}`,
  tiktok: (h) => `https://tiktok.com/@${h}`,
  threads: (h) => `https://threads.net/@${h}`,
  youtube: (h) => `https://youtube.com/@${h}`,
  linkedin: (h) => `https://linkedin.com/in/${h}`,
  bluesky: (h) => `https://bsky.app/profile/${h}`,
  github: (h) => `https://github.com/${h}`,
  snapchat: (h) => `https://snapchat.com/add/${h}`,
  pinterest: (h) => `https://pinterest.com/${h}`,
  reddit: (h) => `https://reddit.com/user/${h.replace(/^u\//, '')}`,
  twitch: (h) => `https://twitch.tv/${h}`,
  // @name@server.social
  mastodon: (h) => {
    const m = h.match(/^([\w.]+)@([\w.-]+\.[a-z]{2,})$/i)
    return m ? `https://${m[2]}/@${m[1]}` : null
  },
}
const SOCIAL_ALIASES: Record<string, string> = { ig: 'instagram', insta: 'instagram', fb: 'facebook', tt: 'tiktok', yt: 'youtube', bsky: 'bluesky', 'twitter x': 'x', snap: 'snapchat' }
export const SOCIAL_NETWORKS = Object.keys(SOCIAL)

/** "instagram: @tony" or a bare profile URL. A value that is a URL must be http(s); a handle is kept as typed. */
export function parseSocials(input: unknown): Labeled[] {
  return parseLabeled(input, 20, 300)
    .map((s) => ({ label: s.label ? (SOCIAL_ALIASES[s.label] ?? s.label) : socialFromUrl(s.value), value: s.value }))
    // A handle needs its network ("discord: tony" is fine, kept as text); a URL must be http(s); "javascript: …" is neither.
    .filter((s) => !/^(javascript|data|vbscript|file)$/i.test(s.label ?? ''))
    .filter((s) => (/^[a-z][a-z0-9+.-]*:/i.test(s.value) ? /^https?:\/\//i.test(s.value) : Boolean(s.label)))
}

function socialFromUrl(value: string): string | null {
  const host = value.match(/^https?:\/\/(?:www\.|m\.)?([^/]+)/i)?.[1]?.toLowerCase()
  if (!host) return null
  const known: Record<string, string> = { 'instagram.com': 'instagram', 'facebook.com': 'facebook', 'x.com': 'x', 'twitter.com': 'x', 'tiktok.com': 'tiktok', 'threads.net': 'threads', 'youtube.com': 'youtube', 'linkedin.com': 'linkedin', 'bsky.app': 'bluesky', 'github.com': 'github' }
  return known[host] ?? null
}

/** Where a social entry goes: its own URL, or a profile URL built from network + handle. Null when we cannot tell. */
export function socialUrl(s: Labeled): string | null {
  if (/^https?:\/\//i.test(s.value)) return s.value
  const make = s.label ? SOCIAL[s.label] : undefined
  const handle = s.value.replace(/^@/, '').trim()
  if (!make || !handle) return null
  if (s.label === 'mastodon') return make(handle)
  if (!/^[\w.\-/]{1,100}$/.test(handle)) return null
  return make(handle.split('/').map(encodeURIComponent).join('/'))
}

/** The contact card stored on a person row, or an empty one. */
export function readContact(raw: unknown): PersonContact {
  const out = emptyContact()
  if (!raw) return out
  try {
    const v = JSON.parse(String(raw))
    for (const key of CONTACT_KEYS) if (Array.isArray(v?.[key])) (out as any)[key] = v[key]
  } catch {}
  return out
}

export const hasContact = (c: PersonContact) => CONTACT_KEYS.some((k) => c[k].length > 0)

/**
 * Apply whichever contact fields the input names (emails, phones, addresses, links,
 * socials; text or arrays) on top of the current card. Undefined when the input
 * names none, so an edit that never mentioned contact details leaves them alone.
 */
export function mergeContact(current: unknown, input: Record<string, unknown>): string | null | undefined {
  // `contact` is a whole card: an object from the API, or the stored JSON when a person is copied or synced.
  const card = typeof input.contact === 'string' ? readContact(input.contact) : input.contact && typeof input.contact === 'object' ? (input.contact as Record<string, unknown>) : input.contact === null ? emptyContact() : {}
  const given: Record<string, unknown> = { ...card }
  for (const key of CONTACT_KEYS) if (key in input) given[key] = input[key]
  if (!CONTACT_KEYS.some((k) => k in given)) return undefined
  const c = readContact(current)
  if ('emails' in given) c.emails = parseEmails(given.emails)
  if ('phones' in given) c.phones = parsePhones(given.phones)
  if ('addresses' in given) c.addresses = parseAddresses(given.addresses)
  if ('links' in given) c.links = parseLinks(given.links)
  if ('socials' in given) c.socials = parseSocials(given.socials)
  return hasContact(c) ? JSON.stringify(c) : null
}
