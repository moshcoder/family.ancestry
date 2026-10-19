/**
 * The family.ancestry server: pages for people, /api/v1 for programs.
 *
 *   bun src/server.ts            PORT (8792), ANCESTRY_DATA_DIR, ANCESTRY_SITE,
 *                                RESEND_API_KEY + MAIL_FROM for sign-in links
 *                                ADMIN_EMAILS (their trees are on the Family plan, free)
 *                                COINPAY_API_KEY, COINPAY_BUSINESS_ID, COINPAY_WEBHOOK_SECRET,
 *                                FAMILY_PLAN_USD (49) for the one-time Family plan
 */
import { Hono, type Context } from 'hono'
import { startPitFooterRefresh } from './pit-footer.js'
import { startRingFooterRefresh } from './ring-footer.js'
import { RING_PLACEHOLDER, ringBar, startRingRefresh, visitorOnMoshpit } from './ring.js'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { createBridgeClient } from '@profullstack/bridges'
import { join } from 'node:path'
import { BONDS, CHILD_RELATIONS, Store, UNION_KINDS, unionStatus, bondKind, canEdit, canManage, grantable, inviteRole, fullName, type Business, type InviteRole, newId, type Person, type Role, type Tree, type User } from './db.js'
import { Auth, SESSION_COOKIE, consoleMailer, resendMailer, resendStatus, safeNext, validEmail, verifyResendWebhook, type Mailer, type MailStatus } from './auth.js'
import { exportGedcom, importGedcom, describeImport } from './gedcom.js'
import { CONTACT_KEYS, readContact } from './contact.js'
import { describeRelation } from './relate.js'
import { CHAIN_LABELS, SETTLED, hasPlan, isAdmin, planFromEnv, price, readWebhook, startCheckout, verifyWebhook, type PlanConfig } from './plan.js'
import * as html from './html.js'
import { Network } from './network.js'
import { mountNetwork } from './network-routes.js'
import { Local, mountLocal } from './local.js'
import { Feed, mountFeed, personPosts } from './feed.js'
import { mountBusinesses, personBusinesses, personBusinessesOut } from './business.js'
import { mountAlbums } from './album.js'
import { listingPanel, Listings, mountListings } from './listing.js'
import { businessDirectory, mountTeams, teamPanel, Teams } from './team.js'
import { mountProfiles, Profiles, settingsPanel as profilePanel } from './profile.js'
import { changesTree, lifeEventForm, lifeKey, recordLifeEvent, timeline as lifeTimeline } from './life.js'
import { addonsPanel, inviteFriendBox, personNetworkBox, profileInvite } from './network-html.js'
import { Famous, mountFamous } from './famous.js'
import { buildDaemon } from './daemon.js'

type Env = { Variables: { user: User | null; csrf: string; via: 'session' | 'token' | null } }

const CSRF_COOKIE = 'fa_csrf'
const MAX_PHOTO = 8 * 1024 * 1024
const MAX_GEDCOM = 25 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'])

/**
 * `publicSite` opens in any browser: family.ancestry.pit.world, pit.world's relay of
 * the Moshpit name for people who are not on Moshpit DNS. Links we email to someone
 * else (invites) use it, because we cannot know which internet they are on.
 */
export type AppOptions = { store: Store; auth: Auth; site: string; publicSite?: string; publicDir?: string; net?: Network; plan?: PlanConfig; fetcher?: typeof fetch; pitWorld?: PitWorldSignIn | null; redirectHosts?: string[]; mailStatus?: ((id: string) => Promise<MailStatus | null>) | null; resendWebhookSecret?: string | null; famous?: Famous; daemonStatus?: () => Promise<unknown> }

/** Sign in with pit.world: the one account for every *.pit.world site. The secret is HMAC-SHA256(PIT_BRIDGE_KEY, our relay host), which pit.world derives too. */
export type PitWorldSignIn = { secret: string; base?: string; fetch?: typeof fetch }

/** Up to `max` addresses from "a@b.com, c@d.com" or one per line. */
export const parseEmails = (value: unknown, max = 20): string[] => parseInvitees(value, max).map((i) => i.email)

/**
 * Every address in whatever was pasted (a mail client's To line, a spreadsheet
 * column, "Aunt Karen <karen@x.com>", one per line), each once, with the name
 * written beside it when there is one.
 */
