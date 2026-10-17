/**
 * Every page, server-rendered. Nothing here needs JavaScript: forms post, links
 * link. public/app.js adds the passkey ceremony and a few conveniences on top.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { BONDS, UNION_KINDS, fullName, lifespan, type Business, type Descendant, type Event, type Family, type Invite, type Media, type Payment, type Person, type Role, type Sibling, type Source, type Tree, type User, canEdit } from './db.js'

export const VERSION = '0.7.1'

export const esc = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const assetVersions = new Map<string, string>()
/** /style.css?v=<hash>: a deploy changes the URL, so no visitor is stuck on a cached stylesheet. */
export function asset(path: string): string {
  if (!assetVersions.has(path)) {
    let v = VERSION
    try {
      v = createHash('sha256').update(readFileSync(new URL(`../public${path}`, import.meta.url))).digest('hex').slice(0, 10)
    } catch {}
    assetVersions.set(path, v)
  }
  return `${path}?v=${assetVersions.get(path)}`
}

export type Ctx = { user: User | null; csrf?: string; flash?: string | null; error?: string | null; unread?: number }

export const csrfField = (ctx: Ctx) => (ctx.csrf ? `<input type="hidden" name="_csrf" value="${esc(ctx.csrf)}">` : '')

/**
 * pit.world proves a listing's owner by a meta tag on the homepage. PIT_VERIFY
 * comes from app.env, so the tag survives every deploy; anything but hex is ignored.
 */
export function pitVerifyMeta(value = process.env.PIT_VERIFY): string {
  return value && /^[0-9a-f]{16,64}$/i.test(value) ? `\n<meta name="pit-verify" content="${value}">` : ''
}

export function layout(ctx: Ctx, title: string, body: string, opts: { crumbs?: [string, string][]; wide?: boolean; head?: string } = {}): string {
  const crumbs = opts.crumbs?.length ? `<nav class="crumbs">${opts.crumbs.map(([href, label]) => (href ? `<a href="${esc(href)}">${esc(label)}</a>` : `<span>${esc(label)}</span>`)).join('<span class="sep">/</span>')}</nav>` : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}${title === 'family.ancestry' ? '' : ' · family.ancestry'}</title>
<meta name="description" content="Private family trees for your family: GEDCOM import and export, pedigree charts, photos, sources, invites. Open source.">
<meta name="theme-color" content="#2f5d43">${opts.head ?? ''}
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="${asset('/style.css')}">
<script src="${asset('/app.js')}" defer></script>
</head>
<body>
<!--ring-bar-->
<header class="top">
  <a class="brand" href="/">${leaf()}<span>family<b>.ancestry</b></span></a>
  <nav>${ctx.user ? `<a href="/trees">Trees</a><a href="/network">Network</a><a href="/local">Local</a><a href="/inbox">Inbox${ctx.unread ? ` <span class="badge">${ctx.unread}</span>` : ''}</a><a href="/settings">${esc(ctx.user.name ?? ctx.user.email)}</a>` : '<a href="/signin">Sign in</a>'}</nav>
</header>
<main class="${opts.wide ? 'wide' : ''}">
${crumbs}
${ctx.flash ? `<p class="flash">${esc(ctx.flash)}</p>` : ''}${ctx.error ? `<p class="flash error">${esc(ctx.error)}</p>` : ''}
${body}
</main>
${adBanner('text_link')}
<footer class="foot">
  <span>family.ancestry ${VERSION} · open source (MIT) · <a href="https://github.com/moshcoder/family.ancestry">code</a> · <a href="/about">about</a> · <a href="/connect">reach it from anywhere</a></span>
  <span>A <a href="https://pit.world">Moshpit</a> name. Your tree is private to the people you invite.</span>
</footer>
</body>
</html>`
}

/**
 * A crawlproof ad, as a cross-origin frame: our CSP needs one frame-src entry and
 * nothing else (no script, no cookie). Impressions are metered when it is served,
 * so a page renders one unit per spot, never a hidden spare. text_link is the only
 * fluid format; banner_300x250 is the widest that fits a phone.
 */
export const AD_SLOT = process.env.CRAWLPROOF_AD_SLOT ?? 'cb4310c4-7001-46ca-b625-159ee73df46b'
export const adBanner = (format: 'banner_300x250' | 'text_link' = 'banner_300x250') =>
  AD_SLOT === 'off' ? '' : `<div class="ad-unit ad-${format}"><iframe src="https://crawlproof.com/api/ads/frame?slot=${encodeURIComponent(AD_SLOT)}&amp;format=${format}" title="Advertisement" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation" scrolling="no"></iframe></div>`

const leaf = () => `<svg class="leaf" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 29V14" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M16 15c-7 0-11-4-11-11 7 0 11 4 11 11zM16 19c6 0 10-3.5 10-10-6 0-10 3.5-10 10z" fill="currentColor"/></svg>`

// ---- signed out ------------------------------------------------------------

export function homePage(ctx: Ctx): string {
  return layout(
    ctx,
    'family.ancestry',
    `<section class="hero">
  <h1>Your family's tree, kept by your family.</h1>
  <p class="lede">Build it together, private to the people you invite. Bring in a GEDCOM from Ancestry, FamilySearch or MyHeritage, and take it with you whenever you like.</p>
  ${signInForm(ctx, '/trees')}
</section>
<section class="features">
  <div><h3>Pedigree and descendants</h3><p>Four generations at a glance, every branch a click away. Ahnentafel numbers included.</p></div>
  <div><h3>GEDCOM in and out</h3><p>Import the file every genealogy site exports. Export yours, with living people hidden if you share it outside the family.</p></div>
  <div><h3>Photos, stories, sources</h3><p>Attach photos to people, write down what grandma remembers, cite the census page you found it on.</p></div>
  <div><h3>How are we related?</h3><p>Pick two people and get the answer in words: "second cousin once removed".</p></div>
  <div><h3>Invite the family</h3><p>By email, from anyone's page: they join as themselves and keep their own profile up to date.</p></div>
  <div><h3>Your network, free</h3><p>Family, friends and work contacts with every detail you keep, and a private inbox. For people who know each other: no followers, no ads, no strangers.</p></div>
  <div><h3>Everywhere you are</h3><p>Install it as an app, or use the desktop app, the <code>ancestry</code> CLI, the terminal UI, or let your AI assistant read it over MCP.</p></div>
</section>`,
    { head: pitVerifyMeta() },
  )
}

export function signInForm(ctx: Ctx, next: string | null = null): string {
  return `<form class="signin" method="post" action="/auth/link">
  ${csrfField(ctx)}
  ${next ? `<input type="hidden" name="next" value="${esc(next)}">` : ''}
  <label for="email">Email</label>
  <div class="row"><input id="email" name="email" type="email" autocomplete="email webauthn" required placeholder="you@example.com"><button>Email me a link</button></div>
  <p class="muted small">No password. New here? The same link makes your account. <button type="button" class="link" data-passkey-signin hidden>Sign in with a passkey</button></p>
</form>
<p class="pitworld"><a class="btn" href="/auth/pitworld${next ? `?next=${encodeURIComponent(next)}` : ''}">Sign in with pit.world</a> <span class="muted small">One account for every pit.world site, signed in with CoinPay.</span></p>`
}

export function signInPage(ctx: Ctx, next: string | null): string {
  return layout(ctx, 'Sign in', `<h1>Sign in or sign up</h1>${signInForm(ctx, next)}`)
}

export function checkEmailPage(ctx: Ctx): string {
  return layout(ctx, 'Check your email', `<h1>Check your email</h1><p>If that address can receive mail, a sign-in link is on its way. It works once, for 20 minutes.</p><p class="muted">Nothing after a few minutes? Look in spam, or <a href="/signin">try again</a>.</p>`)
}

