/**
 * Reading posts made elsewhere into the shape /api/v1/social/posts takes, and the likes,
 * reposts and replies from each network's public API. Runs in the CLI, on the machine
 * that did the posting; the server never calls out to a network.
 *
 * myna (mynaposter) keeps every send in ~/.config/myna/history.json as
 * {entries: [{at, accountId: "bluesky:you.bsky.social", network, text, title?, ok, postId, url}]}.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export type OutPost = {
  url: string
  network: string
  account: string
  account_url: string | null
  text: string
  posted_at: string
  likes?: number
  reposts?: number
  replies?: number
  /** The network's own id, for reading counts; not sent. */
  postId?: string | null
}

export const MYNA_HISTORY = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'myna', 'history.json')

/** RFC 2606 names: test posts, never real ones. */
const TEST_HOST = /(^|\.)(example\.(com|org|net)|test|invalid|localhost)$/i

/** Where an account lives on the web, from its id and one of its post URLs. */
export function accountUrl(account: string, postUrl: string): string | null {
  const [network, ...rest] = account.split(':')
  const handle = rest.join(':')
  let origin = ''
  try {
    origin = new URL(postUrl).origin
  } catch {
    return null
  }
  switch (network) {
    case 'bluesky':
      return `https://bsky.app/profile/${handle}`
    case 'mastodon': {
      const [user, host] = handle.split('@')
      return user && host ? `https://${host}/@${user}` : null
    }
    case 'devto':
      return `https://dev.to/${handle}`
    case 'linkedin':
      return null
    case 'htmlblog':
      return `https://${handle.replace(/\/?$/, '/')}`
    case 'gitblog': {
      const u = new URL(postUrl)
      return `${u.origin}${u.pathname.replace(/\/[^/]*$/, '/')}`
    }
    default:
      return origin ? `${origin}/` : null
  }
}

/** Successful sends with a public URL, newest first, one per URL. */
export function fromMyna(history: unknown, opts: { skip?: string[] } = {}): OutPost[] {
  const entries = Array.isArray(history) ? history : ((history as { entries?: unknown[] })?.entries ?? [])
  const skip = new Set(opts.skip ?? [])
  const seen = new Set<string>()
  const out: OutPost[] = []
  for (const raw of entries as Record<string, any>[]) {
    if (!raw?.ok || typeof raw.url !== 'string' || typeof raw.accountId !== 'string') continue
    let host = ''
    try {
      const u = new URL(raw.url)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue
      host = u.hostname
    } catch {
      continue
    }
    if (TEST_HOST.test(host) || skip.has(raw.accountId) || seen.has(raw.url)) continue
    seen.add(raw.url)
    const network = String(raw.network ?? raw.accountId.split(':')[0])
    const text = String(raw.title && raw.text ? `${raw.title}\n\n${raw.text}` : (raw.title ?? raw.text ?? ''))
    out.push({ url: raw.url, network, account: raw.accountId, account_url: accountUrl(raw.accountId, raw.url), text: text.slice(0, 5000), posted_at: new Date(raw.at).toISOString(), postId: raw.postId ? String(raw.postId) : null })
  }
  return out.sort((a, b) => b.posted_at.localeCompare(a.posted_at))
}

const UA = 'familyancestry-cli (+https://family.ancestry.pit.world)'

async function getJson(url: string, fetchImpl: typeof fetch): Promise<any | null> {
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(10_000) })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

/**
 * Fill likes, reposts and replies on posts since `since`, from public, keyless APIs:
 * Bluesky's AppView (25 posts a call), each Mastodon server, dev.to. Other networks
 * keep no public count and are left alone. Returns how many posts got numbers.
 */
export async function fillCounts(posts: OutPost[], opts: { since?: number; fetchImpl?: typeof fetch; pauseMs?: number } = {}): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const since = opts.since ?? 0
  const pause = () => (opts.pauseMs ? new Promise((r) => setTimeout(r, opts.pauseMs)) : Promise.resolve())
  const recent = posts.filter((p) => p.postId && Date.parse(p.posted_at) >= since)
  let filled = 0

  const sky = recent.filter((p) => p.network === 'bluesky')
  for (let i = 0; i < sky.length; i += 25) {
    const batch = sky.slice(i, i + 25)
    const qs = batch.map((p) => `uris=${encodeURIComponent(p.postId!.split('|')[0]!)}`).join('&')
    const r = await getJson(`https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?${qs}`, fetchImpl)
    for (const v of (r?.posts ?? []) as any[]) {
      const p = batch.find((x) => x.postId!.split('|')[0] === v.uri)
      if (!p) continue
      Object.assign(p, { likes: v.likeCount ?? 0, reposts: (v.repostCount ?? 0) + (v.quoteCount ?? 0), replies: v.replyCount ?? 0 })
      filled++
    }
    await pause()
  }
  for (const p of recent.filter((x) => x.network === 'mastodon')) {
    const host = p.account.split('@').pop()
    const v = host ? await getJson(`https://${host}/api/v1/statuses/${encodeURIComponent(p.postId!)}`, fetchImpl) : null
    if (v && typeof v.favourites_count === 'number') {
      Object.assign(p, { likes: v.favourites_count, reposts: v.reblogs_count ?? 0, replies: v.replies_count ?? 0 })
      filled++
    }
    await pause()
  }
  for (const p of recent.filter((x) => x.network === 'devto')) {
    const v = /^\d+$/.test(p.postId!) ? await getJson(`https://dev.to/api/articles/${p.postId}`, fetchImpl) : null
    if (v && typeof v.public_reactions_count === 'number') {
      Object.assign(p, { likes: v.public_reactions_count, replies: v.comments_count ?? 0 })
      filled++
    }
    await pause()
  }
  return filled
}