export function parseInvitees(value: unknown, max = 20): { email: string; name: string | null }[] {
  const out = new Map<string, string | null>()
  for (const line of String(value ?? '').split(/[\n;]+/)) {
    // A name is whatever sits between the previous address and this one: "Doe, Jane" <j@x.com>, Liz<TAB>liz@z.net.
    let from = 0
    for (const m of line.matchAll(/[^\s<>()"',;:]+@[^\s<>()"',;:]+\.[^\s<>()"',;:]+/g)) {
      const before = line.slice(from, m.index)
      from = m.index! + m[0].length
      const email = validEmail(m[0])
      if (!email || out.has(email)) continue
      const name = before.replace(/[<>()"\[\]\t]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s,:-]+|[\s,:-]+$/g, '').trim()
      out.set(email, name && !name.includes('@') ? name.slice(0, 120) : null)
    }
  }
  return [...out].slice(0, max).map(([email, name]) => ({ email, name }))
}

/** Tiny fixed-window limiter, per key. Enough to stop a script from mailing a stranger 1,000 sign-in links. */
function limiter(limit: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>()
  return (key: string) => {
    const now = Date.now()
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k)
    const entry = hits.get(key)
    if (!entry || entry.reset < now) {
      hits.set(key, { n: 1, reset: now + windowMs })
      return true
    }
    entry.n++
    return entry.n <= limit
  }
}

/** "Jane Doe (1901–1980) #abc123" from the datalist -> abc123. */
export const pickId = (value: unknown): string | null => String(value ?? '').match(/#([A-Za-z0-9_-]{6,})\s*$/)?.[1] ?? (/^[A-Za-z0-9_-]{6,}$/.test(String(value ?? '').trim()) ? String(value).trim() : null)

export function createApp({ store, auth, site, publicSite = site, publicDir = join(import.meta.dir, '..', 'public'), net = new Network(store), plan = planFromEnv({}), fetcher = fetch, pitWorld = null, redirectHosts = [], mailStatus = null, resendWebhookSecret = null, famous = new Famous(store), daemonStatus }: AppOptions) {
  // A request relayed by pit.world says so in X-Forwarded-Host; a sign-in link for it must open there too.
  // Only the one configured address is believed, so a forged header can at worst pick that address.
  const publicHost = new URL(publicSite).host
  const linkBase = (c: Context) => (publicSite !== site && c.req.header('x-forwarded-host') === publicHost ? publicSite : site)
  const app = new Hono<Env>()
  const linkLimit = limiter(10, 15 * 60_000)
  // People, not campaigns: a day's worth of invitations per sender (and per recipient), an hour's worth of messages.
  const inviteLimit = limiter(40, 24 * 60 * 60_000)
  // A family on the Family plan invites whoever they like; the cap is only there to stop a runaway script.
  const familyInviteLimit = limiter(2000, 24 * 60 * 60_000)
  const paidSender = (userId: string) => store.inPaidTree(userId) || isAdmin(plan, store.user(userId))
  const senderLimit = (key: string) => (key.startsWith('invite:') && paidSender(key.slice('invite:'.length)) ? familyInviteLimit(key) : inviteLimit(key))
  /** How many addresses one paste may hold, for this tree. */
  const pasteMax = (tree: Tree) => (hasPlan(plan, store, tree) ? 500 : 20)
  const messageLimit = limiter(120, 60 * 60_000)
  // Asking a listed family for an invite: a few an hour from one address, a few a day per email, a busy day per tree.
  const askIpLimit = limiter(5, 60 * 60_000)
  const askEmailLimit = limiter(3, 24 * 60 * 60_000)
  const askTreeLimit = limiter(50, 24 * 60 * 60_000)
  const askLimit = (key: string) => (key.startsWith('ip:') ? askIpLimit(key) : key.startsWith('email:') ? askEmailLimit(key) : askTreeLimit(key))
  const listings = new Listings(store)
  const teams = new Teams(store)
  const profiles = new Profiles(store)
  const feed = new Feed(store, net)
  /**
   * The posts panel on a person page. It is yours to post on when you claimed it, or when it
   * carries your account's name (one person, two accounts: only one of them can claim it).
   */
  const postsFor = (c: Context, tree: Tree, person: Person, holder: User | null, me: User) => {
    if (person.kind !== 'person') return ''
    const mine = holder?.id === me.id || Boolean(me.name && fullName(person).toLowerCase() === me.name.trim().toLowerCase())
    // Whoever claimed them, and members of this tree whose account carries their name.
    const named = store.members(tree.id).filter((m) => store.user(m.user_id)?.name?.trim().toLowerCase() === fullName(person).toLowerCase()).map((m) => m.user_id)
    const authors = [...new Set([holder?.id, mine ? me.id : null, ...named].filter((x): x is string => Boolean(x)))]
    const items = authors.flatMap((a) => feed.of(me.id, a, { limit: 5 })).sort((a, b) => b.created_at - a.created_at).slice(0, 5)
    return personPosts(ctx(c), me, { tree, families: store.treesFor(me.id).map((x) => store.tree(x.id)!), items, canPost: mine, back: `/t/${tree.id}/p/${person.id}` })
  }
  const secure = (c: Context) => (c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '')) === 'https'
  const ip = (c: Context) => c.req.header('x-real-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'

  // Other names for the site (family.tree): one permanent redirect to the same path here. Asked through
  // pit.world's relay (family.tree.pit.world), it goes to our relay address instead, so a visitor without
  // Moshpit DNS stays on a host their browser can open.
  const aliases = new Set(redirectHosts.map((h) => h.toLowerCase()))
  if (aliases.size)
    app.use('*', async (c, next) => {
      const host = (c.req.header('host') ?? '').toLowerCase().replace(/:\d+$/, '')
      if (!aliases.has(host)) return next()
      const relayed = c.req.header('x-forwarded-host')?.toLowerCase() === `${host}.pit.world`
      const url = new URL(c.req.url)
      return c.redirect(`${relayed ? publicSite : site}${url.pathname}${url.search}`, 301)
    })

  app.use('*', async (c, next) => {
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1]
    const tokenUser = bearer ? auth.tokenUser(bearer) : null
    const sessionUser = tokenUser ? null : auth.sessionUser(getCookie(c, SESSION_COOKIE))
    c.set('user', tokenUser ?? sessionUser)
    c.set('via', tokenUser ? 'token' : sessionUser ? 'session' : null)
    let csrf = getCookie(c, CSRF_COOKIE)
    if (!csrf || !/^[A-Za-z0-9_-]{16,64}$/.test(csrf)) {
      csrf = newId(16)
      setCookie(c, CSRF_COOKIE, csrf, { path: '/', httpOnly: true, sameSite: 'Lax', secure: secure(c), maxAge: 60 * 60 * 24 * 365 })
    }
    c.set('csrf', csrf)

    // Cross-site writes are refused. A bearer token cannot be sent by a browser on its own, so it is exempt.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.get('via') !== 'token') {
      const fetchSite = c.req.header('sec-fetch-site')
      if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return c.text('cross-site request refused', 403)
      const type = c.req.header('content-type') ?? ''
      if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
        const body = await c.req.parseBody({ all: false }).catch(() => ({}) as Record<string, unknown>)
        ;(c as any).formBody = body
        if (body._csrf !== csrf) return c.html(html.messagePage(ctx(c), 'That form expired', 'Go back, reload the page and try again.'), 403)
      } else if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/auth/passkey')) {
        const origin = c.req.header('origin')
        if (origin && new URL(origin).host !== new URL(c.req.url).host && new URL(origin).host !== new URL(site).host) return c.json({ error: 'cross-site request refused' }, 403)
      }
    }
    await next()
    // The Moshpit ring bar is drawn per request: direct links for a visitor on Moshpit DNS, gateway links otherwise.
    if ((c.res.headers.get('content-type') ?? '').includes('text/html')) {
      const page = await c.res.text()
      const bar = ringBar('family.ancestry', visitorOnMoshpit('family.ancestry', c.req.header('host'), c.req.header('x-moshpit-name')))
      c.res = new Response(page.replace(RING_PLACEHOLDER, bar), c.res)
    }
    c.header('x-content-type-options', 'nosniff')
    c.header('referrer-policy', 'same-origin')
    c.header('x-frame-options', 'DENY')
    if ((c.res.headers.get('content-type') ?? '').includes('text/html')) {
      c.header('content-security-policy', "default-src 'self'; frame-src https://crawlproof.com; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self' https://crawlproof.com; connect-src 'self' https://crawlproof.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self' http://127.0.0.1:* http://localhost:*")
      c.header('cache-control', 'no-store')
    }
  })

  /** The words for how b is to a, with half- and step-siblings named properly. */
  const relate = (treeId: string, a: string, b: string) => {
    const path = store.relationship(treeId, a, b)
    const sibling = store.siblings(treeId, a).find((s) => s.person.id === b)
    // No family line between them: a bond says what they are to each other (a friend, a godparent).
    const bond = !path && !sibling ? store.bondsFor(treeId, a).find((x) => x.other.id === b && x.kind !== 'pet') : null
    return { path, words: bond ? bond.label.toLowerCase() : describeRelation(path, sibling) }
  }

  const form = async (c: Context): Promise<Record<string, any>> => (c as any).formBody ?? (await c.req.parseBody().catch(() => ({})))
  const ctx = (c: Context, extra: Partial<html.Ctx> = {}): html.Ctx => ({ user: c.get('user'), csrf: c.get('csrf'), flash: c.req.query('ok') ?? null, error: c.req.query('error') ?? null, unread: c.get('user') ? net.unreadCount(c.get('user')!.id) : 0, ...extra })
  const signIn = (c: Context, user: User) => {
    setCookie(c, SESSION_COOKIE, auth.createSession(user.id), { path: '/', httpOnly: true, sameSite: 'Lax', secure: secure(c), maxAge: 60 * 60 * 24 * 90 })
    // Came from pit.world with no account linked, then signed in the usual way: that account is theirs.
    const pendingToken = getCookie(c, 'fa_pw_pending')
    const pending = store.heldIdentity(pendingToken)
    if (pendingToken) {
      store.dropHeldIdentity(pendingToken)
      deleteCookie(c, 'fa_pw_pending', { path: '/' })
    }
    if (pending && !store.userByIdentity(pending.provider, pending.subject) && !store.identities(user.id).some((i) => i.provider === pending.provider)) store.linkIdentity(user.id, pending.provider, pending.subject)
  }

  /** The tree and the caller's role in it, or a response that ends the request. */
  type TreeAccess = { error: Response; tree?: never; role?: never; user?: never } | { error?: undefined; tree: Tree; role: Role; user: User }
  const treeFor = (c: Context, need: 'view' | 'edit' | 'manage' | 'owner' = 'view'): TreeAccess => {
    const user = c.get('user')
    const tree = store.tree(c.req.param('tree')!)
    const role = tree ? store.role(tree.id, user?.id) : null
    const api = c.req.path.startsWith('/api/')
    const fail = (status: 401 | 403 | 404, message: string) => (api ? c.json({ error: message }, status) : status === 401 ? c.redirect(`/signin?next=${encodeURIComponent(c.req.path)}`) : c.html(html.messagePage(ctx(c), status === 404 ? 'Not found' : 'Not allowed', message), status))
    if (!user) return { error: fail(401, 'sign in first') as Response }
    // A tree you are not a member of is indistinguishable from one that does not exist.
    if (!tree || !role) return { error: fail(404, 'No such tree, or it has not been shared with you.') as Response }
    if (need === 'edit' && !canEdit(role)) return { error: fail(403, 'You can view this tree but not change it. Ask its owner to make you an editor.') as Response }
    if (need === 'manage' && !canManage(role)) return { error: fail(403, 'Only the owner or an admin can do that.') as Response }
    if (need === 'owner' && role !== 'owner') return { error: fail(403, 'Only the owner can do that.') as Response }
    return { tree, role: role as Role, user }
  }

  // ---- static + health --------------------------------------------------

  app.get('/health', (c) => c.json({ ok: true, version: html.VERSION }))
  const statics: Record<string, string> = {
    '/style.css': 'text/css; charset=utf-8',
    '/app.js': 'text/javascript; charset=utf-8',
    '/sw.js': 'text/javascript; charset=utf-8',
    '/manifest.webmanifest': 'application/manifest+json',
    '/favicon.svg': 'image/svg+xml',
    '/icon-192.png': 'image/png',
    '/icon-512.png': 'image/png',
    '/icon-maskable-512.png': 'image/png',
    '/apple-touch-icon.png': 'image/png',
    '/moshpit-root-ca.crt': 'application/x-x509-ca-cert',
    '/offline.html': 'text/html; charset=utf-8',
  }
  for (const [path, type] of Object.entries(statics)) {
    app.get(path, async (c) => {
      const file = Bun.file(join(publicDir, path))
      if (!(await file.exists())) return c.notFound()
      const cache = path === '/sw.js' || path === '/manifest.webmanifest' ? 'no-cache' : c.req.query('v') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'
      return new Response(file, { headers: { 'content-type': type, 'cache-control': cache } })
    })
  }

  // ---- pages: signed out ------------------------------------------------

  app.get('/', (c) => (c.get('user') ? c.redirect('/trees') : c.html(html.homePage(ctx(c)))))
  app.get('/about', (c) => c.html(html.aboutPage(ctx(c))))
  app.get('/connect', (c) => c.html(html.connectPage(ctx(c), site)))
  app.get('/signin', (c) => c.html(html.signInPage(ctx(c), safeNext(c.req.query('next')))))
  app.get('/signup', (c) => c.html(html.signInPage(ctx(c), safeNext(c.req.query('next')))))

  app.post('/auth/link', async (c) => {
    const body = await form(c)
    const email = validEmail(body.email)
    if (!email) return c.html(html.signInPage(ctx(c, { error: 'That does not look like an email address.' }), safeNext(body.next)), 400)
    // Same answer whether the address is new, known, or rate-limited.
    if (linkLimit(`ip:${ip(c)}`) && linkLimit(`email:${email}`)) await auth.sendLink(email, safeNext(body.next), linkBase(c))
    return c.html(html.checkEmailPage(ctx(c)))
  })

  app.get('/auth/verify', (c) => {
    const result = auth.consumeLink(c.req.query('token') ?? '')
    if (!result) return c.html(html.messagePage(ctx(c), 'That link has expired', 'Sign-in links work once, for 20 minutes. Ask for a new one.', '<p><a class="btn" href="/signin">Sign in</a></p>'), 400)
    signIn(c, result.user)
    return c.redirect(result.next ?? '/trees')
  })

  // ---- sign in with pit.world ------------------------------------------
  // The bridge runs on our relay host (family.ancestry.pit.world): pit.world sends codes only to
  // exact callbacks on its own subdomains. Signed in already, it links pit.world to this account;
  // signed out, a linked pit.world account signs in, and a new one gets an account of its own.
  // Email never links accounts: pit.world (CoinPay) cannot vouch for it.
  const pitBase = (pitWorld?.base ?? 'https://pit.world').replace(/\/+$/, '')
  const pitClient = pitWorld
    ? createBridgeClient({ authorizeUrl: `${pitBase}/bridge/authorize`, tokenUrl: `${pitBase}/bridge/token`, clientId: publicHost, clientSecret: pitWorld.secret, redirectUri: `${publicSite}/auth/bridge/callback`, ...(pitWorld.fetch ? { fetch: pitWorld.fetch } : {}) })
    : null
  app.get('/auth/pitworld', async (c) => {
    if (!pitClient) return c.redirect('/signin')
    const next = safeNext(c.req.query('next')) ?? (c.get('user') ? '/settings' : '/trees')
    // Only the relay host has a callback pit.world accepts; send Moshpit visitors there first.
    if (publicSite !== site && c.req.header('x-forwarded-host') !== publicHost) return c.redirect(`${publicSite}/auth/pitworld?next=${encodeURIComponent(next)}`)
    const started = await pitClient.begin({ returnTo: next })
    setCookie(c, 'fa_pw_state', started.cookie, { path: '/auth/bridge', httpOnly: true, sameSite: 'Lax', secure: secure(c), maxAge: started.maxAge })
    return c.redirect(started.url)
  })
  app.get('/auth/bridge/callback', async (c) => {
    if (!pitClient) return c.redirect('/signin')
    const result = await pitClient.complete(new URL(c.req.url).searchParams, getCookie(c, 'fa_pw_state'))
    deleteCookie(c, 'fa_pw_state', { path: '/auth/bridge' })
    if (!result.ok) return c.html(html.messagePage(ctx(c), 'Sign-in did not finish', `pit.world said: ${result.error}. Try again.`, '<p><a class="btn" href="/signin">Sign in</a></p>'), 400)
    const sub = result.user.sub
    const me = c.get('user') as User | null
    const linked = store.userByIdentity('pitworld', sub)
    if (me) {
      if (linked && linked.id !== me.id) return c.redirect(`/settings?error=${encodeURIComponent('That pit.world account is already linked to another family.ancestry account.')}`)
      store.linkIdentity(me.id, 'pitworld', sub)
      return c.redirect('/settings?ok=pit.world%20linked')
    }
    if (linked) {
      signIn(c, linked)
      return c.redirect(safeNext(result.returnTo) ?? '/trees')
    }
    // Not linked yet. Never guess (email cannot link: pit.world cannot vouch for it), and never
    // quietly make a second, empty account for someone who already has one: ask.
    setCookie(c, 'fa_pw_pending', store.holdIdentity('pitworld', sub, result.user.name ?? null), { path: '/', httpOnly: true, sameSite: 'Lax', secure: secure(c), maxAge: 30 * 60 })
    return c.html(html.pitWorldChoicePage(ctx(c), result.user.name ?? null, safeNext(result.returnTo)))
  })
  app.post('/auth/pitworld/new', (c) => {
    const token = getCookie(c, 'fa_pw_pending')
    const held = store.heldIdentity(token)
    if (!token || !held) return c.redirect('/signin')
    store.dropHeldIdentity(token)
    deleteCookie(c, 'fa_pw_pending', { path: '/' })
    const user = store.userByIdentity(held.provider, held.subject) ?? store.createBridgedUser(held.provider, held.subject, held.name)
    signIn(c, user)
    return c.redirect('/trees')
  })
  app.post('/settings/pitworld/unlink', (c) => {
    if (needUser(c)) return needUser(c)!
    const me = c.get('user')!
    // An account made by pit.world has no email to sign in with, so it keeps its link.
    if (me.email.endsWith('@pit.invalid')) return c.redirect(`/settings?error=${encodeURIComponent('This account signs in only with pit.world, so it stays linked.')}`)
    store.unlinkIdentity(me.id, 'pitworld')
    return c.redirect('/settings?ok=Unlinked')
  })

  app.post('/auth/signout', (c) => {
    auth.endSession(getCookie(c, SESSION_COOKIE))
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.redirect('/')
  })

  // ---- passkeys ---------------------------------------------------------

  app.post('/auth/passkey/register/options', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'sign in first' }, 401)
    const { options, challengeId } = await auth.registrationOptions(user)
    setCookie(c, 'fa_chal', challengeId, { path: '/auth/passkey', httpOnly: true, sameSite: 'Strict', secure: secure(c), maxAge: 300 })
    return c.json(options)
  })
  app.post('/auth/passkey/register/verify', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'sign in first' }, 401)
    const body = (await c.req.json().catch(() => null)) as any
    const ok = body && (await auth.finishRegistration(user, getCookie(c, 'fa_chal'), body.response ?? body, body.label ?? null))
    deleteCookie(c, 'fa_chal', { path: '/auth/passkey' })
    return ok ? c.json({ ok: true }) : c.json({ error: 'that passkey could not be verified' }, 400)
  })
  app.post('/auth/passkey/login/options', async (c) => {
    const { options, challengeId } = await auth.authenticationOptions()
    setCookie(c, 'fa_chal', challengeId, { path: '/auth/passkey', httpOnly: true, sameSite: 'Strict', secure: secure(c), maxAge: 300 })
    return c.json(options)
  })
  app.post('/auth/passkey/login/verify', async (c) => {
    const body = (await c.req.json().catch(() => null)) as any
    const user = body ? await auth.finishAuthentication(getCookie(c, 'fa_chal'), body) : null
    deleteCookie(c, 'fa_chal', { path: '/auth/passkey' })
    if (!user) return c.json({ error: 'that passkey was not recognised' }, 401)
    signIn(c, user)
    return c.json({ ok: true, next: safeNext(body.next) ?? '/trees' })
  })

  // ---- CLI sign-in (authorization code + PKCE) ---------------------------

  app.get('/cli/authorize', (c) => {
    const q = c.req.query()
    if (!c.get('user')) return c.redirect(`/signin?next=${encodeURIComponent(`/cli/authorize?${new URLSearchParams(q)}`)}`)
    if (q.code_challenge_method && q.code_challenge_method !== 'S256') return c.html(html.messagePage(ctx(c), 'Not supported', 'Only S256 PKCE challenges are accepted.'), 400)
    if (!Auth.loopback(q.redirect_uri ?? '') || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge ?? '')) return c.html(html.messagePage(ctx(c), 'Bad request', 'This sign-in link is malformed. Run ancestry login again.'), 400)
    return c.html(html.cliAuthorizePage(ctx(c), { challenge: q.code_challenge!, redirect: q.redirect_uri!, state: q.state ?? '', label: (q.label ?? 'ancestry CLI').slice(0, 80) }))
  })
  app.post('/cli/authorize', async (c) => {
    const user = c.get('user')
    if (!user) return c.redirect('/signin')
    const body = await form(c)
    try {
      const code = auth.issueCliCode(user.id, String(body.code_challenge), String(body.redirect_uri), String(body.label ?? 'ancestry CLI'))
      const url = new URL(String(body.redirect_uri))
      url.searchParams.set('code', code)
      url.searchParams.set('state', String(body.state ?? ''))
      return c.redirect(url.toString())
    } catch (error) {
      return c.html(html.messagePage(ctx(c), 'Could not sign in the CLI', (error as Error).message), 400)
    }
  })
  app.post('/api/v1/cli/token', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as any
    const token = auth.redeemCliCode(String(body.code ?? ''), String(body.code_verifier ?? ''), String(body.redirect_uri ?? ''))
    return token ? c.json({ access_token: token, token_type: 'Bearer' }) : c.json({ error: 'invalid_grant' }, 400)
  })

  // ---- pages: trees -----------------------------------------------------

  const needUser = (c: Context) => (c.get('user') ? null : c.redirect(`/signin?next=${encodeURIComponent(c.req.path)}`))

  /** Who a tree can be started from or filled with: people in your other trees, and network contacts not already one of them. */
  const pickable = (userId: string, exceptTreeId: string | null = null): html.Pickable => ({
    sources: store.pickablePeople(userId, exceptTreeId),
    contacts: net.contacts(userId, { limit: 2000 }).filter((k) => k.name && !k.person_id).map((k) => ({ id: k.id, name: k.name, circle: k.circle, linked: Boolean(k.linked_user_id) })),
  })

  /**
   * Copy picked people into a tree: `p:<tree>:<person>` from a tree you belong to, `c:<contact>` from your network.
   * A contact who has an account becomes that person here (and, with share, a viewer).
   */
  const bringPeople = async (treeId: string, userId: string, picks: string[], share: boolean): Promise<{ added: number; shared: number; emailed: string[] }> => {
    const people = picks.flatMap((v) => (v.startsWith('p:') && v.split(':').length === 3 ? [{ tree: v.split(':')[1]!, person: v.split(':')[2]! }] : []))
    const done = store.copyPeople(treeId, userId, people, { share })
    let added = done.added.length
    const sharedWith = [...done.shared]
    for (const id of new Set(picks.filter((v) => v.startsWith('c:')).map((v) => v.slice(2)))) {
      const contact = net.contact(userId, id)
      if (!contact?.name) continue
      const words = contact.name.trim().split(/\s+/)
      const person = store.addPerson(treeId, { given: words.length > 1 ? words.slice(0, -1).join(' ') : words[0], surname: words.length > 1 ? words.at(-1) : '', birth_date: contact.birthday, living: 1, emails: contact.emails, phones: contact.phones, addresses: contact.addresses, links: contact.links })
      added++
      if (!net.contactForPerson(userId, treeId, person.id)) net.linkContact(userId, contact.id, { tree_id: treeId, person_id: person.id })
      const linked = contact.linked_user_id ? store.user(contact.linked_user_id) : null
      if (!linked || store.profilePerson(treeId, linked.id)) continue
      if (!store.role(treeId, linked.id)) {
        if (!share) continue
        store.setMember(treeId, linked.id, 'viewer')
        sharedWith.push(linked.id)
      }
      store.claimProfile(treeId, person.id, linked.id)
    }
    // Everyone who can now see the tree hears about it, or being added is invisible to them.
    const from = store.user(userId)!
    const emailed: string[] = []
    for (const id of new Set(sharedWith)) {
      const to = store.user(id)
      if (!to?.email || to.email.endsWith('@pit.invalid')) continue
      if (!senderLimit(`invite:${from.id}`) || !inviteLimit(`to:${to.email}`)) continue
      if (await sendAdded(to.email, treeId, from)) emailed.push(to.email)
    }
    return { added, shared: new Set(sharedWith).size, emailed }
  }
  const picksFrom = async (c: Context): Promise<string[]> => {
    const all = (await c.req.parseBody({ all: true }).catch(() => ({}))) as Record<string, unknown>
    const pick = all.pick
    return (Array.isArray(pick) ? pick : pick ? [pick] : []).map(String).slice(0, 2000)
  }
  const broughtNote = (r: { added: number; shared: number; emailed: string[] }) =>
    `Added ${r.added} ${r.added === 1 ? 'person' : 'people'}${r.shared ? `; ${r.shared} of them can now see this tree` : ''}${r.emailed.length ? ` (emailed ${r.emailed.join(', ')})` : r.shared ? ' (no email went out; invite them from Members if they need a nudge)' : ''}.`

  app.get('/trees', (c) => needUser(c) ?? c.html(html.treesPage(ctx(c), store.treesFor(c.get('user')!.id), teams.workplaces(c.get('user')!.id), pickable(c.get('user')!.id))))
  app.post('/trees', async (c) => {
    if (needUser(c)) return needUser(c)!
    const body = await form(c)
    const tree = store.createTree(c.get('user')!.id, String(body.name ?? ''), body.description ? String(body.description) : null)
    const picks = await picksFrom(c)
    if (!picks.length) return c.redirect(`/t/${tree.id}`)
    return c.redirect(`/t/${tree.id}?ok=${encodeURIComponent(broughtNote(await bringPeople(tree.id, c.get('user')!.id, picks, Boolean(body.share))))}`)
  })
  app.post('/t/:tree/bring', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    const body = await form(c)
    const picks = await picksFrom(c)
    if (!picks.length) return c.redirect(`/t/${t.tree.id}?error=${encodeURIComponent('Tick at least one person.')}`)
    return c.redirect(`/t/${t.tree.id}?ok=${encodeURIComponent(broughtNote(await bringPeople(t.tree.id, t.user.id, picks, Boolean(body.share))))}`)
  })
  app.post('/trees/import', async (c) => {
    if (needUser(c)) return needUser(c)!
    const body = await form(c)
    const file = body.file as File | undefined
    if (!(file instanceof File) || file.size > MAX_GEDCOM) return c.html(html.treesPage(ctx(c, { error: 'Choose a GEDCOM file under 25 MB.' }), store.treesFor(c.get('user')!.id)), 400)
    const tree = store.createTree(c.get('user')!.id, String(body.name || file.name.replace(/\.(ged|gedcom)$/i, '') || 'Imported tree'))
    try {
      const result = importGedcom(store, tree.id, await file.text())
      return c.redirect(`/t/${tree.id}?ok=${encodeURIComponent(`Imported ${describeImport(result)}.`)}`)
    } catch (error) {
      store.deleteTree(tree.id)
      return c.html(html.treesPage(ctx(c, { error: `Could not import that file: ${(error as Error).message}` }), store.treesFor(c.get('user')!.id)), 400)
    }
  })

  app.get('/t/:tree', (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    const q = (c.req.query('q') ?? '').slice(0, 200)
    return c.html(
      html.treePage(ctx(c), t.tree, t.role, {
        stats: store.stats(t.tree.id),
        home: t.tree.home_person_id ? store.person(t.tree.id, t.tree.home_person_id) : null,
        people: q ? store.search(t.tree.id, q, 200) : store.people(t.tree.id, 500),
        businesses: q ? store.searchBusinesses(t.tree.id, q, 50) : [],
        surnames: store.surnames(t.tree.id),
        query: q,
        plan: hasPlan(plan, store, t.tree),
        pick: canEdit(t.role) && !q ? pickable(t.user.id, t.tree.id) : undefined,
      }),
    )
  })
  app.post('/t/:tree/settings', async (c) => {
    const t = treeFor(c, 'manage')
    if (t.error) return t.error
    const body = await form(c)
    store.updateTree(t.tree.id, { name: String(body.name ?? t.tree.name), description: body.description ? String(body.description) : null })
    return c.redirect(`/t/${t.tree.id}?ok=Saved`)
  })
  app.post('/t/:tree/delete', (c) => {
    const t = treeFor(c, 'owner')
    if (t.error) return t.error
    store.deleteTree(t.tree.id)
    return c.redirect('/trees?ok=Tree%20deleted')
  })
  app.post('/t/:tree/home', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    const body = await form(c)
    store.updateTree(t.tree.id, { home_person_id: String(body.person_id) })
    return c.redirect(`/t/${t.tree.id}/p/${body.person_id}?ok=Home%20person%20set`)
  })
  app.post('/t/:tree/import', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    const file = (await form(c)).file
    if (!(file instanceof File) || file.size > MAX_GEDCOM) return c.redirect(`/t/${t.tree.id}`)
    try {
      const result = importGedcom(store, t.tree.id, await file.text())
      return c.redirect(`/t/${t.tree.id}?ok=${encodeURIComponent(`Imported ${describeImport(result)}.`)}`)
    } catch (error) {
      return c.html(html.messagePage(ctx(c), 'Import failed', (error as Error).message), 400)
    }
  })
  app.get('/t/:tree/export.ged', (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    // Viewers get the privacy-safe export; editors may ask for everything.
    const privacy = c.req.query('full') !== '1' || !canEdit(t.role)
    const name = t.tree.name.replace(/[^A-Za-z0-9 _.-]+/g, '').trim() || 'family'
    return new Response(exportGedcom(store, t.tree.id, { privacy }), { headers: { 'content-type': 'text/vnd.familysearch.gedcom; charset=utf-8', 'content-disposition': `attachment; filename="${name}.ged"` } })
  })

  // people
  app.post('/t/:tree/people', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    const p = store.addPerson(t.tree.id, await form(c))
    return c.redirect(`/t/${t.tree.id}/p/${p.id}?added=1`)
  })
  app.get('/t/:tree/p/:person', (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    const person = store.person(t.tree.id, c.req.param('person'))
    if (!person) return c.html(html.messagePage(ctx(c), 'Not found', 'Nobody by that id in this tree.'), 404)
    const profile = store.profileUser(t.tree.id, person.id)
    // Only the living can join; the offer is a quiet line unless they were just added.
    const invitable = canEdit(t.role) && !profile && !person.death_date && !person.death_place
    return c.html(
      html.personPage(ctx(c), t.tree, t.role, {
        person,
        parents: store.parentFamilies(t.tree.id, person.id),
        unions: store.spouseFamilies(t.tree.id, person.id),
        events: store.events(t.tree.id, person.id),
        timeline: lifeTimeline(person, store.spouseFamilies(t.tree.id, person.id), store.events(t.tree.id, person.id)),
        eventForm: lifeEventForm(ctx(c), t.tree.id, person, store.spouseFamilies(t.tree.id, person.id), canEdit(t.role)),
        stepChildren: store.stepChildren(t.tree.id, person.id),
        citations: store.citationsFor(t.tree.id, person.id),
        media: store.mediaFor(t.tree.id, person.id),
        sources: store.sources(t.tree.id),
        everyone: canEdit(t.role) ? store.people(t.tree.id, 5000).filter((o) => o.kind === 'person') : [],
        elsewhere: canEdit(t.role) ? elsewhere(t.tree.id, t.user.id) : [],
        siblings: store.siblings(t.tree.id, person.id),
        stepParents: store.stepParents(t.tree.id, person.id),
        grandparents: store.parents(t.tree.id, person.id).flatMap((pp) => store.parents(t.tree.id, pp.id)),
        auntsUncles: store.parents(t.tree.id, person.id).flatMap((pp) => store.siblings(t.tree.id, pp.id).map((s) => s.person)),
        bonds: store.bondsFor(t.tree.id, person.id),
        pets: store.petsOf(t.tree.id, person.id),
        circle: store.circle(t.tree.id, person.id),
        plan: hasPlan(plan, store, t.tree),
        profile,
        posts: postsFor(c, t.tree, person, profile, t.user),
        self: profile?.id === t.user.id,
        // A member with no profile yet, looking at a living person nobody has claimed: "this is me".
        claimable: !profile && person.kind === 'person' && !person.death_date && !person.death_place && !store.profilePerson(t.tree.id, t.user.id),
        welcome: c.req.query('welcome') === '1',
        invite: invitable ? profileInvite(ctx(c), t.tree, person, { justAdded: c.req.query('added') === '1', roles: grantable(t.role) }) : '',
        // Anyone in the tree may keep a living relative in their own network; not themselves, not a pet.
        // On your own page: invite a friend. On any other living person's: add them to your network.
        network: person.kind !== 'person' || person.death_date || person.death_place ? '' : profile?.id === t.user.id ? inviteFriendBox(ctx(c)) : personNetworkBox(ctx(c), t.tree, person, net.contactForPerson(t.user.id, t.tree.id, person.id)),
        businesses: personBusinesses(ctx(c), t.tree, t.role, person, store.businessesOf(t.tree.id, person.id), canEdit(t.role) ? store.businesses(t.tree.id) : []),
      }),
    )
  })
  /** Editors, or the member who is this person (their own profile). */
  /**
   * "Add an event": `what` (a life event key) or `type` (a label; one that names a life event,
   * like Death or Divorce, does what that event does; anything else is a plain event).
   * Partnerships and children change the tree, so they need an editor.
   */
  const recordEvent = (t: { tree: Tree; role: Role }, personId: string, body: Record<string, any>) => {
    const key = lifeKey(body.what) ?? lifeKey(body.type) ?? 'other'
    if (changesTree(key) && !canEdit(t.role)) throw new Error('marriages, divorces and children change the tree; ask an editor to add those')
    return recordLifeEvent(store, t.tree.id, personId, { ...body, what: key, custom: body.custom ?? (key === 'other' ? body.type : undefined) }, addRelative)
  }
  const personFor = (c: Context): TreeAccess => {
    const t = treeFor(c)
    if (t.error) return t
    if (store.canEditPerson(t.tree.id, c.req.param('person')!, t.user.id)) return t
    const api = c.req.path.startsWith('/api/')
    return { error: (api ? c.json({ error: 'you can change only your own profile' }, 403) : c.html(html.messagePage(ctx(c), 'Not allowed', 'You can view this tree but change only your own profile.'), 403)) as Response }
  }
  app.post('/t/:tree/p/:person', async (c) => {
    const t = personFor(c)
    if (t.error) return t.error
    const body = await form(c)
    if (!('living' in body)) body.living = '0'
    const { synced } = store.updatePersonEverywhere(t.tree.id, c.req.param('person'), body, c.get('user')?.id)
    return c.redirect(`/t/${t.tree.id}/p/${c.req.param('person')}?ok=${encodeURIComponent(synced ? `Saved, here and in ${synced} other ${synced === 1 ? 'tree' : 'trees'}` : 'Saved')}`)
  })
  /** Contact info alone (emails, phones, addresses, links, socials): the person or anyone who edits the tree. */
  app.post('/t/:tree/p/:person/contact', async (c) => {
    const t = personFor(c)
    if (t.error) return t.error
    const body = await form(c)
    const fields = Object.fromEntries(CONTACT_KEYS.map((k) => [k, body[k] ?? '']))
    const { synced } = store.updatePersonEverywhere(t.tree.id, c.req.param('person'), fields, c.get('user')?.id)
    return c.redirect(`/t/${t.tree.id}/p/${c.req.param('person')}?ok=${encodeURIComponent(synced ? `Contact info saved, here and in ${synced} other ${synced === 1 ? 'tree' : 'trees'}` : 'Contact info saved')}`)
  })
  app.post('/t/:tree/p/:person/delete', (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    store.deletePerson(t.tree.id, c.req.param('person'))
    return c.redirect(`/t/${t.tree.id}?ok=Deleted`)
  })
  /**
   * Families overlap: a pick may be someone in another of your trees (`… #<tree>/<person>`).
   * They are copied into this tree first, and `undo` takes the copy back out if linking then fails.
   */
  const fromOtherTree = (treeId: string, userId: string, body: Record<string, any>): { body: Record<string, any>; undo: () => void } => {
    for (const key of ['existing', 'existing_id', 'other_id']) {
      const m = String(body[key] ?? '').match(/#?([A-Za-z0-9_-]{6,})\/([A-Za-z0-9_-]{6,})\s*$/)
      if (!m) continue
      const copy = store.copyPeople(treeId, userId, [{ tree: m[1]!, person: m[2]! }]).added[0]
      if (!copy) throw new Error('that person is not in a tree you belong to')
      return { body: { ...body, [key]: copy.id }, undo: () => store.deletePerson(treeId, copy.id) }
    }
    return { body, undo: () => {} }
  }
  /** People in your other trees who are not already here (same name and birth date), for "someone already in the tree". */
  const elsewhere = (treeId: string, userId: string): { tree: Tree; person: Person }[] => {
    const key = (p: Person) => `${fullName(p).toLowerCase()}|${p.birth_date ?? ''}`
    const seen = new Set(store.people(treeId, 5000).map(key))
    return store.pickablePeople(userId, treeId).flatMap((s) =>
      s.people.flatMap((person) => {
        if (person.kind !== 'person' || seen.has(key(person))) return []
        seen.add(key(person))
        return [{ tree: s.tree, person }]
      }),
    )
  }

  app.post('/t/:tree/p/:person/relative', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    let undo = () => {}
    try {
      const picked = fromOtherTree(t.tree.id, t.user.id, await form(c))
      undo = picked.undo
      const other = addRelative(store, t.tree.id, c.req.param('person'), picked.body)
      return c.redirect(`/t/${t.tree.id}/p/${c.req.param('person')}?ok=${encodeURIComponent(`Added ${fullName(other)}`)}`)
    } catch (error) {
      undo()
      return c.redirect(`/t/${t.tree.id}/p/${c.req.param('person')}?ok=${encodeURIComponent(`Not added: ${(error as Error).message}`)}`)
    }
  })
  app.post('/t/:tree/p/:person/unlink', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    const body = await form(c)
    store.removeChild(String(body.family_id), c.req.param('person'))
    return c.redirect(`/t/${t.tree.id}/p/${c.req.param('person')}`)
  })
  // Bonds that are not descent: raised by, guardian, godparent, caregiver, chosen family.
  app.post('/t/:tree/p/:person/bonds', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    const back = `/t/${t.tree.id}/p/${c.req.param('person')}`
    let undo = () => {}
    try {
      const picked = fromOtherTree(t.tree.id, t.user.id, await form(c))
      undo = picked.undo
      const other = addBondFrom(t.tree.id, c.req.param('person'), picked.body)
      return c.redirect(`${back}?ok=${encodeURIComponent(`Added ${fullName(other)}`)}`)
    } catch (error) {
      undo()
      return c.redirect(`${back}?ok=${encodeURIComponent(`Not added: ${(error as Error).message}`)}`)
    }
  })
  app.post('/t/:tree/bonds/:bond/delete', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    const bond = store.bond(t.tree.id, c.req.param('bond'))
    store.removeBond(t.tree.id, c.req.param('bond'))
    const back = String((await form(c)).back ?? bond?.person_id ?? '')
    return c.redirect(store.person(t.tree.id, back) ? `/t/${t.tree.id}/p/${back}` : `/t/${t.tree.id}`)
  })
  // Pets: the Family plan.
  app.post('/t/:tree/p/:person/pets', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    if (!hasPlan(plan, store, t.tree)) return c.redirect(`/t/${t.tree.id}/plan?ok=${encodeURIComponent('Pets come with the Family plan.')}`)
    const body = await form(c)
    if (!String(body.given ?? '').trim()) return c.redirect(`/t/${t.tree.id}/p/${c.req.param('person')}?ok=${encodeURIComponent('Give the pet a name.')}`)
    try {
      const pet = store.addPet(t.tree.id, { ...body, living: body.living ?? '0' }, [c.req.param('person')])
      return c.redirect(`/t/${t.tree.id}/p/${pet.id}?ok=${encodeURIComponent(`Added ${fullName(pet)}`)}`)
    } catch (error) {
      return c.redirect(`/t/${t.tree.id}/p/${c.req.param('person')}?ok=${encodeURIComponent(`Not added: ${(error as Error).message}`)}`)
    }
  })
  // Who are you? For a member who joined without being tied to a profile.
  app.get('/t/:tree/claim', (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    const mine = store.profilePerson(t.tree.id, t.user.id)
    if (mine) return c.redirect(`/t/${t.tree.id}/p/${mine}`)
    return c.html(html.claimPage(ctx(c), t.tree, store.unclaimed(t.tree.id), { name: t.user.name ?? '', mismatch: c.req.query('mismatch') === '1' }))
  })
  app.post('/t/:tree/claim', async (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    const body = await form(c)
    try {
      const personId = claimSelf(t.tree.id, t.user, body)
      return c.redirect(`/t/${t.tree.id}/p/${personId}?welcome=1&ok=${encodeURIComponent('That is you now. Add a photo and keep your profile up to date.')}`)
    } catch (error) {
      return c.redirect(`/t/${t.tree.id}/claim?ok=${encodeURIComponent((error as Error).message)}`)
    }
  })
  // The Family plan: pay once per tree.
  app.get('/t/:tree/plan', (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    return c.html(html.planPage(ctx(c), t.tree, t.role, { active: hasPlan(plan, store, t.tree), admin: isAdmin(plan, store.user(t.tree.owner_id)), price: price(plan), chains: plan.coinpay ? plan.chains.map((id) => ({ id, label: CHAIN_LABELS[id] ?? id })) : [], payments: store.paymentsFor(t.tree.id), returned: c.req.query('paid') === '1' }))
  })
  app.post('/t/:tree/plan/checkout', async (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    if (hasPlan(plan, store, t.tree)) return c.redirect(`/t/${t.tree.id}/plan`)
    try {
      const { checkoutUrl } = await startCheckout(plan, store, { tree: t.tree, user: t.user, chain: String((await form(c)).chain ?? ''), successUrl: `${linkBase(c)}/t/${t.tree.id}/plan?paid=1`, cancelUrl: `${linkBase(c)}/t/${t.tree.id}/plan` }, fetcher)
      return c.redirect(checkoutUrl)
    } catch (error) {
      console.error(`[plan] checkout failed: ${(error as Error).message}`)
      return c.redirect(`/t/${t.tree.id}/plan?ok=${encodeURIComponent(`Could not start the payment: ${(error as Error).message}`)}`)
    }
  })
  /**
   * Resend tells us what became of each email (delivered, bounced, ...), signed with the
   * webhook secret. That is how a send-only key still learns about bounces.
   */
  app.post('/webhooks/resend', async (c) => {
    const raw = await c.req.text()
    if (!resendWebhookSecret || !verifyResendWebhook(resendWebhookSecret, raw, { id: c.req.header('svix-id'), timestamp: c.req.header('svix-timestamp'), signature: c.req.header('svix-signature') })) {
      if (c.req.header('svix-id')) console.error(`[resend] webhook ${c.req.header('svix-id')} refused: bad signature`)
      return c.json({ error: 'bad signature' }, 401)
    }
    let event: { type?: string; data?: { email_id?: string; bounce?: { message?: string; diagnosticCode?: string[] }; failed?: { reason?: string } } }
    try {
      event = JSON.parse(raw)
    } catch {
      return c.json({ error: 'bad json' }, 400)
    }
    const status = event.type?.startsWith('email.') ? event.type.slice('email.'.length) : null
    const id = event.data?.email_id
    if (!status || !id) return c.json({ ok: true, ignored: 'not an email event' })
    const reason = event.data?.bounce ? (event.data.bounce.diagnosticCode?.[0] ?? event.data.bounce.message ?? null) : (event.data?.failed?.reason ?? null)
    // Only messages we sent count: other apps on the same Resend account are ignored.
    const matched = store.mailEvent(id, status, reason)
    console.log(`[resend] ${event.type} ${id}${matched ? ' -> invite' : ''}${reason ? ` (${reason})` : ''}`)
    return c.json({ ok: true, matched })
  })
  /** CoinPay calls this; it proves itself with the signature, not a session. */
  app.post('/webhooks/coinpay', async (c) => {
    const raw = await c.req.text()
    if (!plan.coinpay || !verifyWebhook(plan.coinpay.webhookSecret, raw, c.req.header('coinpay-signature') ?? c.req.header('x-coinpay-signature'))) return c.json({ error: 'bad signature' }, 401)
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      return c.json({ error: 'bad json' }, 400)
    }
    const { ref, status } = readWebhook(payload)
    // Only payments we started count; the tree comes from our row, never from the payload.
    const known = ref ? store.payment(String(ref)) : null
    if (!known) return c.json({ ok: true, ignored: 'unknown payment' })
    const settled = store.settlePayment(known.ref, status, payload, SETTLED.has(status))
    return c.json({ ok: true, status: settled?.status, paid: Boolean(store.tree(known.tree_id)?.plan_paid_at) })
  })
  app.post('/t/:tree/f/:family', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    const body = await form(c)
    // One "status" select (the circle on a person page) or the full edit form.
    const status = body.status !== undefined ? unionStatus(body.status) : null
    store.updateFamily(t.tree.id, c.req.param('family'), status ?? { kind: body.kind, start_date: body.start_date, start_place: body.start_place, end_date: body.end_date, end_kind: body.end_kind, end_place: body.end_place })
    return c.redirect(c.req.header('referer')?.startsWith(site) ? c.req.header('referer')! : `/t/${t.tree.id}`)
  })
  app.post('/t/:tree/f/:family/delete', (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    store.deleteFamily(t.tree.id, c.req.param('family'))
    return c.redirect(`/t/${t.tree.id}?ok=Partnership%20removed`)
  })
  app.post('/t/:tree/p/:person/events', async (c) => {
    const t = personFor(c)
    if (t.error) return t.error
    const body = await form(c)
    const back = `/t/${t.tree.id}/p/${c.req.param('person')}`
    try {
      const r = recordEvent(t, c.req.param('person')!, body)
      return c.redirect(`${back}?ok=${encodeURIComponent(r.message)}`)
    } catch (error) {
      return c.redirect(`${back}?error=${encodeURIComponent((error as Error).message)}#add-event`)
    }
  })
  app.post('/t/:tree/e/:event/delete', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    const body = await form(c)
    store.deleteEvent(t.tree.id, c.req.param('event'))
    return c.redirect(`/t/${t.tree.id}/p/${body.person_id}`)
  })

  // sources + citations
  app.get('/t/:tree/sources', (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    return c.html(html.sourcesPage(ctx(c), t.tree, t.role, store.sources(t.tree.id)))
  })
  app.post('/t/:tree/sources', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    const body = await form(c)
    store.addSource(t.tree.id, { title: String(body.title ?? ''), author: body.author, url: body.url, citation: body.citation })
    return c.redirect(`/t/${t.tree.id}/sources`)
  })
  app.post('/t/:tree/sources/:source/delete', (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    store.deleteSource(t.tree.id, c.req.param('source'))
    return c.redirect(`/t/${t.tree.id}/sources`)
  })
  app.post('/t/:tree/p/:person/cite', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    const body = await form(c)
    let sourceId = String(body.source_id ?? '')
    if (!sourceId && body.title) sourceId = store.addSource(t.tree.id, { title: String(body.title), url: body.url }).id
    if (sourceId) store.cite(t.tree.id, sourceId, c.req.param('person'), body.page ?? null)
    return c.redirect(`/t/${t.tree.id}/p/${c.req.param('person')}`)
  })
  app.post('/t/:tree/p/:person/uncite', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    store.uncite(String((await form(c)).source_id), c.req.param('person'))
    return c.redirect(`/t/${t.tree.id}/p/${c.req.param('person')}`)
  })

  // media
  app.post('/t/:tree/p/:person/media', async (c) => {
    const t = personFor(c)
    if (t.error) return t.error
    const body = await form(c)
    const file = body.file
    const back = `/t/${t.tree.id}/p/${c.req.param('person')}`
    if (!(file instanceof File) || !IMAGE_TYPES.has(file.type) || file.size > MAX_PHOTO) return c.redirect(`${back}?ok=${encodeURIComponent('Photos must be JPEG, PNG, GIF, WebP or AVIF, under 8 MB.')}`)
    store.addMedia(t.tree.id, c.req.param('person'), { filename: file.name, mime: file.type, data: new Uint8Array(await file.arrayBuffer()), caption: body.caption ?? null, uploadedBy: t.user.id })
    return c.redirect(back)
  })
  const mediaBack = (treeId: string, m: { person_id: string | null; business_id?: string | null } | null) => (m?.person_id ? `/t/${treeId}/p/${m.person_id}` : m?.business_id ? `/t/${treeId}/b/${m.business_id}` : `/t/${treeId}`)
  app.get('/t/:tree/media/:media', (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    const m = store.mediaData(t.tree.id, c.req.param('media'))
    if (!m) return c.notFound()
    return new Response(new Uint8Array(m.data), { headers: { 'content-type': IMAGE_TYPES.has(m.mime) ? m.mime : 'application/octet-stream', 'cache-control': 'private, max-age=86400', 'content-security-policy': "default-src 'none'", 'x-content-type-options': 'nosniff' } })
  })
  app.post('/t/:tree/media/:media/primary', (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    const m = store.mediaInfo(t.tree.id, c.req.param('media'))
    if (m?.person_id) store.setPhoto(t.tree.id, m.person_id, m.id)
    if (m?.business_id) store.setBusinessPhoto(t.tree.id, m.business_id, m.id)
    return c.redirect(mediaBack(t.tree.id, m))
  })
  app.post('/t/:tree/media/:media/delete', (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    const m = store.mediaInfo(t.tree.id, c.req.param('media'))
    store.deleteMedia(t.tree.id, c.req.param('media'))
    return c.redirect(mediaBack(t.tree.id, m))
  })

  // charts
  const gens = (value: string | undefined, fallback: number, max: number) => Math.min(max, Math.max(2, Number(value) || fallback))
  app.get('/t/:tree/pedigree/:person', (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    const g = gens(c.req.query('g'), 4, 6)
    const people = store.pedigree(t.tree.id, c.req.param('person'), g)
    if (!people.get(1)) return c.notFound()
    return c.html(html.pedigreePage(ctx(c), t.tree, people.get(1)!, people, g))
  })
  app.get('/t/:tree/descendants/:person', (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    const g = gens(c.req.query('g'), 3, 8)
    const d = store.descendants(t.tree.id, c.req.param('person'), g)
    if (!d) return c.notFound()
    return c.html(html.descendantsPage(ctx(c), t.tree, d, g))
  })
  app.get('/t/:tree/relate', (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    const everyone = store.people(t.tree.id, 5000)
    const a = store.person(t.tree.id, c.req.query('a') ?? '') ?? (t.tree.home_person_id ? store.person(t.tree.id, t.tree.home_person_id) : null) ?? everyone[0] ?? null
    const b = store.person(t.tree.id, c.req.query('b') ?? '')
    return c.html(html.relatePage(ctx(c), t.tree, everyone, a, b, a && b ? relate(t.tree.id, a.id, b.id) : null))
  })

  // members + invites
  /**
   * Ask the mail provider what became of invite emails still "sent" (on their way): a bounce
   * then shows on the Members page instead of an invite that waits forever. Final answers stick.
   */
  const refreshInviteMail = async (treeId: string) => {
    if (!mailStatus) return
    const open = store.pendingInvites(treeId).filter((i) => i.mail_id && (!i.mail_status || ['sent', 'queued', 'delivery_delayed'].includes(i.mail_status)) && Date.now() - i.created_at > 15_000).slice(0, 20)
    await Promise.all(
      open.map(async (i) => {
        const s = await mailStatus(i.mail_id!)
        if (s && s.status !== i.mail_status) store.setInviteMail(i.id, { mail_status: s.status, mail_error: s.reason }, true)
      }),
    )
  }
  const membersView = async (c: Context, t: { tree: Tree; role: Role }, links: html.InviteLink[] = [], flash: string | null = null) => {
    if (canEdit(t.role)) await refreshInviteMail(t.tree.id)
    return c.html(html.membersPage(ctx(c, flash ? { flash } : {}), t.tree, t.role, store.members(t.tree.id), links, { pending: canEdit(t.role) ? store.pendingInvites(t.tree.id) : [], profiles: store.profiles(t.tree.id), people: (id) => store.person(t.tree.id, id), max: pasteMax(t.tree), plan: hasPlan(plan, store, t.tree), listing: listingPanel(ctx(c), t.tree, t.role, listings.settings(t.tree.id), canEdit(t.role) ? listings.waiting(t.tree.id) : [], publicSite) }))
  }
  app.get('/t/:tree/members', (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    return membersView(c, t)
  })
  /**
   * Invite by email (one address or up to 20) or make a link to send yourself.
   * Owners pick the role; editors can invite viewers, which is how a new person
   * gets asked to join as themselves right after they are added.
   */
  app.post('/t/:tree/invites', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    const body = await form(c)
    const role = inviteRole(t.role, body.role)
    const personId = body.person_id && store.person(t.tree.id, String(body.person_id)) && !store.profileUser(t.tree.id, String(body.person_id)) ? String(body.person_id) : null
    const invitees = parseInvitees(body.emails ?? body.email, personId ? 1 : pasteMax(t.tree))
    const note = body.note ? String(body.note) : null
    if (!invitees.length) {
      if (body.back === 'person' && personId) return c.redirect(`/t/${t.tree.id}/p/${personId}?ok=${encodeURIComponent('That does not look like an email address.')}`)
      if (!canManage(t.role)) return membersView(c, t, [], 'Only the owner or an admin can make invite links. Invite by email instead.')
      return membersView(c, t, [{ email: null, url: `${publicSite}/invite/${store.createInvite(t.tree.id, t.user.id, role, null, { note })}`, mailed: false }])
    }
    const links: html.InviteLink[] = []
    for (const i of invitees) links.push({ email: i.email, ...(await inviteToTree(t.user, t.tree.id, i.email, role, { personId: personId ?? matchPerson(t.tree.id, i.name), note, name: i.name })) })
    const sent = links.filter((l) => l.mailed).length
    const failed = links.filter((l) => l.failed)
    const held = links.length - sent - failed.length
    const flash = [
      sent === links.length ? `Invite emailed to ${sent === 1 ? links[0]!.email : `${sent} people`}.` : sent ? `Emailed ${sent} of ${links.length}.` : '',
      failed.length ? `Could not email ${failed.map((l) => l.email).join(', ')}: ${failed[0]!.failed}. Their links are below to send yourself.` : '',
      held ? `${held} more ${held === 1 ? 'is' : 'are'} over the day's invitation limit; their links are below.` : '',
    ].filter(Boolean).join(' ')
    if (body.back === 'person' && personId) return c.redirect(`/t/${t.tree.id}/p/${personId}?ok=${encodeURIComponent(flash)}`)
    return membersView(c, t, links, flash)
  })
  app.post('/t/:tree/invites/:id/revoke', (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    store.revokeInvite(t.tree.id, c.req.param('id'))
    return c.redirect(`/t/${t.tree.id}/members?ok=Invite%20cancelled`)
  })
  app.post('/t/:tree/p/:person/release', (c) => {
    const t = treeFor(c, 'manage')
    if (t.error) return t.error
    store.releaseProfile(t.tree.id, c.req.param('person'))
    return c.redirect(`/t/${t.tree.id}/members?ok=Profile%20unlinked`)
  })
  app.post('/t/:tree/members/:user', async (c) => {
    const t = treeFor(c, 'manage')
    if (t.error) return t.error
    const role = inviteRole(t.role, (await form(c)).role)
    // Nobody changes the owner's role: one owner per family, the super user.
    const current = store.role(t.tree.id, c.req.param('user'))
    if (current && current !== 'owner') store.setMember(t.tree.id, c.req.param('user'), role)
    return c.redirect(`/t/${t.tree.id}/members`)
  })
  app.post('/t/:tree/members/:user/remove', (c) => {
    const t = treeFor(c, 'manage')
    if (t.error) return t.error
    store.removeMember(t.tree.id, c.req.param('user'))
    return c.redirect(`/t/${t.tree.id}/members`)
  })
  app.get('/invite/:token', (c) => {
    const invite = store.invite(c.req.param('token'))
    const tree = invite ? store.tree(invite.tree_id) : null
    if (!invite || !tree) return c.html(html.messagePage(ctx(c), 'Invite expired', 'This invite was already used or has expired. Ask for a new one.'), 404)
    const from = store.user(invite.created_by)
    const person = invite.person_id ? store.person(tree.id, invite.person_id) : null
    return c.html(html.invitePage(ctx(c), tree, invite.role, c.req.param('token'), { from, person, note: invite.note }))
  })
  app.post('/invite/:token', (c) => {
    const user = c.get('user')
    if (!user) return c.redirect(`/signin?next=${encodeURIComponent(c.req.path)}`)
    const invite = store.invite(c.req.param('token'))
    const joined = store.acceptInvite(c.req.param('token'), user.id)
    if (!joined || !invite) return c.html(html.messagePage(ctx(c), 'Invite expired', 'This invite was already used or has expired.'), 404)
    // Whoever invited you is in your network now, and you in theirs: family is the first circle.
    const from = store.user(invite.created_by)
    if (from && from.id !== user.id) {
      net.connect(from.id, user.id)
      net.ensureContact(from.id, user.email, { name: user.name ?? '', circle: 'family' }, { linked_user_id: user.id, tree_id: joined.tree_id, person_id: joined.person_id })
      net.ensureContact(user.id, from.email, { name: from.name ?? '', circle: 'family' }, { linked_user_id: from.id, tree_id: joined.tree_id, person_id: store.profilePerson(joined.tree_id, from.id) })
    }
    if (joined.person_id) return c.redirect(`/t/${joined.tree_id}/p/${joined.person_id}?welcome=1&ok=${encodeURIComponent('Welcome to the family. This is your profile: add a photo and keep it up to date.')}`)
    // Not bound to anyone (or bound to someone else's address): let them find themselves.
    return store.profilePerson(joined.tree_id, user.id) ? c.redirect(`/t/${joined.tree_id}?ok=Welcome`) : c.redirect(`/t/${joined.tree_id}/claim${joined.mismatch ? '?mismatch=1' : ''}`)
  })

  // settings
  const settings = (c: Context, newToken: string | null = null) => c.html(html.settingsPage(ctx(c), { passkeys: auth.passkeys(c.get('user')!.id), tokens: auth.tokens(c.get('user')!.id), newToken, profile: profilePanel(profiles.mine(c.get('user')!.id), publicSite), addons: addonsPanel(), pitWorld: pitClient ? { linked: store.identities(c.get('user')!.id).some((i) => i.provider === 'pitworld') } : null }))
  app.get('/settings', (c) => needUser(c) ?? settings(c))
  app.post('/settings/name', async (c) => {
    if (needUser(c)) return needUser(c)!
    store.setUserName(c.get('user')!.id, String((await form(c)).name ?? ''))
    return c.redirect('/settings?ok=Saved')
  })
  app.post('/settings/tokens', async (c) => {
    if (needUser(c)) return needUser(c)!
    return settings(c, auth.createToken(c.get('user')!.id, String((await form(c)).label ?? '') || 'token'))
  })
  app.post('/settings/tokens/:id/delete', (c) => {
    if (needUser(c)) return needUser(c)!
    auth.revokeToken(c.get('user')!.id, c.req.param('id'))
    return c.redirect('/settings')
  })
  app.post('/settings/passkeys/:id/delete', (c) => {
    if (needUser(c)) return needUser(c)!
    auth.removePasskey(c.get('user')!.id, decodeURIComponent(c.req.param('id')))
    return c.redirect('/settings')
  })

  // ---- /api/v1 ----------------------------------------------------------

  const api = new Hono<Env>()
  const apiUser = (c: Context) => c.get('user')
  const bad = (c: Context, error: unknown, status: 400 | 404 = 400) => c.json({ error: error instanceof Error ? error.message : String(error) }, status)
  const json = async (c: Context): Promise<Record<string, any>> => ((await c.req.json().catch(() => ({}))) as Record<string, any>) ?? {}
  const personOut = (treeId: string, p: Person, full = false) => {
    const holder = store.profileUser(treeId, p.id)
    const base = { ...p, contact: readContact(p.contact), name: fullName(p), url: `${site}/t/${treeId}/p/${p.id}`, profile: holder ? { user_id: holder.id, name: holder.name ?? holder.email } : null }
    if (!full) return base
    return {
      ...base,
      parents: store.parentFamilies(treeId, p.id).map((f) => ({ family_id: f.family.id, relation: f.relation, parents: f.parents.map((x) => ({ id: x.id, name: fullName(x) })), siblings: f.siblings.map((x) => ({ id: x.id, name: fullName(x) })) })),
      unions: store.spouseFamilies(treeId, p.id).map((u) => ({ family_id: u.family.id, kind: u.family.kind, start_date: u.family.start_date, start_place: u.family.start_place, end_date: u.family.end_date, partner: u.partner ? { id: u.partner.id, name: fullName(u.partner) } : null, children: u.children.map((x) => ({ id: x.id, name: fullName(x) })) })),
      events: store.events(treeId, p.id),
      sources: store.citationsFor(treeId, p.id),
      photos: store.mediaFor(treeId, p.id).map((m) => ({ ...m, url: `${site}/t/${treeId}/media/${m.id}` })),
      siblings: store.siblings(treeId, p.id).map((s) => ({ id: s.person.id, name: fullName(s.person), kind: s.kind, via: s.via ? { id: s.via.id, name: fullName(s.via) } : null })),
      bonds: store.bondsFor(treeId, p.id).map((b) => ({ id: b.id, kind: b.kind, label: b.label, other: { id: b.other.id, name: fullName(b.other), kind: b.other.kind }, note: b.note })),
      pets: store.petsOf(treeId, p.id).map((x) => ({ id: x.id, name: fullName(x), species: x.species })),
      businesses: personBusinessesOut(store, treeId, p.id),
      circle: (() => {
        const c = store.circle(treeId, p.id)
        return { groups: c.groups.map((g) => ({ label: g.label, people: g.people.map((r) => ({ id: r.person.id, name: fullName(r.person), kind: r.person.kind, tag: r.tag ?? null })) })), businesses: c.businesses.map((b) => ({ id: b.business.id, name: b.business.name, role: b.role })) }
      })(),
    }
  }

  api.use('*', async (c, next) => {
    if (c.req.path === '/api/v1/cli/token') return next()
    // Public data (famous.ts) and the daemon's status: no account needed, nothing private in either.
    if (c.req.method === 'GET' && (c.req.path === '/api/v1/daemon' || c.req.path === '/api/v1/famous' || c.req.path.startsWith('/api/v1/famous/'))) return next()
    if (!apiUser(c)) return c.json({ error: 'sign in first: send Authorization: Bearer <token> (ancestry login makes one)' }, 401)
    await next()
  })
  api.get('/me', (c) => c.json({ user: apiUser(c), trees: store.treesFor(apiUser(c)!.id) }))
  api.get('/trees', (c) => c.json({ trees: store.treesFor(apiUser(c)!.id) }))
  api.post('/trees', async (c) => {
    const body = await json(c)
    const tree = store.createTree(apiUser(c)!.id, String(body.name ?? 'Family tree'), body.description ?? null)
    const picks = Array.isArray(body.people) ? body.people.map(String) : []
    const brought = picks.length ? await bringPeople(tree.id, apiUser(c)!.id, picks, body.share !== false) : { added: 0, shared: 0, emailed: [] }
    return c.json({ tree: store.tree(tree.id), ...brought }, 201)
  })
  // Pick from `GET /api/v1/pickable`: values look like p:<tree>:<person> or c:<contact>.
  api.get('/pickable', (c) => {
    const pick = pickable(apiUser(c)!.id, c.req.query('except') ?? null)
    return c.json({ trees: pick.sources.map((s) => ({ id: s.tree.id, name: s.tree.name, people: s.people.map((p) => ({ pick: `p:${s.tree.id}:${p.id}`, name: fullName(p), birth_date: p.birth_date, death_date: p.death_date, kind: p.kind })) })), contacts: pick.contacts.map((k) => ({ pick: `c:${k.id}`, name: k.name, circle: k.circle, has_account: k.linked })) })
  })
  api.post('/trees/:tree/bring', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    const body = await json(c)
    const picks = Array.isArray(body.people) ? body.people.map(String) : []
    return c.json(await bringPeople(t.tree.id, apiUser(c)!.id, picks, body.share !== false))
  })
  api.get('/trees/:tree', (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    return c.json({ tree: t.tree, role: t.role, stats: store.stats(t.tree.id), surnames: store.surnames(t.tree.id).slice(0, 50) })
  })
  api.delete('/trees/:tree', (c) => {
    const t = treeFor(c, 'owner')
    if (t.error) return t.error
    store.deleteTree(t.tree.id)
    return c.json({ ok: true })
  })
  api.get('/trees/:tree/people', (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    const q = c.req.query('q') ?? ''
    const limit = Math.min(1000, Number(c.req.query('limit')) || 100)
    return c.json({ people: (q ? store.search(t.tree.id, q, limit) : store.people(t.tree.id, limit)).map((p) => personOut(t.tree.id, p)) })
  })
  api.post('/trees/:tree/people', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    const raw = await json(c)
    let undo = () => {}
    try {
      const picked = raw.relative_of && raw.as ? fromOtherTree(t.tree.id, apiUser(c)!.id, raw) : { body: raw, undo }
      undo = picked.undo
      const body = picked.body
      if (body.relative_of && body.as) return c.json({ person: personOut(t.tree.id, addRelative(store, t.tree.id, String(body.relative_of), body), true) }, 201)
      return c.json({ person: personOut(t.tree.id, store.addPerson(t.tree.id, body), true) }, 201)
    } catch (error) {
      undo()
      return bad(c, error)
    }
  })
  api.get('/trees/:tree/people/:person', (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    const p = store.person(t.tree.id, c.req.param('person'))
    return p ? c.json({ person: personOut(t.tree.id, p, true) }) : bad(c, 'no such person', 404)
  })
  api.patch('/trees/:tree/people/:person', async (c) => {
    const t = personFor(c)
    if (t.error) return t.error
    const { person: p, synced } = store.updatePersonEverywhere(t.tree.id, c.req.param('person'), await json(c), apiUser(c)?.id)
    return p ? c.json({ person: personOut(t.tree.id, p, true), synced }) : bad(c, 'no such person', 404)
  })
  api.delete('/trees/:tree/people/:person', (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    store.deletePerson(t.tree.id, c.req.param('person'))
    return c.json({ ok: true })
  })
  api.post('/trees/:tree/people/:person/events', async (c) => {
    const t = personFor(c)
    if (t.error) return t.error
    const body = await json(c)
    try {
      const r = recordEvent(t, c.req.param('person')!, body)
      return c.json({ message: r.message, event: r.event ?? null, family: r.family ?? null, person: personOut(t.tree.id, store.person(t.tree.id, c.req.param('person'))!, true), relative: r.person ? personOut(t.tree.id, r.person) : null }, 201)
    } catch (error) {
      return bad(c, error)
    }
  })
  api.post('/trees/:tree/people/:person/bonds', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    let undo = () => {}
    try {
      const picked = fromOtherTree(t.tree.id, apiUser(c)!.id, await json(c))
      undo = picked.undo
      const other = addBondFrom(t.tree.id, c.req.param('person'), picked.body)
      return c.json({ person: personOut(t.tree.id, store.person(t.tree.id, c.req.param('person'))!, true), other: personOut(t.tree.id, other) }, 201)
    } catch (error) {
      undo()
      return bad(c, error)
    }
  })
  /** A partnership: {status} (married, engaged, partners, dating, separated, divorced, widowed) or {kind, start_date, end_date, end_kind, …}. */
  api.patch('/trees/:tree/families/:family', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    const body = await json(c)
    if (!store.family(t.tree.id, c.req.param('family'))) return bad(c, 'no such partnership', 404)
    const status = body.status !== undefined ? unionStatus(body.status) : null
    if (body.status !== undefined && !status) return bad(c, 'status is one of married, engaged, partners, dating, separated, divorced, widowed')
    store.updateFamily(t.tree.id, c.req.param('family'), status ?? { kind: body.kind, start_date: body.start_date, start_place: body.start_place, end_date: body.end_date, end_kind: body.end_kind, end_place: body.end_place })
    return c.json({ family: store.family(t.tree.id, c.req.param('family')) })
  })
  api.delete('/trees/:tree/bonds/:bond', (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    store.removeBond(t.tree.id, c.req.param('bond'))
    return c.json({ ok: true })
  })
  /** {owner_id or owner_ids, given, species, birth_date, notes}. Needs the Family plan. */
  api.post('/trees/:tree/pets', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    if (!hasPlan(plan, store, t.tree)) return c.json({ error: `pets come with the Family plan (${price(plan)} once): ${site}/t/${t.tree.id}/plan` }, 402)
    const body = await json(c)
    if (!String(body.given ?? body.name ?? '').trim()) return bad(c, 'give the pet a name')
    try {
      const owners = (Array.isArray(body.owner_ids) ? body.owner_ids : [body.owner_id]).map(String)
      return c.json({ pet: personOut(t.tree.id, store.addPet(t.tree.id, { given: body.given ?? body.name, ...body, living: body.living ?? 1 }, owners), true) }, 201)
    } catch (error) {
      return bad(c, error)
    }
  })
  api.get('/trees/:tree/plan', (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    return c.json({ active: hasPlan(plan, store, t.tree), paid_at: t.tree.plan_paid_at, price: price(plan), chains: plan.coinpay ? plan.chains : [], url: `${site}/t/${t.tree.id}/plan` })
  })
  api.post('/trees/:tree/plan/checkout', async (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    if (hasPlan(plan, store, t.tree)) return c.json({ active: true })
    try {
      const body = await json(c)
      return c.json(await startCheckout(plan, store, { tree: t.tree, user: t.user, chain: String(body.chain ?? plan.chains[0] ?? ''), successUrl: `${publicSite}/t/${t.tree.id}/plan?paid=1`, cancelUrl: `${publicSite}/t/${t.tree.id}/plan` }, fetcher), 201)
    } catch (error) {
      return bad(c, error)
    }
  })
  /** {person_id} to say "this is me", or person fields to add yourself. */
  api.post('/trees/:tree/claim', async (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    try {
      const id = claimSelf(t.tree.id, t.user, await json(c))
      return c.json({ person: personOut(t.tree.id, store.person(t.tree.id, id)!, true) }, 201)
    } catch (error) {
      return bad(c, error)
    }
  })
  api.get('/trees/:tree/pedigree/:person', (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    const map = store.pedigree(t.tree.id, c.req.param('person'), gens(c.req.query('generations'), 4, 8))
    return c.json({ ancestors: [...map.entries()].map(([n, p]) => ({ n, generation: Math.floor(Math.log2(n)), id: p.id, name: fullName(p), birth_date: p.birth_date, death_date: p.death_date, sex: p.sex })) })
  })
  api.get('/trees/:tree/descendants/:person', (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    const d = store.descendants(t.tree.id, c.req.param('person'), gens(c.req.query('generations'), 3, 10))
    return d ? c.json({ descendants: d }) : bad(c, 'no such person', 404)
  })
  api.get('/trees/:tree/relate', (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    const { path, words } = relate(t.tree.id, c.req.query('a') ?? '', c.req.query('b') ?? '')
    return c.json({ relationship: words, path: path?.map((s) => ({ step: s.step, ...(s.relation ? { relation: s.relation } : {}), id: s.person.id, name: fullName(s.person) })) ?? null })
  })
  api.post('/trees/:tree/import', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    const text = await c.req.text()
    if (text.length > MAX_GEDCOM) return bad(c, 'GEDCOM over 25 MB')
    try {
      return c.json({ imported: importGedcom(store, t.tree.id, text) })
    } catch (error) {
      return bad(c, error)
    }
  })
  api.get('/trees/:tree/export', (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    return c.text(exportGedcom(store, t.tree.id, { privacy: c.req.query('privacy') === '1' || !canEdit(t.role) }))
  })
  api.get('/trees/:tree/sources', (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    return c.json({ sources: store.sources(t.tree.id) })
  })
  api.post('/trees/:tree/sources', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    const body = await json(c)
    const source = store.addSource(t.tree.id, { title: String(body.title ?? ''), author: body.author, url: body.url, citation: body.citation })
    if (body.person_id) store.cite(t.tree.id, source.id, String(body.person_id), body.page ?? null)
    return c.json({ source }, 201)
  })
  api.get('/trees/:tree/members', (c) => {
    const t = treeFor(c)
    if (t.error) return t.error
    const profiles = store.profiles(t.tree.id)
    return c.json({ members: store.members(t.tree.id).map((m) => ({ ...m, person_id: profiles.get(m.user_id) ?? null })) })
  })
  api.get('/trees/:tree/invites', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    await refreshInviteMail(t.tree.id)
    return c.json({ invites: store.pendingInvites(t.tree.id).map((i) => ({ ...i, mail: html.mailState(i) })) })
  })
  /** {emails: [...]} or {email}, role, person_id (invite them to be that person), note. Without an email: a link. */
  api.post('/trees/:tree/invites', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    const body = await json(c)
    const role = inviteRole(t.role, body.role)
    const personId = body.person_id && store.person(t.tree.id, String(body.person_id)) ? String(body.person_id) : null
    if (personId && store.profileUser(t.tree.id, personId)) return bad(c, 'that person already manages their own profile')
    const invitees = parseInvitees(Array.isArray(body.emails) ? body.emails.join('\n') : (body.emails ?? body.email), personId ? 1 : pasteMax(t.tree))
    const note = body.note ? String(body.note) : null
    if (!invitees.length) {
      if (!canManage(t.role)) return bad(c, 'only the owner or an admin can make invite links; give an email')
      return c.json({ invites: [{ email: null, mailed: false, url: `${publicSite}/invite/${store.createInvite(t.tree.id, t.user.id, role, null, { personId, note })}` }] }, 201)
    }
    const invites = []
    for (const i of invitees) {
      const bound = personId ?? matchPerson(t.tree.id, i.name)
      invites.push({ email: i.email, name: i.name, person_id: bound, ...(await inviteToTree(t.user, t.tree.id, i.email, role, { personId: bound, note, name: i.name })) })
    }
    return c.json({ invites }, 201)
  })
  api.delete('/trees/:tree/invites/:id', (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    store.revokeInvite(t.tree.id, c.req.param('id'))
    return c.json({ ok: true })
  })

  mountNetwork(app, api, {
    store,
    net,
    site,
    ctx,
    form,
    mail: async (m) => { await auth.mail(m) },
    limits: { invite: senderLimit, message: messageLimit },
    inviteToTree,
    treeFor,
  })
  mountLocal(app, api, { local: new Local(store, net), ctx, form })
  mountFeed(app, api, { feed, ctx, form })
  // Free on every tree; never behind the Family plan.
  // A business's team: invited to the business, never to the tree.
  const team = (cx: html.Ctx, tree: Tree, role: Role, b: Business) => teamPanel(cx, tree, role, b, { members: teams.members(b.id), pending: canEdit(role) ? teams.pendingInvites(b.id) : [], waiting: canEdit(role) ? teams.waiting(b.id) : [], settings: teams.settings(b.id) })
  mountBusinesses(app, api, { store, net, site, ctx, form, treeFor, pickId, image: { types: IMAGE_TYPES, max: MAX_PHOTO }, team })
  mountTeams(app, api, { store, teams, net, site: publicSite, ctx, form, treeFor, mail: async (m) => { await auth.mail(m) }, ip, inviteLimit: senderLimit, askLimit })
  mountListings(app, api, { store, listings, net, site: publicSite, ctx, form, treeFor, mail: async (m) => { await auth.mail(m) }, ip, limit: askLimit, inviteToTree, more: (q) => businessDirectory(teams.directory(q)) })
  mountProfiles(app, api, {
    profiles,
    listings,
    teams,
    site: publicSite,
    ctx,
    form,
    // The feed's rules, nothing looser: strangers see no posts; family and connections see what was shared with them.
    posts: (c, p) => {
      const me = c.get('user') as User | null
      const owner = store.user(p.user_id)
      if (!owner) return ''
      const sameName = (u: User | null | undefined) => Boolean(u?.name && owner.name && u.name.trim().toLowerCase() === owner.name.trim().toLowerCase())
      if (!me) return `<section class="panel" id="posts"><h2>Posts</h2><p class="muted small">${html.esc(p.name)} shares posts with family and friends only. <a href="/signin?next=${encodeURIComponent(`/profile/${p.slug}`)}">Sign in</a> to see what they share with you.</p></section>`
      // One person, two accounts: the owner's, and any account with the same name in a tree with them.
      const authors = [owner.id, ...store.treesFor(owner.id).flatMap((t) => store.members(t.id).map((m) => m.user_id)).filter((id) => id !== owner.id && sameName(store.user(id)))]
      const mine = me.id === owner.id || (authors.includes(me.id) && sameName(me))
      const items = [...new Set(authors)].flatMap((a) => feed.of(me.id, a, { limit: 10 })).sort((a, b) => b.created_at - a.created_at).slice(0, 10)
      if (!mine && !items.length) return feed.knows(me.id, owner.id) ? '' : `<section class="panel" id="posts"><h2>Posts</h2><p class="muted small">${html.esc(p.name)} shares posts with family and friends only.</p></section>`
      return personPosts(ctx(c), me, { tree: null, families: store.treesFor(me.id).map((x) => store.tree(x.id)!), items, canPost: mine, back: `/profile/${p.slug}` })
    },
  })
  mountAlbums(app, api, { store, site, ctx, form, treeFor, image: { types: IMAGE_TYPES, max: MAX_PHOTO } })
  // Public pages with canonical links on the relay host, the one search engines can reach.
  mountFamous(app, api, { famous, ctx, site: publicSite, ...(daemonStatus ? { status: daemonStatus } : {}) })
  app.route('/api/v1', api)

  app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'not found' }, 404) : c.html(html.messagePage(ctx(c), 'Not found', 'There is nothing at this address.'), 404)))
  app.onError((error, c) => {
    console.error(error)
    return c.req.path.startsWith('/api/') ? c.json({ error: 'server error' }, 500) : c.html(html.messagePage(ctx(c), 'Something broke', 'That did not work. Try again in a moment.'), 500)
  })

  /** A bond to an existing person (other / other_id) or a new one from the person fields. */
  function addBondFrom(treeId: string, personId: string, body: Record<string, any>): Person {
    const kind = bondKind(body.kind)
    if (!kind || kind === 'pet') throw new Error(`kind must be one of: ${Object.keys(BONDS).filter((k) => k !== 'pet').join(', ')}`)
    const existingId = pickId(body.other_id ?? body.existing_id ?? body.existing)
    if (!existingId && !String(body.given ?? '').trim() && !String(body.surname ?? '').trim()) throw new Error('pick someone in the tree or give a name')
    return store.tx(() => {
      const other = existingId ? store.person(treeId, existingId) : store.addPerson(treeId, body)
      if (!other) throw new Error('that person is not in this tree')
      store.addBond(treeId, personId, other.id, kind, body.note ?? null)
      return other
    })
  }

  /** Claim a living, unclaimed person as yourself, or add yourself. Your account's email is the proof. */
  function claimSelf(treeId: string, user: User, body: Record<string, any>): string {
    if (store.profilePerson(treeId, user.id)) throw new Error('You already have a profile in this tree.')
    const chosen = pickId(body.person_id)
    if (chosen) {
      if (!store.unclaimed(treeId).some((p) => p.id === chosen)) throw new Error('That profile is taken, or is not someone living.')
      store.claimProfile(treeId, chosen, user.id)
      return chosen
    }
    if (!String(body.given ?? '').trim()) throw new Error('Pick yourself from the list, or give your name to add yourself.')
    return store.tx(() => {
      const me = store.addPerson(treeId, { ...body, living: 1 })
      store.claimProfile(treeId, me.id, user.id)
      return me.id
    })
  }

  /** The one unclaimed person whose name is exactly this, so a pasted "Karen Ettinger <k@x>" lands on her profile. */
  function matchPerson(treeId: string, name: string | null | undefined): string | null {
    const want = String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
    if (!want) return null
    const hits = store.unclaimed(treeId).filter((p) => fullName(p).toLowerCase() === want)
    return hits.length === 1 ? hits[0]!.id : null
  }

  /**
   * Make a one-time invite for `email` and mail it, within the sender's daily
   * allowance. The invitee goes into the sender's network as family, so the
   * people you bring into a tree are the first people in your network.
   */
  async function inviteToTree(from: User, treeId: string, email: string, role: InviteRole, opts: { personId?: string | null; note?: string | null; name?: string | null } = {}): Promise<{ url: string; mailed: boolean; failed?: string }> {
    const tree = store.tree(treeId)!
    const person = opts.personId ? store.person(treeId, opts.personId) : null
    const token = store.createInvite(treeId, from.id, role, email, { personId: person?.id ?? null, note: opts.note })
    const url = `${publicSite}/invite/${token}`
    net.ensureContact(from.id, email, { name: person ? fullName(person) : (opts.name ?? ''), circle: 'family', birthday: person?.birth_date ?? null }, { tree_id: treeId, person_id: person?.id ?? null })
    if (!(senderLimit(`invite:${from.id}`) && inviteLimit(`to:${email}`))) {
      store.setInviteMail(token, { mail_status: 'held', mail_error: "over the day's invitation limit" })
      return { url, mailed: false }
    }
    const r = await sendInvite(email, tree.name, from, url, role, { person, note: opts.note ?? null })
    store.setInviteMail(token, r.error ? { mail_status: 'failed', mail_error: r.error } : { mail_status: 'sent', mail_id: r.id })
    return r.error ? { url, mailed: false, failed: r.error } : { url, mailed: true }
  }

  /** "The Ettinger Family" -> "The Ettinger Family tree"; "Ettinger" -> "the Ettinger family tree". */
  const treeTitle = (name: string) => `${/^the\s/i.test(name) ? name : `the ${name}`}${/\btree$/i.test(name) ? '' : /\bfamil(y|ies)$/i.test(name) ? ' tree' : ' family tree'}`

  /** Tell someone who already has an account that they were made a member of a tree; no link to redeem, they just sign in. */
  async function sendAdded(email: string, treeId: string, from: User): Promise<boolean> {
    const tree = store.tree(treeId)!
    const name = from.name ?? from.email
    const url = `${publicSite}/t/${treeId}`
    const lead = `${name} added you to ${tree.name} on family.ancestry, as a viewer.`
    try {
      await auth.mail({
        to: email,
        subject: `${name} added you to ${treeTitle(tree.name)}`,
        text: `${lead}\n\nOpen it: ${url}\n\nSign in with this email address to see it.`,
        html: `<p>${html.esc(lead).replace(html.esc(name), `<b>${html.esc(name)}</b>`)}</p><p><a href="${html.esc(url)}" style="display:inline-block;padding:10px 18px;background:#3d6b4f;color:#fff;border-radius:6px;text-decoration:none">Open the tree</a></p><p style="color:#666;font-size:13px">${html.esc(url)}<br>Sign in with this email address to see it.</p>`,
      })
      return true
    } catch (error) {
      console.error(`[bring] mail failed: ${(error as Error).message}`)
      return false
    }
  }

  async function sendInvite(email: string, treeName: string, from: User, url: string, role: string, opts: { person?: Person | null; note?: string | null } = {}): Promise<{ id?: string | null; error?: string }> {
    const name = from.name ?? from.email
    const as = role === 'admin' ? 'an admin' : role === 'editor' ? 'an editor' : 'a viewer'
    const subject = opts.person ? `${name} added you to ${treeTitle(treeName)}` : `${name} invited you to ${treeTitle(treeName)}`
    const lead = opts.person
      ? `${name} added you to ${treeName} on family.ancestry as ${fullName(opts.person)}, and invited you to join the family: claim your profile and keep it up to date.`
      : `${name} invited you to ${treeName} on family.ancestry, as ${as}.`
    try {
      const id = await auth.mail({
        to: email,
        subject,
        text: `${lead}${opts.note ? `\n\n"${opts.note}"` : ''}\n\nJoin: ${url}\n\nThe link works once and expires in 14 days.`,
        html: `<p>${html.esc(lead).replace(html.esc(name), `<b>${html.esc(name)}</b>`)}</p>${opts.note ? `<blockquote style="border-left:3px solid #ccc;margin:0;padding:4px 12px;color:#444">${html.esc(opts.note)}</blockquote>` : ''}<p><a href="${html.esc(url)}" style="display:inline-block;padding:10px 18px;background:#3d6b4f;color:#fff;border-radius:6px;text-decoration:none">${opts.person ? 'Join the family' : 'Join the tree'}</a></p><p style="color:#666;font-size:13px">${html.esc(url)}<br>The link works once and expires in 14 days.</p>`,
      })
      return { id: id ?? null }
    } catch (error) {
      console.error(`[invite] mail to ${email} failed: ${(error as Error).message}`)
      return { error: (error as Error).message }
    }
  }

  return app
}

