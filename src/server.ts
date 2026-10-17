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
import { RING_PLACEHOLDER, ringBar, startRingRefresh, visitorOnMoshpit } from './ring.js'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { join } from 'node:path'
import { BONDS, CHILD_RELATIONS, Store, bondKind, canEdit, fullName, newId, type Person, type Role, type Tree, type User } from './db.js'
import { Auth, SESSION_COOKIE, consoleMailer, resendMailer, safeNext, validEmail, type Mailer } from './auth.js'
import { exportGedcom, importGedcom, describeImport } from './gedcom.js'
import { describeRelation } from './relate.js'
import { CHAIN_LABELS, SETTLED, hasPlan, isAdmin, planFromEnv, price, readWebhook, startCheckout, verifyWebhook, type PlanConfig } from './plan.js'
import * as html from './html.js'
import { Network } from './network.js'
import { mountNetwork } from './network-routes.js'
import { Local, mountLocal } from './local.js'
import { addonsPanel, profileInvite } from './network-html.js'

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
export type AppOptions = { store: Store; auth: Auth; site: string; publicSite?: string; publicDir?: string; net?: Network; plan?: PlanConfig; fetcher?: typeof fetch }

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

export function createApp({ store, auth, site, publicSite = site, publicDir = join(import.meta.dir, '..', 'public'), net = new Network(store), plan = planFromEnv({}), fetcher = fetch }: AppOptions) {
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
  const secure = (c: Context) => (c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '')) === 'https'
  const ip = (c: Context) => c.req.header('x-real-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'

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
      c.header('content-security-policy', "default-src 'self'; frame-src https://crawlproof.com; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' http://127.0.0.1:* http://localhost:*")
      c.header('cache-control', 'no-store')
    }
  })

  /** The words for how b is to a, with half- and step-siblings named properly. */
  const relate = (treeId: string, a: string, b: string) => {
    const path = store.relationship(treeId, a, b)
    return { path, words: describeRelation(path, store.siblings(treeId, a).find((s) => s.person.id === b)) }
  }

  const form = async (c: Context): Promise<Record<string, any>> => (c as any).formBody ?? (await c.req.parseBody().catch(() => ({})))
  const ctx = (c: Context, extra: Partial<html.Ctx> = {}): html.Ctx => ({ user: c.get('user'), csrf: c.get('csrf'), flash: c.req.query('ok') ?? null, unread: c.get('user') ? net.unreadCount(c.get('user')!.id) : 0, ...extra })
  const signIn = (c: Context, user: User) => {
    setCookie(c, SESSION_COOKIE, auth.createSession(user.id), { path: '/', httpOnly: true, sameSite: 'Lax', secure: secure(c), maxAge: 60 * 60 * 24 * 90 })
  }

  /** The tree and the caller's role in it, or a response that ends the request. */
  type TreeAccess = { error: Response; tree?: never; role?: never; user?: never } | { error?: undefined; tree: Tree; role: Role; user: User }
  const treeFor = (c: Context, need: 'view' | 'edit' | 'owner' = 'view'): TreeAccess => {
    const user = c.get('user')
    const tree = store.tree(c.req.param('tree')!)
    const role = tree ? store.role(tree.id, user?.id) : null
    const api = c.req.path.startsWith('/api/')
    const fail = (status: 401 | 403 | 404, message: string) => (api ? c.json({ error: message }, status) : status === 401 ? c.redirect(`/signin?next=${encodeURIComponent(c.req.path)}`) : c.html(html.messagePage(ctx(c), status === 404 ? 'Not found' : 'Not allowed', message), status))
    if (!user) return { error: fail(401, 'sign in first') as Response }
    // A tree you are not a member of is indistinguishable from one that does not exist.
    if (!tree || !role) return { error: fail(404, 'No such tree, or it has not been shared with you.') as Response }
    if (need === 'edit' && !canEdit(role)) return { error: fail(403, 'You can view this tree but not change it. Ask its owner to make you an editor.') as Response }
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

  app.get('/trees', (c) => needUser(c) ?? c.html(html.treesPage(ctx(c), store.treesFor(c.get('user')!.id))))
  app.post('/trees', async (c) => {
    if (needUser(c)) return needUser(c)!
    const body = await form(c)
    const tree = store.createTree(c.get('user')!.id, String(body.name ?? ''), body.description ? String(body.description) : null)
    return c.redirect(`/t/${tree.id}`)
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
        surnames: store.surnames(t.tree.id),
        query: q,
        plan: hasPlan(plan, store, t.tree),
      }),
    )
  })
  app.post('/t/:tree/settings', async (c) => {
    const t = treeFor(c, 'owner')
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
        citations: store.citationsFor(t.tree.id, person.id),
        media: store.mediaFor(t.tree.id, person.id),
        sources: store.sources(t.tree.id),
        everyone: canEdit(t.role) ? store.people(t.tree.id, 5000).filter((o) => o.kind === 'person') : [],
        siblings: store.siblings(t.tree.id, person.id),
        stepParents: store.stepParents(t.tree.id, person.id),
        bonds: store.bondsFor(t.tree.id, person.id),
        pets: store.petsOf(t.tree.id, person.id),
        plan: hasPlan(plan, store, t.tree),
        profile,
        self: profile?.id === t.user.id,
        // A member with no profile yet, looking at a living person nobody has claimed: "this is me".
        claimable: !profile && person.kind === 'person' && !person.death_date && !person.death_place && !store.profilePerson(t.tree.id, t.user.id),
        welcome: c.req.query('welcome') === '1',
        invite: invitable ? profileInvite(ctx(c), t.tree, person, { justAdded: c.req.query('added') === '1', owner: t.role === 'owner' }) : '',
      }),
    )
  })
  /** Editors, or the member who is this person (their own profile). */
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
    store.updatePerson(t.tree.id, c.req.param('person'), body)
    return c.redirect(`/t/${t.tree.id}/p/${c.req.param('person')}?ok=Saved`)
  })
  app.post('/t/:tree/p/:person/delete', (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    store.deletePerson(t.tree.id, c.req.param('person'))
    return c.redirect(`/t/${t.tree.id}?ok=Deleted`)
  })
  app.post('/t/:tree/p/:person/relative', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    const body = await form(c)
    try {
      const other = addRelative(store, t.tree.id, c.req.param('person'), body)
      return c.redirect(`/t/${t.tree.id}/p/${c.req.param('person')}?ok=${encodeURIComponent(`Added ${fullName(other)}`)}`)
    } catch (error) {
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
    const body = await form(c)
    const back = `/t/${t.tree.id}/p/${c.req.param('person')}`
    try {
      const other = addBondFrom(t.tree.id, c.req.param('person'), body)
      return c.redirect(`${back}?ok=${encodeURIComponent(`Added ${fullName(other)}`)}`)
    } catch (error) {
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
    store.updateFamily(t.tree.id, c.req.param('family'), { kind: body.kind, start_date: body.start_date, start_place: body.start_place, end_date: body.end_date })
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
    store.addEvent(t.tree.id, c.req.param('person'), { type: String(body.type ?? ''), date: body.date, place: body.place, description: body.description })
    return c.redirect(`/t/${t.tree.id}/p/${c.req.param('person')}`)
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
    store.addMedia(t.tree.id, c.req.param('person'), { filename: file.name, mime: file.type, data: new Uint8Array(await file.arrayBuffer()), caption: body.caption ?? null })
    return c.redirect(back)
  })
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
    return c.redirect(m?.person_id ? `/t/${t.tree.id}/p/${m.person_id}` : `/t/${t.tree.id}`)
  })
  app.post('/t/:tree/media/:media/delete', (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    const m = store.mediaInfo(t.tree.id, c.req.param('media'))
    store.deleteMedia(t.tree.id, c.req.param('media'))
    return c.redirect(m?.person_id ? `/t/${t.tree.id}/p/${m.person_id}` : `/t/${t.tree.id}`)
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
  const membersView = (c: Context, t: { tree: Tree; role: Role }, links: html.InviteLink[] = [], flash: string | null = null) =>
    c.html(html.membersPage(ctx(c, flash ? { flash } : {}), t.tree, t.role, store.members(t.tree.id), links, { pending: canEdit(t.role) ? store.pendingInvites(t.tree.id) : [], profiles: store.profiles(t.tree.id), people: (id) => store.person(t.tree.id, id), max: pasteMax(t.tree), plan: hasPlan(plan, store, t.tree) }))
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
    const role = t.role === 'owner' && body.role === 'editor' ? 'editor' : 'viewer'
    const personId = body.person_id && store.person(t.tree.id, String(body.person_id)) && !store.profileUser(t.tree.id, String(body.person_id)) ? String(body.person_id) : null
    const invitees = parseInvitees(body.emails ?? body.email, personId ? 1 : pasteMax(t.tree))
    const note = body.note ? String(body.note) : null
    if (!invitees.length) {
      if (body.back === 'person' && personId) return c.redirect(`/t/${t.tree.id}/p/${personId}?ok=${encodeURIComponent('That does not look like an email address.')}`)
      if (t.role !== 'owner') return membersView(c, t, [], 'Only the owner can make invite links. Invite by email instead.')
      return membersView(c, t, [{ email: null, url: `${publicSite}/invite/${store.createInvite(t.tree.id, t.user.id, role, null, { note })}`, mailed: false }])
    }
    const links: html.InviteLink[] = []
    for (const i of invitees) links.push({ email: i.email, ...(await inviteToTree(t.user, t.tree.id, i.email, role, { personId: personId ?? matchPerson(t.tree.id, i.name), note, name: i.name })) })
    const sent = links.filter((l) => l.mailed).length
    const flash = sent === links.length ? `Invite emailed to ${sent === 1 ? links[0]!.email : `${sent} people`}.` : `Emailed ${sent} of ${links.length}; that is a day's worth of invitations. The rest are links below.`
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
    const t = treeFor(c, 'owner')
    if (t.error) return t.error
    store.releaseProfile(t.tree.id, c.req.param('person'))
    return c.redirect(`/t/${t.tree.id}/members?ok=Profile%20unlinked`)
  })
  app.post('/t/:tree/members/:user', async (c) => {
    const t = treeFor(c, 'owner')
    if (t.error) return t.error
    const role = (await form(c)).role === 'editor' ? 'editor' : 'viewer'
    if (store.role(t.tree.id, c.req.param('user')) && store.role(t.tree.id, c.req.param('user')) !== 'owner') store.setMember(t.tree.id, c.req.param('user'), role)
    return c.redirect(`/t/${t.tree.id}/members`)
  })
  app.post('/t/:tree/members/:user/remove', (c) => {
    const t = treeFor(c, 'owner')
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
  const settings = (c: Context, newToken: string | null = null) => c.html(html.settingsPage(ctx(c), { passkeys: auth.passkeys(c.get('user')!.id), tokens: auth.tokens(c.get('user')!.id), newToken, addons: addonsPanel() }))
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
    const base = { ...p, name: fullName(p), url: `${site}/t/${treeId}/p/${p.id}`, profile: holder ? { user_id: holder.id, name: holder.name ?? holder.email } : null }
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
    }
  }

  api.use('*', async (c, next) => {
    if (c.req.path === '/api/v1/cli/token') return next()
    if (!apiUser(c)) return c.json({ error: 'sign in first: send Authorization: Bearer <token> (ancestry login makes one)' }, 401)
    await next()
  })
  api.get('/me', (c) => c.json({ user: apiUser(c), trees: store.treesFor(apiUser(c)!.id) }))
  api.get('/trees', (c) => c.json({ trees: store.treesFor(apiUser(c)!.id) }))
  api.post('/trees', async (c) => {
    const body = await json(c)
    return c.json({ tree: store.createTree(apiUser(c)!.id, String(body.name ?? 'Family tree'), body.description ?? null) }, 201)
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
    const body = await json(c)
    try {
      if (body.relative_of && body.as) return c.json({ person: personOut(t.tree.id, addRelative(store, t.tree.id, String(body.relative_of), body), true) }, 201)
      return c.json({ person: personOut(t.tree.id, store.addPerson(t.tree.id, body), true) }, 201)
    } catch (error) {
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
    const p = store.updatePerson(t.tree.id, c.req.param('person'), await json(c))
    return p ? c.json({ person: personOut(t.tree.id, p, true) }) : bad(c, 'no such person', 404)
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
      return c.json({ event: store.addEvent(t.tree.id, c.req.param('person'), { type: String(body.type ?? 'Event'), date: body.date, place: body.place, description: body.description }) }, 201)
    } catch (error) {
      return bad(c, error)
    }
  })
  api.post('/trees/:tree/people/:person/bonds', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    try {
      const other = addBondFrom(t.tree.id, c.req.param('person'), await json(c))
      return c.json({ person: personOut(t.tree.id, store.person(t.tree.id, c.req.param('person'))!, true), other: personOut(t.tree.id, other) }, 201)
    } catch (error) {
      return bad(c, error)
    }
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
  api.get('/trees/:tree/invites', (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    return c.json({ invites: store.pendingInvites(t.tree.id) })
  })
  /** {emails: [...]} or {email}, role, person_id (invite them to be that person), note. Without an email: a link. */
  api.post('/trees/:tree/invites', async (c) => {
    const t = treeFor(c, 'edit')
    if (t.error) return t.error
    const body = await json(c)
    const role = t.role === 'owner' && body.role === 'editor' ? 'editor' : 'viewer'
    const personId = body.person_id && store.person(t.tree.id, String(body.person_id)) ? String(body.person_id) : null
    if (personId && store.profileUser(t.tree.id, personId)) return bad(c, 'that person already manages their own profile')
    const invitees = parseInvitees(Array.isArray(body.emails) ? body.emails.join('\n') : (body.emails ?? body.email), personId ? 1 : pasteMax(t.tree))
    const note = body.note ? String(body.note) : null
    if (!invitees.length) {
      if (t.role !== 'owner') return bad(c, 'only the owner can make invite links; give an email')
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
    mail: (m) => auth.mail(m),
    limits: { invite: senderLimit, message: messageLimit },
    inviteToTree,
  })
  mountLocal(app, api, { local: new Local(store, net), ctx, form })
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
  async function inviteToTree(from: User, treeId: string, email: string, role: 'editor' | 'viewer', opts: { personId?: string | null; note?: string | null; name?: string | null } = {}): Promise<{ url: string; mailed: boolean }> {
    const tree = store.tree(treeId)!
    const person = opts.personId ? store.person(treeId, opts.personId) : null
    const url = `${publicSite}/invite/${store.createInvite(treeId, from.id, role, email, { personId: person?.id ?? null, note: opts.note })}`
    net.ensureContact(from.id, email, { name: person ? fullName(person) : (opts.name ?? ''), circle: 'family', birthday: person?.birth_date ?? null }, { tree_id: treeId, person_id: person?.id ?? null })
    const mailed = senderLimit(`invite:${from.id}`) && inviteLimit(`to:${email}`)
    if (mailed) await sendInvite(email, tree.name, from, url, role, { person, note: opts.note ?? null })
    return { url, mailed }
  }

  async function sendInvite(email: string, treeName: string, from: User, url: string, role: string, opts: { person?: Person | null; note?: string | null } = {}) {
    const name = from.name ?? from.email
    const as = role === 'editor' ? 'an editor' : 'a viewer'
    const subject = opts.person ? `${name} added you to the ${treeName} family tree` : `${name} invited you to the ${treeName} family tree`
    const lead = opts.person
      ? `${name} added you to ${treeName} on family.ancestry as ${fullName(opts.person)}, and invited you to join the family: claim your profile and keep it up to date.`
      : `${name} invited you to ${treeName} on family.ancestry, as ${as}.`
    try {
      await auth.mail({
        to: email,
        subject,
        text: `${lead}${opts.note ? `\n\n"${opts.note}"` : ''}\n\nJoin: ${url}\n\nThe link works once and expires in 14 days.`,
        html: `<p>${html.esc(lead).replace(html.esc(name), `<b>${html.esc(name)}</b>`)}</p>${opts.note ? `<blockquote style="border-left:3px solid #ccc;margin:0;padding:4px 12px;color:#444">${html.esc(opts.note)}</blockquote>` : ''}<p><a href="${html.esc(url)}" style="display:inline-block;padding:10px 18px;background:#3d6b4f;color:#fff;border-radius:6px;text-decoration:none">${opts.person ? 'Join the family' : 'Join the tree'}</a></p><p style="color:#666;font-size:13px">${html.esc(url)}<br>The link works once and expires in 14 days.</p>`,
      })
    } catch (error) {
      console.error(`[invite] mail failed: ${(error as Error).message}`)
    }
  }

  return app
}

/**
 * Add a relative to `personId`: an existing person (body.existing or body.existing_id)
 * or a new one from the person fields. Returns the relative.
 *
 *   as=parent       relation birth | adopted | step | foster
 *   as=partner      kind married | partners | divorced
 *   as=child        relation, family_id (which partnership)
 *   as=sibling      sibling full | half | adopted | foster | step, via (the shared parent,
 *                   or for step the step-parent); with no parents recorded, a full
 *                   sibling still works: they share a family whose parents are unknown
 *   as=grandparent  via (which parent), or none: an "Unknown" parent is put in between,
 *                   for someone who knows their grandparents but not their parents
 *
 * raised=1 also records that the relative raised this person (a "Raised by" bond),
 * which is how grandparents who brought someone up show as both.
 */
export function addRelative(store: Store, treeId: string, personId: string, body: Record<string, any>): Person {
  const person = store.person(treeId, personId)
  if (!person) throw new Error('no such person')
  if (person.kind === 'pet') throw new Error('pets have owners, not relatives')
  const as = String(body.as)
  if (!['parent', 'partner', 'child', 'sibling', 'grandparent'].includes(as)) throw new Error('as must be parent, partner, child, sibling or grandparent')
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
      const kind = ['married', 'partners', 'divorced'].includes(String(body.kind)) ? String(body.kind) : 'married'
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
      // Grandparent: the parent of one of this person's parents, or of an unknown one.
      const viaId = body.via ? pickId(body.via) : null
      const parents = store.parents(treeId, person.id)
      let parent = viaId ? (parents.find((p) => p.id === viaId) ?? null) : null
      if (viaId && !parent) throw new Error('that is not one of their parents')
      if (!parent) {
        parent = store.addPerson(treeId, { given: 'Unknown', surname: '', notes: `A parent of ${fullName(person)} whose name we do not know yet. Fill this in if you learn who they were.` })
        linkParent(store, treeId, person, parent, 'birth')
      }
      linkParent(store, treeId, parent, other, relation)
    }
    if (['1', 'on', 'true', 'yes', true].includes(body.raised)) store.addBond(treeId, person.id, other.id, 'raised_by')
    return store.person(treeId, other.id)!
  })
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
  // Ours lives at family.ancestry, relayed by pit.world; a self-hosted copy on an ordinary domain needs no relay.
  const publicSite = (process.env.ANCESTRY_PUBLIC_SITE ?? (new URL(site).hostname === 'family.ancestry' ? 'https://family.ancestry.pit.world' : site)).replace(/\/+$/, '')
  const app = createApp({ store, auth, site, publicSite, plan: planFromEnv() })
  const port = Number(process.env.PORT ?? 8792)
  startRingRefresh()
  Bun.serve({ port, hostname: process.env.HOST ?? '127.0.0.1', fetch: app.fetch, maxRequestBodySize: 30 * 1024 * 1024 })
  console.log(`family.ancestry ${html.VERSION} on http://${process.env.HOST ?? '127.0.0.1'}:${port} (${site}, data ${dataDir}${process.env.RESEND_API_KEY ? '' : ', mail to console'})`)
}

if (import.meta.main) serve()