export function messagePage(ctx: Ctx, title: string, message: string, status = ''): string {
  return layout(ctx, title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>${status}`)
}

// ---- trees -----------------------------------------------------------------

export function treesPage(ctx: Ctx, trees: (Tree & { role: Role; people: number })[]): string {
  const list = trees.length
    ? `<ul class="cards">${trees.map((t) => `<li><a href="/t/${t.id}"><h3>${esc(t.name)}</h3><p class="muted">${t.people} ${t.people === 1 ? 'person' : 'people'} · ${t.role}</p>${t.description ? `<p>${esc(t.description)}</p>` : ''}</a></li>`).join('')}</ul>`
    : '<p class="empty">No trees yet. Start one below, or import a GEDCOM file from another site.</p>'
  return layout(
    ctx,
    'Your trees',
    `<h1>Your trees</h1>${list}
<div class="split">
<form method="post" action="/trees" class="panel">${csrfField(ctx)}<h2>Start a tree</h2>
  <label>Name<input name="name" required maxlength="200" placeholder="The Ettinger family"></label>
  <label>Description<textarea name="description" rows="2" maxlength="2000"></textarea></label>
  <button>Create tree</button></form>
<form method="post" action="/trees/import" enctype="multipart/form-data" class="panel">${csrfField(ctx)}<h2>Import a GEDCOM</h2>
  <p class="muted small">From Ancestry: Trees → Tree settings → Export tree. Most other sites call it "Export GEDCOM".</p>
  <label>Tree name<input name="name" maxlength="200" placeholder="Imported tree"></label>
  <label>File<input type="file" name="file" accept=".ged,.gedcom,text/plain" required></label>
  <button>Import</button></form>
</div>`,
  )
}

const personLink = (treeId: string, p: Person | null | undefined, cls = '') =>
  p ? `<a class="pl ${cls} sex-${p.sex}" href="/t/${treeId}/p/${p.id}">${esc(fullName(p))}${lifespan(p) ? ` <span class="yrs">${esc(lifespan(p))}</span>` : ''}</a>` : '<span class="muted">unknown</span>'

export function treePage(ctx: Ctx, tree: Tree, role: Role, data: { stats: Record<string, number>; home: Person | null; people: Person[]; businesses?: Business[]; surnames: { surname: string; n: number }[]; query: string; plan?: boolean }): string {
  const edit = canEdit(role)
  const list = data.people.length
    ? `<table class="people"><thead><tr><th>Name</th><th>Born</th><th>Died</th></tr></thead><tbody>${data.people
        .map((p) => `<tr><td>${personLink(tree.id, p)}${p.kind === 'pet' ? ` <span class="tag">${esc(p.species ?? 'pet')}</span>` : ''}</td><td>${esc([p.birth_date, p.birth_place].filter(Boolean).join(', '))}</td><td>${esc([p.death_date, p.death_place].filter(Boolean).join(', '))}</td></tr>`)
        .join('')}</tbody></table>`
    : `<p class="empty">${data.query ? 'Nobody matches that.' : 'This tree is empty.'}</p>`
  const businesses = data.businesses?.length
    ? `<h2>Businesses</h2><ul class="plain">${data.businesses.map((b) => `<li><a class="pl biz" href="/t/${tree.id}/b/${b.id}">${esc(b.name)}</a>${b.category ? ` <span class="tag">${esc(b.category)}</span>` : ''}${b.place ? ` <span class="muted small">${esc(b.place)}</span>` : ''}</li>`).join('')}</ul>${data.people.length ? '<h2>People</h2>' : ''}`
    : ''
  return layout(
    ctx,
    tree.name,
    `<div class="titlebar"><div><h1>${esc(tree.name)}</h1>${tree.description ? `<p class="muted">${esc(tree.description)}</p>` : ''}</div>
<div class="actions">${data.home ? `<a class="btn" href="/t/${tree.id}/pedigree/${data.home.id}">Pedigree</a><a class="btn" href="/t/${tree.id}/descendants/${data.home.id}">Descendants</a>` : ''}<a class="btn" href="/t/${tree.id}/relate">How are we related?</a><a class="btn" href="/t/${tree.id}/photos">Photos</a><a class="btn" href="/t/${tree.id}/businesses">Businesses</a><a class="btn" href="/t/${tree.id}/sources">Sources</a><a class="btn" href="/t/${tree.id}/export.ged">Export GEDCOM</a><a class="btn" href="/t/${tree.id}/plan">${data.plan ? 'Family plan ✓' : 'Family plan'}</a>${edit ? `<a class="btn" href="/t/${tree.id}/members#invite">Invite family</a>` : `<a class="btn" href="/t/${tree.id}/members">Members</a>`}</div></div>
<p class="stats">${Object.entries(data.stats).map(([k, v]) => `<span><b>${v}</b> ${k}</span>`).join('')}</p>
${data.home ? `<p>Home person: ${personLink(tree.id, data.home)}</p>` : ''}
<form class="search" method="get" action="/t/${tree.id}"><input name="q" value="${esc(data.query)}" placeholder="Search people and businesses: names, places, years" aria-label="Search people and businesses"><button>Search</button></form>
${data.surnames.length && !data.query ? `<p class="surnames">${data.surnames.slice(0, 40).map((s) => `<a href="/t/${tree.id}?q=${encodeURIComponent(s.surname)}">${esc(s.surname)} <span>${s.n}</span></a>`).join('')}</p>` : ''}
${businesses}${data.businesses?.length && !data.people.length ? '' : list}
${edit ? `<details class="panel"${data.people.length ? '' : ' open'}><summary>Add a person</summary>${personForm(ctx, `/t/${tree.id}/people`, null, 'Add person')}</details>
<details class="panel"><summary>Import a GEDCOM into this tree</summary><form method="post" action="/t/${tree.id}/import" enctype="multipart/form-data">${csrfField(ctx)}<input type="file" name="file" accept=".ged,.gedcom,text/plain" required> <button>Import</button></form></details>` : ''}
${role === 'owner' ? `<details class="panel"><summary>Tree settings</summary><form method="post" action="/t/${tree.id}/settings">${csrfField(ctx)}<label>Name<input name="name" value="${esc(tree.name)}" maxlength="200"></label><label>Description<textarea name="description" rows="2">${esc(tree.description ?? '')}</textarea></label><button>Save</button></form>
<form method="post" action="/t/${tree.id}/delete" data-confirm="Delete ${esc(tree.name)} and everyone in it? This cannot be undone.">${csrfField(ctx)}<button class="danger">Delete this tree</button></form></details>` : ''}`,
    { crumbs: [['/trees', 'Trees'], ['', tree.name]] },
  )
}

export function personForm(ctx: Ctx, action: string, p: Partial<Person> | null, label: string, extra = ''): string {
  const v = (k: keyof Person) => esc(p?.[k] ?? '')
  const sex = p?.sex ?? 'U'
  return `<form method="post" action="${esc(action)}" class="pform">${csrfField(ctx)}${extra}
  <div class="grid2"><label>Given names<input name="given" value="${v('given')}" maxlength="200" autocomplete="off"></label><label>Surname<input name="surname" value="${v('surname')}" maxlength="200" autocomplete="off"></label></div>
  <div class="grid3"><label>Sex<select name="sex">${[['U', 'Unknown'], ['F', 'Female'], ['M', 'Male'], ['X', 'Other']].map(([k, l]) => `<option value="${k}"${sex === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
  <label class="check"><input type="checkbox" name="living" value="1"${p?.living ? ' checked' : ''}> Living</label></div>
  <div class="grid2"><label>Born<input name="birth_date" value="${v('birth_date')}" placeholder="12 MAR 1901, ABT 1890" maxlength="200"></label><label>Birthplace<input name="birth_place" value="${v('birth_place')}" maxlength="200"></label></div>
  <div class="grid2"><label>Died<input name="death_date" value="${v('death_date')}" maxlength="200"></label><label>Place of death<input name="death_place" value="${v('death_place')}" maxlength="200"></label></div>
  <label>Notes and stories<textarea name="notes" rows="3" maxlength="20000">${v('notes')}</textarea></label>
  <button>${esc(label)}</button></form>`
}

const UNION_LABEL: Record<string, string> = { married: 'married', partners: 'partners', dating: 'boyfriend / girlfriend' }
const unionLabel = (kind: string) => UNION_LABEL[kind] ?? kind
/** The kinds a partnership can be, with an imported one (a civil union, say) kept as it was. */
const unionOptions = (current: string) =>
  [...UNION_KINDS, ...((UNION_KINDS as readonly string[]).includes(current) ? [] : [current])].map((k) => `<option value="${esc(k)}"${k === current ? ' selected' : ''}>${esc(unionLabel(k))}</option>`).join('')
const RELATION_OPTIONS = `<option value="birth">birth</option><option value="adopted">adopted</option><option value="step">step</option><option value="foster">foster</option>`
const SEX_SELECT = `<label>Sex<select name="sex"><option value="U">Unknown</option><option value="F">Female</option><option value="M">Male</option><option value="X">Other</option></select></label>`

type RelativeKind = 'parent' | 'partner' | 'child' | 'sibling' | 'grandparent'

/** "Add a relative": a new person, or someone already in the tree (picked by name from a datalist). */
function relativeForm(ctx: Ctx, tree: Tree, person: Person, kind: RelativeKind, opts: { families?: { family: Family; partner: Person | null }[]; parents?: Person[]; stepParents?: Person[] } = {}): string {
  const titles: Record<RelativeKind, string> = { parent: 'Add a parent', partner: 'Add a partner', child: 'Add a child', sibling: 'Add a brother or sister', grandparent: 'Add a grandparent' }
  const families = opts.families ?? []
  const parents = opts.parents ?? []
  const stepParents = opts.stepParents ?? []
  const famSelect =
    kind === 'child' && families.length
      ? `<label>With<select name="family_id">${families.map((f) => `<option value="${f.family.id}">${f.partner ? esc(fullName(f.partner)) : 'unknown partner'}</option>`).join('')}<option value="">no partner / unknown</option></select></label>`
      : ''
  const relation = kind === 'parent' || kind === 'child' || kind === 'grandparent' ? `<label>Relationship<select name="relation">${RELATION_OPTIONS}</select></label>` : ''
  const kindSelect = kind === 'partner' ? `<label>As<select name="kind"><option value="married">married</option><option value="partners">partners</option><option value="dating">boyfriend / girlfriend</option><option value="divorced">divorced</option></select></label>` : ''
  const siblingSelect =
    kind === 'sibling'
      ? `<label>Kind<select name="sibling"><option value="full">full (same parents${parents.length ? '' : ', even if unknown'})</option>${parents.length ? '<option value="half">half (one parent shared)</option>' : ''}<option value="adopted">adopted into the family</option><option value="foster">foster</option>${stepParents.length ? '<option value="step">step (a step-parent\'s child)</option>' : ''}</select></label>${
          parents.length || stepParents.length
            ? `<label>Through <span class="muted small">for half or step</span><select name="via"><option value="">—</option>${parents.map((pp) => `<option value="${pp.id}">${esc(fullName(pp))} (parent)</option>`).join('')}${stepParents.map((pp) => `<option value="${pp.id}">${esc(fullName(pp))} (step-parent)</option>`).join('')}</select></label>`
            : ''
        }`
      : ''
  const viaGrand =
    kind === 'grandparent'
      ? `<label>On whose side<select name="via">${parents.map((pp) => `<option value="${pp.id}">${esc(fullName(pp))}'s parent</option>`).join('')}<option value="">a parent we don't know</option></select></label>`
      : ''
  const raised = kind === 'parent' || kind === 'grandparent' || kind === 'sibling' ? `<label class="check"><input type="checkbox" name="raised" value="1"> They raised ${esc(person.given || 'them')}</label>` : ''
  const surname = kind === 'child' || kind === 'sibling' || (kind === 'parent' && person.sex !== 'F') ? esc(person.surname) : ''
  return `<details class="panel"><summary>${titles[kind]}</summary>
<form method="post" action="/t/${tree.id}/p/${person.id}/relative" class="pform">${csrfField(ctx)}<input type="hidden" name="as" value="${kind}">
  ${kind === 'grandparent' && !parents.length ? '<p class="muted small">No parents recorded: we put an "Unknown" parent in between, so you can fill them in later.</p>' : ''}
  <p class="muted small">Someone already in the tree:</p>
  <div class="row"><input name="existing" list="people-${tree.id}" placeholder="Start typing a name" autocomplete="off"> </div>
  <p class="muted small">Or someone new:</p>
  <div class="grid2"><label>Given names<input name="given" maxlength="200"></label><label>Surname<input name="surname" maxlength="200" value="${surname}"></label></div>
  <div class="grid3">${SEX_SELECT}<label>Born<input name="birth_date" maxlength="200"></label><label class="check"><input type="checkbox" name="living" value="1"> Living</label></div>
  <div class="grid3">${famSelect}${relation}${kindSelect}${siblingSelect}${viaGrand}</div>
  ${raised}
  <button>${titles[kind]}</button>
</form></details>`
}

/** Raised by, guardian, godparent, caregiver, chosen family: people who matter and are not a line of descent. */
function bondForm(ctx: Ctx, tree: Tree, person: Person): string {
  const kinds = Object.entries(BONDS).filter(([k]) => k !== 'pet')
  return `<details class="panel"><summary>Add someone who raised them, a godparent, a guardian…</summary>
<form method="post" action="/t/${tree.id}/p/${person.id}/bonds" class="pform">${csrfField(ctx)}
  <label>They are ${esc(person.given || 'this person')}'s<select name="kind">${kinds.map(([k, b]) => `<option value="${k}">${esc(b.as.toLowerCase())}</option>`).join('')}</select></label>
  <p class="muted small">Someone already in the tree:</p>
  <div class="row"><input name="existing" list="people-${tree.id}" placeholder="Start typing a name" autocomplete="off"></div>
  <p class="muted small">Or someone new:</p>
  <div class="grid2"><label>Given names<input name="given" maxlength="200"></label><label>Surname<input name="surname" maxlength="200"></label></div>
  <div class="grid3">${SEX_SELECT}<label>Born<input name="birth_date" maxlength="200"></label><label class="check"><input type="checkbox" name="living" value="1"> Living</label></div>
  <label>Note<input name="note" maxlength="500" placeholder="From age 4, after Mom passed"></label>
  <button>Add</button>
</form></details>`
}

function petForm(ctx: Ctx, tree: Tree, person: Person, plan: boolean): string {
  if (!plan) return `<details class="panel"><summary>Add a pet</summary><p>Pets are part of the <a href="/t/${tree.id}/plan">Family plan</a>: paid once for the whole family, and it also lets you invite everyone you want.</p></details>`
  return `<details class="panel"><summary>Add a pet</summary>
<form method="post" action="/t/${tree.id}/p/${person.id}/pets" class="pform">${csrfField(ctx)}
  <div class="grid2"><label>Name<input name="given" maxlength="200" required></label><label>Species<input name="species" maxlength="80" list="species" placeholder="Dog, cat, horse…"></label></div>
  <div class="grid3"><label>Born<input name="birth_date" maxlength="200"></label><label>Died<input name="death_date" maxlength="200"></label><label class="check"><input type="checkbox" name="living" value="1" checked> Still with us</label></div>
  <label>Their story<textarea name="notes" rows="2" maxlength="20000"></textarea></label>
  <datalist id="species">${['Dog', 'Cat', 'Horse', 'Rabbit', 'Bird', 'Fish', 'Hamster', 'Guinea pig', 'Reptile', 'Goat', 'Chicken'].map((x) => `<option value="${x}">`).join('')}</datalist>
  <button>Add pet</button>
</form></details>`
}

const SIBLING_WORDS: Record<string, string> = { full: '', half: 'half', step: 'step', adoptive: 'adopted', foster: 'foster' }

export type PersonView = {
  person: Person
  parents: { family: Family; relation: string; parents: Person[]; siblings: Person[] }[]
  unions: { family: Family; partner: Person | null; children: Person[] }[]
  siblings?: Sibling[]
  stepParents?: Person[]
  bonds?: { id: string; kind: string; label: string; other: Person; note: string | null }[]
  pets?: Person[]
  /** The tree is on the Family plan. */
  plan?: boolean
  /** The viewer has no profile here and this is a living, unclaimed person. */
  claimable?: boolean
  /** Just claimed: lead with the photo upload. */
  welcome?: boolean
  events: Event[]
  citations: (Source & { page: string | null })[]
  media: Media[]
  sources: Source[]
  everyone: Person[]
  /** The member who is this person, if one has joined as them. */
  profile?: User | null
  /** The viewer is this person: they may keep their own profile up to date. */
  self?: boolean
  /** The quiet "invite them to manage this profile" offer, already rendered. */
  invite?: string
  /** Their businesses, already rendered (src/business.ts). */
  businesses?: string
  /** "Add to my network" or "In my network", already rendered (src/network-html.ts). */
  network?: string
  /** Their life in date order (src/life.ts): birth, partnerships starting and ending, children, events, death. */
  timeline?: { type: string; date: string | null; place: string | null; description: string | null; id: string }[]
  /** The "Add an event" panel, already rendered (src/life.ts). */
  eventForm?: string
  /** Their partners' children by someone else, per partnership. */
  stepChildren?: { familyId: string; children: Person[] }[]
}

export function personPage(ctx: Ctx, tree: Tree, role: Role, v: PersonView): string {
  const p = v.person
  const pet = p.kind === 'pet'
  const edit = canEdit(role)
  const own = edit || Boolean(v.self)
  const photo = p.photo_id ? `<img class="portrait" src="/t/${tree.id}/media/${p.photo_id}" alt="${esc(fullName(p))}">` : `<div class="portrait none sex-${p.sex}">${esc((p.given[0] ?? '') + (p.surname[0] ?? '') || '?')}</div>`
  const facts = [
    ['Born', [p.birth_date, p.birth_place].filter(Boolean).join(' · ')],
    ['Died', [p.death_date, p.death_place].filter(Boolean).join(' · ') || (p.living ? 'Living' : '')],
  ].filter(([, val]) => val)
  const timeline = v.timeline ?? [
    ...(p.birth_date || p.birth_place ? [{ type: 'Birth', date: p.birth_date, place: p.birth_place, description: null, id: '' }] : []),
    ...v.events,
    ...(p.death_date || p.death_place ? [{ type: 'Death', date: p.death_date, place: p.death_place, description: null, id: '' }] : []),
  ]
  const datalist = `<datalist id="people-${tree.id}">${v.everyone.filter((o) => o.id !== p.id).map((o) => `<option value="${esc(`${fullName(o)}${lifespan(o) ? ` (${lifespan(o)})` : ''} #${o.id}`)}"></option>`).join('')}</datalist>`
  return layout(
    ctx,
    fullName(p),
    `<div class="person-head">${photo}<div><h1>${esc(fullName(p))}</h1><p class="muted">${esc(lifespan(p))}${pet ? ` · ${esc(p.species ?? 'pet')}` : p.sex !== 'U' ? ` · ${{ M: 'male', F: 'female', X: 'other' }[p.sex] ?? ''}` : ''}</p>
${facts.map(([k, val]) => `<p><b>${k}</b> ${esc(val)}</p>`).join('')}
${v.profile ? `<p class="small muted">${v.self ? 'This is you. Keep it up to date.' : `Managed by ${esc(v.profile.name ?? v.profile.email)}, in the family since ${new Date(v.profile.created_at).getFullYear()}.`}</p>` : (v.invite ?? '')}
${v.claimable ? `<form method="post" action="/t/${tree.id}/claim" class="inline" data-confirm="Claim ${esc(fullName(p))} as you? The owner can see who claimed it.">${csrfField(ctx)}<input type="hidden" name="person_id" value="${p.id}"><button class="btn">This is me</button></form>` : ''}
${v.welcome && v.self && !p.photo_id ? `<form method="post" action="/t/${tree.id}/p/${p.id}/media" enctype="multipart/form-data" class="panel pform">${csrfField(ctx)}<h2>Add your photo</h2><p class="muted small">So the family knows it's you. JPEG, PNG, WebP or AVIF, under 8 MB.</p><input type="file" name="file" accept="image/*" capture="user" required><button>Upload</button></form>` : ''}
${v.network ?? ''}
<div class="actions">${pet ? '' : `<a class="btn" href="/t/${tree.id}/pedigree/${p.id}">Pedigree</a>`}${pet ? '' : `<a class="btn" href="/t/${tree.id}/descendants/${p.id}">Descendants</a><a class="btn" href="/t/${tree.id}/relate?a=${tree.home_person_id ?? ''}&b=${p.id}">Related how?</a>`}${edit && !pet && tree.home_person_id !== p.id ? `<form method="post" action="/t/${tree.id}/home" class="inline">${csrfField(ctx)}<input type="hidden" name="person_id" value="${p.id}"><button class="btn">Make home person</button></form>` : ''}</div></div></div>

${pet ? '' : `<div class="cols">
<section><h2>Parents</h2>${
      v.parents.length
        ? v.parents.map((f) => `<div class="line">${f.parents.map((pp) => personLink(tree.id, pp)).join(' &amp; ') || '<span class="muted">unknown</span>'}${f.relation !== 'birth' ? ` <span class="tag">${esc(f.relation)}</span>` : ''}${edit ? ` <form method="post" action="/t/${tree.id}/p/${p.id}/unlink" class="inline">${csrfField(ctx)}<input type="hidden" name="family_id" value="${f.family.id}"><button class="x" title="Remove from this family">×</button></form>` : ''}</div>`).join('')
        : '<p class="muted">None recorded.</p>'
    }${
      v.siblings?.length
        ? `<h2>Brothers and sisters</h2><ul>${v.siblings.map((s) => `<li>${personLink(tree.id, s.person)}${SIBLING_WORDS[s.kind] ? ` <span class="tag">${SIBLING_WORDS[s.kind]}${s.via ? ` · via ${esc(fullName(s.via))}` : ''}</span>` : ''}</li>`).join('')}</ul>`
        : ''
    }</section>
<section><h2>Partners and children</h2>${
      v.unions.length
        ? v.unions.map((u) => `<div class="union"><div class="line">${u.partner ? personLink(tree.id, u.partner) : '<span class="muted">unknown partner</span>'} <span class="tag">${esc(unionLabel(u.family.kind))}${u.family.start_date ? ` ${esc(u.family.start_date)}` : ''}${u.family.end_date || u.family.end_kind ? ` · ${esc(u.family.end_kind ?? 'divorced')}${u.family.end_date && !['divorced', 'separated', 'widowed'].includes(u.family.end_date.toLowerCase()) ? ` ${esc(u.family.end_date)}` : ''}` : ''}</span></div>${u.children.length ? `<ul>${u.children.map((c) => `<li>${personLink(tree.id, c)}</li>`).join('')}</ul>` : ''}${(() => { const steps = v.stepChildren?.find((x) => x.familyId === u.family.id)?.children ?? []; return steps.length ? `<p class="small"><span class="tag">step-children</span> ${steps.map((c) => personLink(tree.id, c)).join(', ')}</p>` : '' })()}${edit ? `<details class="mini"><summary>edit</summary><form method="post" action="/t/${tree.id}/f/${u.family.id}" class="pform">${csrfField(ctx)}<div class="grid3"><label>Kind<select name="kind">${unionOptions(u.family.kind)}</select></label><label>Date<input name="start_date" value="${esc(u.family.start_date ?? '')}"></label><label>Place<input name="start_place" value="${esc(u.family.start_place ?? '')}"></label></div><div class="grid3"><label>Ended<input name="end_date" value="${esc(u.family.end_date ?? '')}" placeholder="date, or leave empty"></label><label>How<select name="end_kind"><option value="">—</option>${['divorced', 'separated', 'widowed'].map((k) => `<option value="${k}"${(u.family.end_kind ?? (u.family.end_date ? 'divorced' : '')) === k ? ' selected' : ''}>${k}</option>`).join('')}</select></label><label>Where<input name="end_place" value="${esc(u.family.end_place ?? '')}"></label></div><button>Save</button></form><form method="post" action="/t/${tree.id}/f/${u.family.id}/delete" data-confirm="Remove this partnership? The people stay in the tree.">${csrfField(ctx)}<button class="danger small">Remove partnership</button></form></details>` : ''}</div>`).join('')
        : '<p class="muted">None recorded.</p>'
    }</section>
</div>`}
${
  v.bonds?.length
    ? `<section><h2>${pet ? 'Family' : 'Raised by, godparents and pets'}</h2><ul>${v.bonds.map((b) => `<li><span class="tag">${esc(b.label)}</span> ${personLink(tree.id, b.other)}${b.other.kind === 'pet' && b.other.species ? ` <span class="muted small">${esc(b.other.species)}</span>` : ''}${b.note ? ` <span class="muted small">${esc(b.note)}</span>` : ''}${edit ? ` <form method="post" action="/t/${tree.id}/bonds/${b.id}/delete" class="inline">${csrfField(ctx)}<input type="hidden" name="back" value="${p.id}"><button class="x" title="Remove">×</button></form>` : ''}</li>`).join('')}</ul></section>`
    : ''
}
${v.businesses ?? ''}
${edit && !pet ? `${datalist}<div class="cols3">${relativeForm(ctx, tree, p, 'parent')}${relativeForm(ctx, tree, p, 'partner')}${relativeForm(ctx, tree, p, 'child', { families: v.unions })}${relativeForm(ctx, tree, p, 'sibling', { parents: v.parents.flatMap((f) => f.parents), stepParents: v.stepParents })}${relativeForm(ctx, tree, p, 'grandparent', { parents: v.parents.flatMap((f) => f.parents) })}${bondForm(ctx, tree, p)}${petForm(ctx, tree, p, Boolean(v.plan))}</div>` : ''}

<section><h2>Timeline</h2>${
      timeline.length
        ? `<ol class="timeline">${timeline.map((e) => `<li><span class="when">${esc(e.date ?? '')}</span><b>${esc(e.type)}</b>${e.place ? ` · ${esc(e.place)}` : ''}${e.description ? `<br><span class="muted">${esc(e.description)}</span>` : ''}${edit && e.id ? ` <form method="post" action="/t/${tree.id}/e/${e.id}/delete" class="inline">${csrfField(ctx)}<input type="hidden" name="person_id" value="${p.id}"><button class="x" title="Delete event">×</button></form>` : ''}</li>`).join('')}</ol>`
        : '<p class="muted">Nothing yet.</p>'
    }
${own ? (v.eventForm ?? '') : ''}
</section>

${p.notes ? `<section><h2>Notes and stories</h2><div class="notes">${esc(p.notes).replace(/\n/g, '<br>')}</div></section>` : ''}

<section><h2>Photos</h2>${v.media.length ? `<div class="photos">${v.media.map((m) => `<figure><a href="/t/${tree.id}/media/${m.id}"><img loading="lazy" src="/t/${tree.id}/media/${m.id}" alt="${esc(m.caption ?? m.filename)}"></a><figcaption>${esc(m.caption ?? '')}${edit ? ` <form method="post" action="/t/${tree.id}/media/${m.id}/primary" class="inline">${csrfField(ctx)}<button class="link small">${p.photo_id === m.id ? 'portrait' : 'use as portrait'}</button></form><form method="post" action="/t/${tree.id}/media/${m.id}/delete" class="inline" data-confirm="Delete this photo?">${csrfField(ctx)}<button class="x">×</button></form>` : ''}</figcaption></figure>`).join('')}</div>` : '<p class="muted">No photos yet.</p>'}
${own ? `<form method="post" action="/t/${tree.id}/p/${p.id}/media" enctype="multipart/form-data" class="row">${csrfField(ctx)}<input type="file" name="file" accept="image/*" required><input name="caption" placeholder="Caption" maxlength="1000"><button>Upload</button></form>` : ''}</section>

<section><h2>Sources</h2>${v.citations.length ? `<ul>${v.citations.map((s) => `<li>${s.url ? `<a href="${esc(s.url)}" rel="noopener noreferrer" target="_blank">${esc(s.title)}</a>` : esc(s.title)}${s.page ? ` · ${esc(s.page)}` : ''}${s.author ? ` <span class="muted">${esc(s.author)}</span>` : ''}${edit ? ` <form method="post" action="/t/${tree.id}/p/${p.id}/uncite" class="inline">${csrfField(ctx)}<input type="hidden" name="source_id" value="${s.id}"><button class="x">×</button></form>` : ''}</li>`).join('')}</ul>` : '<p class="muted">No sources cited.</p>'}
${edit ? `<details class="panel"><summary>Cite a source</summary><form method="post" action="/t/${tree.id}/p/${p.id}/cite" class="pform">${csrfField(ctx)}${v.sources.length ? `<label>Existing source<select name="source_id"><option value="">— new source below —</option>${v.sources.map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join('')}</select></label>` : ''}<div class="grid2"><label>New source title<input name="title" placeholder="1910 US Census"></label><label>Link<input name="url" type="url" placeholder="https://"></label></div><label>Page or detail<input name="page" placeholder="Sheet 4A, line 12"></label><button>Cite</button></form></details>` : ''}</section>

${own ? `<details class="panel"${v.self && !edit ? ' open' : ''}><summary>${v.self ? 'Edit your profile' : `Edit ${esc(fullName(p))}`}</summary>${personForm(ctx, `/t/${tree.id}/p/${p.id}`, p, 'Save')}
${edit ? `<form method="post" action="/t/${tree.id}/p/${p.id}/delete" data-confirm="Delete ${esc(fullName(p))}?${pet ? '' : ' Their relationships go too.'}">${csrfField(ctx)}<button class="danger">Delete this person</button></form>` : ''}</details>` : ''}`,
    { crumbs: [['/trees', 'Trees'], [`/t/${tree.id}`, tree.name], ['', fullName(p)]] },
  )
}

// ---- charts ----------------------------------------------------------------

/** A left-to-right pedigree: generation g occupies column g, each box centred on its slot. */
export function pedigreeSvg(treeId: string, people: Map<number, Person>, generations: number): string {
  const boxW = 210
  const boxH = 52
  const gapX = 40
  const rows = 2 ** (generations - 1)
  const slotH = 64
  const height = rows * slotH
  const width = generations * (boxW + gapX)
  const parts: string[] = []
  const pos = (n: number) => {
    const g = Math.floor(Math.log2(n))
    const index = n - 2 ** g
    const span = rows / 2 ** g
    return { x: g * (boxW + gapX), y: (index + 0.5) * span * slotH - boxH / 2 }
  }
  for (let n = 1; n < 2 ** generations; n++) {
    const { x, y } = pos(n)
    const p = people.get(n)
    if (n > 1) {
      const parent = pos(Math.floor(n / 2))
      if (people.get(Math.floor(n / 2))) parts.push(`<path class="edge" d="M${parent.x + boxW} ${parent.y + boxH / 2} H${parent.x + boxW + gapX / 2} V${y + boxH / 2} H${x}"/>`)
    }
    if (p) {
      parts.push(`<a href="/t/${treeId}/pedigree/${p.id}"><g class="box sex-${p.sex}"><rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="7"/><text x="${x + 10}" y="${y + 21}" class="nm">${esc(trim(fullName(p), 26))}</text><text x="${x + 10}" y="${y + 39}" class="yr">${esc(lifespan(p))}  #${n}</text></g></a>`)
    } else if (people.get(Math.floor(n / 2))) {
      parts.push(`<g class="box empty"><rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="7"/><text x="${x + 10}" y="${y + 31}" class="yr">unknown</text></g>`)
    }
  }
  return `<svg class="pedigree" viewBox="-2 -2 ${width} ${height + 4}" width="${width}" height="${height + 4}" role="img" aria-label="Pedigree chart">${parts.join('')}</svg>`
}

const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function pedigreePage(ctx: Ctx, tree: Tree, root: Person, people: Map<number, Person>, generations: number): string {
  return layout(
    ctx,
    `Pedigree of ${fullName(root)}`,
    `<div class="titlebar"><h1>Pedigree of ${personLink(tree.id, root)}</h1><div class="actions">${[3, 4, 5, 6].map((g) => `<a class="btn${g === generations ? ' on' : ''}" href="/t/${tree.id}/pedigree/${root.id}?g=${g}">${g} gen</a>`).join('')}<a class="btn" href="/t/${tree.id}/descendants/${root.id}">Descendants</a></div></div>
<p class="muted small">Click anyone to put them at the root. Numbers are Ahnentafel: a person's father is 2n, mother 2n+1.</p>
<div class="chart">${pedigreeSvg(tree.id, people, generations)}</div>`,
    { crumbs: [['/trees', 'Trees'], [`/t/${tree.id}`, tree.name], [`/t/${tree.id}/p/${root.id}`, fullName(root)], ['', 'Pedigree']], wide: true },
  )
}

function descendantList(treeId: string, d: Descendant): string {
  const unions = d.unions
    .map((u) => `<li class="union">${u.partner ? `<span class="amp">&amp;</span> ${personLink(treeId, u.partner)}` : '<span class="amp">&amp;</span> <span class="muted">unknown</span>'}${u.children.length ? `<ul>${u.children.map((c) => `<li>${descendantList(treeId, c)}</li>`).join('')}</ul>` : ''}</li>`)
    .join('')
  return `${personLink(treeId, d.person)}${unions ? `<ul class="unions">${unions}</ul>` : ''}`
}

export function descendantsPage(ctx: Ctx, tree: Tree, d: Descendant, depth: number): string {
  return layout(
    ctx,
    `Descendants of ${fullName(d.person)}`,
    `<div class="titlebar"><h1>Descendants of ${personLink(tree.id, d.person)}</h1><div class="actions">${[2, 3, 4, 6].map((g) => `<a class="btn${g === depth ? ' on' : ''}" href="/t/${tree.id}/descendants/${d.person.id}?g=${g}">${g} gen</a>`).join('')}<a class="btn" href="/t/${tree.id}/pedigree/${d.person.id}">Pedigree</a></div></div>
<div class="desc">${descendantList(tree.id, d)}</div>`,
    { crumbs: [['/trees', 'Trees'], [`/t/${tree.id}`, tree.name], [`/t/${tree.id}/p/${d.person.id}`, fullName(d.person)], ['', 'Descendants']], wide: true },
  )
}

export function relatePage(ctx: Ctx, tree: Tree, everyone: Person[], a: Person | null, b: Person | null, answer: { words: string; path: { person: Person; step: string }[] | null } | null): string {
  const opt = (sel: Person | null) => everyone.map((p) => `<option value="${p.id}"${sel?.id === p.id ? ' selected' : ''}>${esc(fullName(p))}${lifespan(p) ? ` (${esc(lifespan(p))})` : ''}</option>`).join('')
  const stepWord: Record<string, string> = { parent: 'whose parent is', child: 'whose child is', partner: 'whose partner is', self: '' }
  return layout(
    ctx,
    'How are we related?',
    `<h1>How are we related?</h1>
<form method="get" action="/t/${tree.id}/relate" class="row relate"><select name="a" aria-label="First person">${opt(a)}</select><span>and</span><select name="b" aria-label="Second person">${opt(b)}</select><button>Find out</button></form>
${answer && a && b ? `<div class="answer"><p class="big">${personLink(tree.id, b)} is ${esc(fullName(a))}'s <b>${esc(answer.words)}</b>.</p>${answer.path ? `<ol class="path">${answer.path.map((s) => `<li>${s.step !== 'self' ? `<span class="muted">${stepWord[s.step]}</span> ` : ''}${personLink(tree.id, s.person)}</li>`).join('')}</ol>` : ''}</div>` : ''}`,
    { crumbs: [['/trees', 'Trees'], [`/t/${tree.id}`, tree.name], ['', 'Relationship']] },
  )
}

export function sourcesPage(ctx: Ctx, tree: Tree, role: Role, sources: Source[]): string {
  return layout(
    ctx,
    'Sources',
    `<h1>Sources</h1>${sources.length ? `<ul class="sources">${sources.map((s) => `<li><b>${s.url ? `<a href="${esc(s.url)}" rel="noopener noreferrer" target="_blank">${esc(s.title)}</a>` : esc(s.title)}</b>${s.author ? ` · ${esc(s.author)}` : ''}${s.citation ? `<br><span class="muted small">${esc(s.citation)}</span>` : ''}${canEdit(role) ? ` <form method="post" action="/t/${tree.id}/sources/${s.id}/delete" class="inline" data-confirm="Delete this source and its citations?">${csrfField(ctx)}<button class="x">×</button></form>` : ''}</li>`).join('')}</ul>` : '<p class="empty">No sources yet.</p>'}
${canEdit(role) ? `<form method="post" action="/t/${tree.id}/sources" class="panel pform">${csrfField(ctx)}<h2>Add a source</h2><div class="grid2"><label>Title<input name="title" required></label><label>Author or repository<input name="author"></label></div><label>Link<input name="url" type="url" placeholder="https://"></label><label>Transcription or citation<textarea name="citation" rows="3"></textarea></label><button>Add source</button></form>` : ''}`,
    { crumbs: [['/trees', 'Trees'], [`/t/${tree.id}`, tree.name], ['', 'Sources']] },
  )
}

export type InviteLink = { email: string | null; url: string; mailed: boolean }

export function membersPage(
  ctx: Ctx,
  tree: Tree,
  role: Role,
  members: { user_id: string; email: string; name: string | null; role: Role }[],
  links: InviteLink[],
  extra: { pending: Invite[]; profiles: Map<string, string>; people: (id: string) => Person | null; max?: number; plan?: boolean } = { pending: [], profiles: new Map(), people: () => null },
): string {
  const owner = role === 'owner'
  const edit = canEdit(role)
  const days = (t: number) => Math.max(1, Math.ceil((t - Date.now()) / 86_400_000))
  const asPerson = (personId: string | null | undefined) => {
    const p = personId ? extra.people(personId) : null
    return p ? ` <span class="muted small">as</span> ${personLink(tree.id, p)}` : ''
  }
  return layout(
    ctx,
    'Members',
    `<h1>Who can see ${esc(tree.name)}</h1>
<table class="people"><thead><tr><th>Member</th><th>Role</th><th></th></tr></thead><tbody>${members
      .map(
        (m) => `<tr><td>${esc(m.name ?? m.email)}${m.name ? ` <span class="muted small">${esc(m.email)}</span>` : ''}${asPerson(extra.profiles.get(m.user_id))}</td><td>${
          owner && m.role !== 'owner'
            ? `<form method="post" action="/t/${tree.id}/members/${m.user_id}" class="inline">${csrfField(ctx)}<select name="role" data-autosubmit>${['editor', 'viewer'].map((r) => `<option${r === m.role ? ' selected' : ''}>${r}</option>`).join('')}</select><noscript><button>Save</button></noscript></form>`
            : m.role
        }</td><td>${owner && m.role !== 'owner' ? `<form method="post" action="/t/${tree.id}/members/${m.user_id}/remove" class="inline" data-confirm="Remove ${esc(m.email)}?">${csrfField(ctx)}<button class="x">×</button></form>` : ''}</td></tr>`,
      )
      .join('')}</tbody></table>
${
  links.length
    ? `<div class="panel">${links.map((l) => `<p class="small">${l.email ? `${esc(l.email)}: ${l.mailed ? 'emailed. Or send them this link yourself:' : '<b>not emailed</b> (daily limit). Send them this link yourself:'}` : 'Send this link. It works once.'}</p><p class="copy"><input readonly value="${esc(l.url)}" data-copy><button type="button" data-copy-btn>Copy</button></p>`).join('')}</div>`
    : ''
}
${
  edit
    ? `<form method="post" action="/t/${tree.id}/invites" class="panel pform" id="invite">${csrfField(ctx)}<h2>Invite family by email</h2><p class="muted small">Each person gets their own link from you, by email. It works once and expires in 14 days.${owner ? ' Editors can add and change people; viewers can only look.' : ' You can invite viewers; the owner can make them editors.'}</p>
<label>Their emails <span class="muted small">paste a list, up to ${extra.max ?? 20} at once: one per line, a To: line from your mail, a spreadsheet column, "Aunt Rose &lt;rose@example.com&gt;"</span><textarea name="emails" rows="6" required placeholder="Karen Ettinger <karen@example.com>&#10;cousin@example.com, aunt.rose@example.com"></textarea></label>
<p class="muted small">When a name you paste matches someone in the tree, their invite is to be that person. Everyone else picks themselves when they join. A profile is only ever claimed from the email address it was sent to.${extra.plan ? '' : ` Need more? The <a href="/t/${tree.id}/plan">Family plan</a> lifts the limits.`}</p>
<div class="grid2">${owner ? `<label>Role<select name="role"><option>editor</option><option selected>viewer</option></select></label>` : ''}<label>A line from you (optional)<input name="note" maxlength="1000" placeholder="Help me fill in Grandpa's side!"></label></div><button>Email invites</button></form>
${owner ? `<form method="post" action="/t/${tree.id}/invites" class="row">${csrfField(ctx)}<select name="role" aria-label="Role"><option>editor</option><option selected>viewer</option></select><button class="btn">Just make a link</button> <span class="muted small">to send yourself, by text or chat</span></form>` : ''}`
    : ''
}
${
  edit && extra.pending.length
    ? `<section class="panel"><h2>Waiting to join</h2><ul>${extra.pending.map((i) => `<li>${esc(i.email ?? 'link')}${asPerson(i.person_id)} <span class="muted small">${i.role}, ${days(i.expires_at)} days left</span> <form method="post" action="/t/${tree.id}/invites/${i.id}/revoke" class="inline">${csrfField(ctx)}<button class="x" title="Cancel invite">×</button></form></li>`).join('')}</ul></section>`
    : ''
}
<p class="muted small">Tip: invite someone from their own page in the tree and they join as that person, able to keep their profile up to date.</p>`,
    { crumbs: [['/trees', 'Trees'], [`/t/${tree.id}`, tree.name], ['', 'Members']] },
  )
}

/** "Which one is you?" for someone who joined without an invite tied to a profile. */
export function claimPage(ctx: Ctx, tree: Tree, unclaimed: Person[], opts: { name?: string; mismatch?: boolean } = {}): string {
  const guess = (opts.name ?? '').toLowerCase()
  const likely = guess ? unclaimed.filter((p) => guess.includes(p.given.toLowerCase()) && (!p.surname || guess.includes(p.surname.toLowerCase()))) : []
  const rest = unclaimed.filter((p) => !likely.includes(p))
  const pick = (p: Person) => `<li><form method="post" action="/t/${tree.id}/claim" class="inline">${csrfField(ctx)}<input type="hidden" name="person_id" value="${p.id}"><button class="link">${esc(fullName(p))}</button></form> <span class="muted small">${esc(lifespan(p))}${p.birth_place ? ` · ${esc(p.birth_place)}` : ''}</span></li>`
  return layout(
    ctx,
    'Which one is you?',
    `<h1>Welcome to ${esc(tree.name)}</h1>
${opts.mismatch ? '<p class="panel">That invite was for a profile under a different email address, so it was not given to this account. If it is you, sign in with the address the invite went to, or ask for a new invite.</p>' : ''}
<p>Find yourself in the family, and that profile is yours to keep up to date: your dates, your photo, your story. You signed in with your email, which is how we know it is you.</p>
${likely.length ? `<h2>Is this you?</h2><ul>${likely.map(pick).join('')}</ul>` : ''}
${rest.length ? `<details class="panel"${likely.length ? '' : ' open'}><summary>Everyone living without a profile yet (${rest.length})</summary><ul>${rest.map(pick).join('')}</ul></details>` : ''}
<details class="panel"${unclaimed.length ? '' : ' open'}><summary>I'm not in the tree yet</summary>
<form method="post" action="/t/${tree.id}/claim" class="pform">${csrfField(ctx)}
  <div class="grid2"><label>Given names<input name="given" maxlength="200" required value="${esc((opts.name ?? '').split(' ')[0] ?? '')}"></label><label>Surname<input name="surname" maxlength="200" value="${esc((opts.name ?? '').split(' ').slice(1).join(' '))}"></label></div>
  <div class="grid2"><label>Born<input name="birth_date" maxlength="200" placeholder="12 MAR 1980"></label><label>Birthplace<input name="birth_place" maxlength="200"></label></div>
  <button>Add me</button>
</form><p class="muted small">An editor can then connect you to your parents and the rest of the family.</p></details>
<p><a href="/t/${tree.id}">Skip for now</a></p>`,
    { crumbs: [['/trees', 'Trees'], [`/t/${tree.id}`, tree.name], ['', 'Which one is you?']] },
  )
}

export function planPage(ctx: Ctx, tree: Tree, role: Role, v: { active: boolean; admin: boolean; price: string; chains: { id: string; label: string }[]; payments: Payment[]; returned: boolean }): string {
  const pending = v.payments.find((p) => p.status === 'pending')
  const status = v.active
    ? `<p class="panel"><b>${esc(tree.name)} is on the Family plan.</b> ${v.admin && !tree.plan_paid_at ? 'Included with your admin account.' : tree.plan_paid_at ? `Paid ${new Date(tree.plan_paid_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}. Nothing more to pay, ever.` : ''}</p>`
    : v.returned || pending
      ? `<p class="panel">Waiting for the payment to confirm on its chain. This page will say so once it has; a few minutes is normal, an hour for Bitcoin.</p>`
      : ''
  return layout(
    ctx,
    'Family plan',
    `<h1>The Family plan</h1>
${status}
<p><b>${esc(v.price)}, once, for the whole family.</b> No subscription. Everyone in ${esc(tree.name)} gets it.</p>
<ul>
<li><b>Pets.</b> The dogs, cats and horses that were family too, with their photos and stories.</li>
<li><b>Invite everyone.</b> Paste the whole family's email list at once (500 at a time), and every member can bring in the family and friends they want, without the daily limit.</li>
<li>Everything else stays free for everyone: the tree, siblings, adoptions, step-families, photos, GEDCOM, the network.</li>
</ul>
${
  v.active
    ? ''
    : v.chains.length
      ? `<form method="post" action="/t/${tree.id}/plan/checkout" class="panel pform">${csrfField(ctx)}<label>Pay with<select name="chain">${v.chains.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('')}</select></label><button>Pay ${esc(v.price)}</button><p class="muted small">Crypto, through CoinPay. ${role === 'owner' ? '' : 'Anyone in the family can pay; it covers the whole tree.'}</p></form>`
      : '<p class="muted">Payments are not set up on this server yet.</p>'
}`,
    { crumbs: [['/trees', 'Trees'], [`/t/${tree.id}`, tree.name], ['', 'Family plan']] },
  )
}

export function invitePage(ctx: Ctx, tree: Tree, role: string, token: string, extra: { from?: User | null; person?: Person | null; note?: string | null } = {}): string {
  const from = extra.from ? esc(extra.from.name ?? extra.from.email) : 'Someone'
  return layout(
    ctx,
    `Join ${tree.name}`,
    `${
      extra.person
        ? `<h1>Join the family</h1><p>${from} added you to <b>${esc(tree.name)}</b> as ${personLink(tree.id, extra.person)}. Join, and that profile is yours: fix the dates, add your photos and your story.</p>`
        : `<h1>You're invited to ${esc(tree.name)}</h1><p>${from} invited you, as ${role === 'editor' ? 'an editor: you can add and change people' : 'a viewer: you can look at everything'}.</p>`
    }
${extra.note ? `<blockquote class="notes">${esc(extra.note)}</blockquote>` : ''}
${ctx.user ? `<form method="post" action="/invite/${esc(token)}">${csrfField(ctx)}<button>Join as ${esc(ctx.user.email)}</button></form>` : `<p>Sign in or sign up first; you'll come straight back here.</p>${signInForm(ctx, `/invite/${token}`)}`}`,
  )
}

export function settingsPage(ctx: Ctx, data: { passkeys: { id: string; label: string | null; created_at: number; last_used_at: number | null }[]; tokens: { id: string; label: string | null; created_at: number; last_used_at: number | null }[]; newToken?: string | null; addons?: string; pitWorld?: { linked: boolean } | null }): string {
  const when = (t: number | null) => (t ? new Date(t).toISOString().slice(0, 10) : 'never')
  return layout(
    ctx,
    'Settings',
    `<h1>Settings</h1>
<form method="post" action="/settings/name" class="panel pform">${csrfField(ctx)}<h2>Your name</h2><label>Shown to other members of your trees<input name="name" value="${esc(ctx.user?.name ?? '')}" maxlength="120"></label><p class="muted small">Signed in as ${esc(ctx.user?.email.endsWith('@pit.invalid') ? 'your pit.world account' : ctx.user?.email)}</p><button>Save</button></form>
<section class="panel"><h2>Passkeys</h2><p class="muted small">Sign in with your fingerprint, face or device PIN instead of waiting for an email.</p>
${data.passkeys.length ? `<ul>${data.passkeys.map((k) => `<li>${esc(k.label ?? 'Passkey')} <span class="muted small">added ${when(k.created_at)}, last used ${when(k.last_used_at)}</span> <form method="post" action="/settings/passkeys/${encodeURIComponent(k.id)}/delete" class="inline">${csrfField(ctx)}<button class="x">×</button></form></li>`).join('')}</ul>` : ''}
<button type="button" data-passkey-register>Add a passkey</button> <span class="muted small" data-passkey-status></span></section>
${
  data.pitWorld
    ? `<section class="panel"><h2>pit.world account</h2><p class="muted small">One account for every pit.world site: this tree, every <code>bbs.&lt;name&gt;.pit.world</code> board and <code>social.&lt;name&gt;.pit.world</code> feed. Manage it at <a href="https://pit.world/account">pit.world/account</a>.</p>${
        data.pitWorld.linked
          ? `<p>Linked: you can sign in here with pit.world.</p>${ctx.user?.email.endsWith('@pit.invalid') ? '' : `<form method="post" action="/settings/pitworld/unlink" class="inline">${csrfField(ctx)}<button class="x">Unlink</button></form>`}`
          : '<p><a class="btn" href="/auth/pitworld?next=/settings">Link my pit.world account</a></p>'
      }</section>`
    : ''
}
<section class="panel"><h2>Apps and tokens</h2><p class="muted small">The <code>ancestry</code> CLI, the terminal app, the desktop app and MCP clients sign in with a token. <code>ancestry login</code> makes one for you.</p>
${data.newToken ? `<p class="flash">New token (shown once): <code>${esc(data.newToken)}</code></p>` : ''}
${data.tokens.length ? `<ul>${data.tokens.map((t) => `<li>${esc(t.label ?? 'token')} <span class="muted small">made ${when(t.created_at)}, last used ${when(t.last_used_at)}</span> <form method="post" action="/settings/tokens/${t.id}/delete" class="inline">${csrfField(ctx)}<button class="x">×</button></form></li>`).join('')}</ul>` : ''}
<form method="post" action="/settings/tokens" class="row">${csrfField(ctx)}<input name="label" placeholder="What is it for?" maxlength="80"><button>Make a token</button></form></section>
${data.addons ?? ''}
<form method="post" action="/auth/signout">${csrfField(ctx)}<button class="danger">Sign out</button></form>`,
  )
}

export function cliAuthorizePage(ctx: Ctx, params: { challenge: string; redirect: string; state: string; label: string }): string {
  return layout(
    ctx,
    'Sign in the CLI',
    `<h1>Let <code>${esc(params.label || 'ancestry')}</code> use your account?</h1><p>It will be able to read and change every tree you can, as ${esc(ctx.user?.email)}. You can revoke it any time in Settings.</p>
<form method="post" action="/cli/authorize">${csrfField(ctx)}<input type="hidden" name="code_challenge" value="${esc(params.challenge)}"><input type="hidden" name="redirect_uri" value="${esc(params.redirect)}"><input type="hidden" name="state" value="${esc(params.state)}"><input type="hidden" name="label" value="${esc(params.label)}"><button>Allow</button> <a href="/">Cancel</a></form>`,
  )
}

export function aboutPage(ctx: Ctx): string {
  return layout(
    ctx,
    'About',
    `<h1>About family.ancestry</h1>
<p>An open-source family tree app: what you'd use Ancestry for, without the subscription, and without your family's history becoming someone else's product. Your tree is private to the people you invite. Nothing is sold, matched or shown to strangers.</p>
<h2>Use it everywhere</h2>
<ul>
<li><b>Web and phone:</b> install it from your browser's menu ("Install app" / "Add to Home Screen").</li>
<li><b>Desktop:</b> the family.ancestry app for macOS, Windows and Linux (GitHub releases).</li>
<li><b>CLI:</b> <code>bun add -g familyancestry</code>, then <code>ancestry login</code>, <code>ancestry people &lt;tree&gt;</code>, <code>ancestry import tree.ged</code>, <code>ancestry pedigree &lt;person&gt;</code>.</li>
<li><b>Terminal app:</b> <code>ancestry tui</code>.</li>
<li><b>AI assistants:</b> <code>claude mcp add ancestry -- ancestry mcp</code> lets your assistant search and add to the trees you share with it.</li>
<li><b>API:</b> JSON under <code>/api/v1</code> with a bearer token; see the README.</li>
</ul>
<h2>Bring your tree</h2><p>Every genealogy site exports GEDCOM. Import it on the Trees page; export yours any time from a tree's page, optionally with living people hidden.</p>
<p class="muted">Source: <a href="https://github.com/moshcoder/family.ancestry">github.com/moshcoder/family.ancestry</a> (MIT).</p>`,
  )
}

export function connectPage(ctx: Ctx, site: string): string {
  return layout(
    ctx,
    'Reach family.ancestry',
    `<h1>Reach family.ancestry from anywhere</h1>
<p>family.ancestry is a name on the <a href="https://pit.world">Moshpit network</a>, not the ordinary DNS, so a browser needs one setting to find it. Pick one:</p>
<ol>
<li><b>Easiest: the desktop app</b> finds it by itself; nothing to set up.</li>
<li><b>Any browser:</b> follow <a href="https://pit.world/connect">pit.world/connect</a> (two minutes: a DNS-over-HTTPS setting and one certificate).</li>
<li><b>TronBrowser</b> reaches Moshpit names out of the box.</li>
<li><b>The CLI and MCP server</b> find it by themselves, too.</li>
</ol>
<p class="muted small">Running your own copy? Point the apps at it with <code>ANCESTRY_URL=https://your.host</code>. This one is ${esc(site)}.</p>`,
  )
}