/**
 * Add a relative to `personId`: an existing person (body.existing or body.existing_id)
 * or a new one from the person fields. Returns the relative.
 *
 *   as=parent       relation birth | adopted | step | foster
 *   as=partner      kind married | engaged | partners | dating (boyfriend/girlfriend) | divorced
 *   as=child        relation, family_id (which partnership)
 *   as=sibling      sibling full | half | adopted | foster | step, via (the shared parent,
 *                   or for step the step-parent); with no parents recorded, a full
 *                   sibling still works: they share a family whose parents are unknown
 *   as=grandparent  via (which parent), or none: an "Unknown" parent is put in between,
 *                   for someone who knows their grandparents but not their parents
 *   as=great_grandparent  via (a grandparent, or a parent), else Unknowns in between
 *   as=grandchild   via (which child), else an "Unknown" child in between
 *   as=aunt_uncle   via (which parent they are a brother or sister of), else Unknown parent
 *   as=niece_nephew via (which brother or sister is their parent), else Unknown sibling
 *   as=cousin       via (which aunt or uncle is their parent, or which parent's side),
 *                   else Unknowns in between
 * Every missing link is an "Unknown" person, so the tree stays a real tree and
 * "How are we related?" still says aunt, cousin, great-grandmother.
 *
 * raised=1 also records that the relative raised this person (a "Raised by" bond),
 * which is how grandparents who brought someone up show as both.
 */
export function addRelative(store: Store, treeId: string, personId: string, body: Record<string, any>): Person {
  const person = store.person(treeId, personId)
  if (!person) throw new Error('no such person')
  if (person.kind === 'pet') throw new Error('pets have owners, not relatives')
  const as = String(body.as)
  if (!(RELATIVE_KINDS as readonly string[]).includes(as)) throw new Error(`as must be one of: ${RELATIVE_KINDS.join(', ')}`)
  const existingId = pickId(body.existing_id ?? body.existing)
  const hasNew = Boolean(String(body.given ?? '').trim() || String(body.surname ?? '').trim())
  if (!existingId && !hasNew) throw new Error('pick someone in the tree or give a name')
  const relationOf = (value: unknown) => ((CHILD_RELATIONS as readonly string[]).includes(String(value)) ? String(value) : 'birth')
  return store.tx(() => {
    const other = existingId ? store.person(treeId, existingId) : store.addPerson(treeId, body)
    if (!other) throw new Error('that person is not in this tree')
    if (other.id === person.id) throw new Error('a person cannot be their own relative')
    if (other.kind === 'pet') throw new Error('pets have owners, not relatives')
    const relation = relationOf(body.relation)
    if (as === 'parent') linkParent(store, treeId, person, other, relation)
    else if (as === 'partner') {
      const single = store.spouseFamilies(treeId, person.id).find((u) => !u.partner)
      const kind = [...UNION_KINDS, 'divorced'].includes(String(body.kind)) ? String(body.kind) : 'married'
      if (single) {
        store.setPartner(treeId, single.family.id, other.id)
        store.updateFamily(treeId, single.family.id, { kind: kind === 'divorced' ? 'married' : kind, end_date: kind === 'divorced' ? 'Divorced' : undefined })
      } else store.createFamily(treeId, person.id, other.id, { kind: kind === 'divorced' ? 'married' : kind, end_date: kind === 'divorced' ? 'Divorced' : null })
    } else if (as === 'child') {
      let familyId = body.family_id ? String(body.family_id) : ''
      if (familyId && !store.family(treeId, familyId)) familyId = ''
      if (!familyId) {
        const single = store.spouseFamilies(treeId, person.id).find((u) => !u.partner)
        familyId = single?.family.id ?? store.createFamily(treeId, person.id, null, { kind: 'partners' }).id
      }
      store.addChild(treeId, familyId, other.id, relation)
    } else if (as === 'sibling') linkSibling(store, treeId, person, other, String(body.sibling ?? 'full'), body.via ? pickId(body.via) : null)
    else {
      const viaId = body.via ? pickId(body.via) : null
      const chain = new Chain(store, treeId)
      if (as === 'grandparent') linkParent(store, treeId, chain.parent(person, viaId), other, relation)
      else if (as === 'great_grandparent') {
        // Through a grandparent, or a parent (an Unknown grandparent on their side), or Unknowns all the way.
        const grand = chain.grandparents(person).find((g) => g.id === viaId)
        const parent = grand ? null : chain.parent(person, store.parents(treeId, person.id).some((p) => p.id === viaId) ? viaId : null)
        linkParent(store, treeId, grand ?? chain.parent(parent!, null), other, relation)
      } else if (as === 'grandchild') addChildTo(store, treeId, chain.child(person, viaId), other, relation)
      else if (as === 'aunt_uncle') chain.brother(chain.parent(person, viaId), other)
      else if (as === 'niece_nephew') addChildTo(store, treeId, chain.sibling(person, viaId), other, relation)
      else {
        // Cousin: a child of an aunt or uncle, picked, or Unknown on a picked parent's side.
        const aunt = chain.auntsUncles(person).find((a) => a.id === viaId)
        const parent = aunt ? null : chain.parent(person, store.parents(treeId, person.id).some((p) => p.id === viaId) ? viaId : null)
        addChildTo(store, treeId, aunt ?? chain.sibling(parent!, null), other, relation)
      }
    }
    if (['1', 'on', 'true', 'yes', true].includes(body.raised)) store.addBond(treeId, person.id, other.id, 'raised_by')
    return store.person(treeId, other.id)!
  })
}

export const RELATIVE_KINDS = ['parent', 'partner', 'child', 'sibling', 'grandparent', 'great_grandparent', 'grandchild', 'aunt_uncle', 'niece_nephew', 'cousin'] as const

/**
 * One step along a family line: the picked parent, child or sibling, or with none
 * picked a new "Unknown" one in that place, so a cousin can be added before anyone
 * knows which aunt they belong to.
 */
class Chain {
  constructor(private store: Store, private treeId: string) {}
  private unknown(about: Person, what: string): Person {
    return this.store.addPerson(this.treeId, { given: 'Unknown', surname: '', notes: `${what} of ${fullName(about)} whose name we do not know yet. Fill this in if you learn who they were.` })
  }
  parent(person: Person, viaId: string | null): Person {
    const found = viaId ? this.store.parents(this.treeId, person.id).find((p) => p.id === viaId) : null
    if (viaId && !found) throw new Error(`that is not one of ${fullName(person)}'s parents`)
    if (found) return found
    const parent = this.unknown(person, 'A parent')
    linkParent(this.store, this.treeId, person, parent, 'birth')
    return parent
  }
  child(person: Person, viaId: string | null): Person {
    const found = viaId ? this.store.spouseFamilies(this.treeId, person.id).flatMap((u) => u.children).find((c) => c.id === viaId) : null
    if (viaId && !found) throw new Error(`that is not one of ${fullName(person)}'s children`)
    if (found) return found
    const child = this.unknown(person, 'A child')
    addChildTo(this.store, this.treeId, person, child, 'birth')
    return child
  }
  sibling(person: Person, viaId: string | null): Person {
    const found = viaId ? this.store.siblings(this.treeId, person.id).map((s) => s.person).find((p) => p.id === viaId) : null
    if (viaId && !found) throw new Error(`that is not one of ${fullName(person)}'s brothers or sisters`)
    if (found) return found
    const sib = this.unknown(person, 'A brother or sister')
    this.brother(person, sib)
    return sib
  }
  /** A full brother or sister through a real (or Unknown) parent: a family with no parents joins nobody up. */
  brother(person: Person, sib: Person) {
    if (!this.store.parents(this.treeId, person.id).length) this.parent(person, null)
    linkSibling(this.store, this.treeId, person, sib, 'full', null)
  }
  grandparents(person: Person): Person[] {
    return this.store.parents(this.treeId, person.id).flatMap((p) => this.store.parents(this.treeId, p.id))
  }
  auntsUncles(person: Person): Person[] {
    return this.store.parents(this.treeId, person.id).flatMap((p) => this.store.siblings(this.treeId, p.id).map((s) => s.person))
  }
}

/** A child of one person whose other parent is not known: their partnerless family, or a new one. */
function addChildTo(store: Store, treeId: string, parent: Person, child: Person, relation: string) {
  const single = store.spouseFamilies(treeId, parent.id).find((u) => !u.partner)
  store.addChild(treeId, single?.family.id ?? store.createFamily(treeId, parent.id, null, { kind: 'partners' }).id, child.id, relation)
}

/** Join the child's family of this relation if it has a free parent slot, else start one. */
function linkParent(store: Store, treeId: string, child: Person, parent: Person, relation: string) {
  const fams = store.parentFamilies(treeId, child.id).filter((f) => f.relation === relation)
  const open = fams.find((f) => !f.family.partner1_id || !f.family.partner2_id)
  if (open) store.setPartner(treeId, open.family.id, parent.id)
  else {
    // The new parent's existing family with no other partner may already hold siblings; reuse it.
    const single = store.spouseFamilies(treeId, parent.id).find((u) => !u.partner)
    const fam = single?.family ?? store.createFamily(treeId, parent.id, null, { kind: 'partners' })
    store.addChild(treeId, fam.id, child.id, relation)
  }
}

function linkSibling(store: Store, treeId: string, person: Person, sib: Person, kind: string, viaId: string | null) {
  const families = store.parentFamilies(treeId, person.id)
  if (kind === 'half' || kind === 'step') {
    const candidates = kind === 'half' ? families.flatMap((f) => f.parents) : store.stepParents(treeId, person.id)
    const via = viaId ? candidates.find((p) => p.id === viaId) : candidates.length === 1 ? candidates[0] : undefined
    if (!via) throw new Error(kind === 'half' ? 'say which parent they share (add the parent first)' : 'say which step-parent is their parent (add the step-parent as a partner of your parent first)')
    // Their own family with the shared parent: any of that parent's families this person is not in, partnerless first.
    // For a step-sibling, never the step-parent's family with this person's own parent: that would make them a half-sibling.
    const mine = new Set(families.map((f) => f.family.id))
    const myParents = new Set(families.flatMap((f) => f.parents.map((p) => p.id)))
    const theirs = store.spouseFamilies(treeId, via.id).filter((u) => !mine.has(u.family.id) && (kind === 'half' || !u.partner || !myParents.has(u.partner.id))).sort((a, b) => Number(Boolean(a.partner)) - Number(Boolean(b.partner)))[0]
    store.addChild(treeId, theirs?.family.id ?? store.createFamily(treeId, via.id, null, { kind: 'partners' }).id, sib.id, 'birth')
    return
  }
  const relation = kind === 'adopted' ? 'adopted' : kind === 'foster' ? 'foster' : 'birth'
  // Same family as this person: their birth family when there is one. No parents recorded yet is fine,
  // the family simply has no partners until someone fills them in.
  const fam = families.find((f) => f.relation === 'birth') ?? families[0]
  const familyId = fam?.family.id ?? store.createFamily(treeId, null, null, { kind: 'partners' }).id
  if (!fam) store.addChild(treeId, familyId, person.id, 'birth')
  store.addChild(treeId, familyId, sib.id, relation)
}

/** Run the server from the environment (used by `bun src/server.ts`, `ancestry serve` and the desktop app). */
export function serve() {
  const dataDir = process.env.ANCESTRY_DATA_DIR ?? join(process.env.HOME ?? '.', '.local', 'share', 'family-ancestry')
  const site = (process.env.ANCESTRY_SITE ?? 'https://family.ancestry').replace(/\/+$/, '')
  const store = new Store(join(dataDir, 'family.db'))
  const mailer: Mailer = process.env.RESEND_API_KEY ? resendMailer(process.env.RESEND_API_KEY, process.env.MAIL_FROM ?? 'family.ancestry <hello@pit.world>') : consoleMailer
  const auth = new Auth(store, mailer, site)
  // With a webhook, Resend pushes each email's fate and the key can be send-only (it cannot read
  // /emails/:id). Without one, a full-access key is asked when the Members page opens.
  const resendWebhookSecret = process.env.RESEND_WEBHOOK_SECRET || null
  const mailStatus = process.env.RESEND_API_KEY && !resendWebhookSecret ? resendStatus(process.env.RESEND_API_KEY) : null
  // Ours lives at family.ancestry, relayed by pit.world; a self-hosted copy on an ordinary domain needs no relay.
  const publicSite = (process.env.ANCESTRY_PUBLIC_SITE ?? (new URL(site).hostname === 'family.ancestry' ? 'https://family.ancestry.pit.world' : site)).replace(/\/+$/, '')
  const pitWorld = process.env.PIT_BRIDGE_SECRET ? { secret: process.env.PIT_BRIDGE_SECRET, ...(process.env.PIT_WORLD_URL ? { base: process.env.PIT_WORLD_URL } : {}) } : null
  // Names that only redirect here. family.tree is ours too: ANCESTRY_REDIRECT_HOSTS="" turns it off.
  const redirectHosts = (process.env.ANCESTRY_REDIRECT_HOSTS ?? (new URL(site).hostname === 'family.ancestry' ? 'family.tree' : '')).split(/[\s,]+/).filter(Boolean)
  // Famous families: the updater daemon keeps /famous current from Wikidata (daemon.ts). FAMOUS_DAEMON=off skips it.
  const famous = new Famous(store)
  const daemon = process.env.FAMOUS_DAEMON === 'off' ? null : buildDaemon(famous)
  const app = createApp({ store, auth, site, publicSite, plan: planFromEnv(), pitWorld, redirectHosts, mailStatus, resendWebhookSecret, famous, ...(daemon ? { daemonStatus: () => daemon.status() } : {}) })
  const port = Number(process.env.PORT ?? 8792)
  if (daemon) {
    famous.seed()
    daemon.start()
    process.on('SIGTERM', () => void daemon.stop().then(() => process.exit(0)))
  }
  startRingRefresh()
  startRingFooterRefresh()
  startPitFooterRefresh('family.ancestry')
  Bun.serve({ port, hostname: process.env.HOST ?? '127.0.0.1', fetch: app.fetch, maxRequestBodySize: 30 * 1024 * 1024 })
  console.log(`family.ancestry ${html.VERSION} on http://${process.env.HOST ?? '127.0.0.1'}:${port} (${site}, data ${dataDir}${process.env.RESEND_API_KEY ? '' : ', mail to console'})`)
}

if (import.meta.main) serve()
