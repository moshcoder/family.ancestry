/**
 * Every page, server-rendered. Nothing here needs JavaScript: forms post, links
 * link. public/app.js adds the passkey ceremony and a few conveniences on top.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fullName, lifespan, type Descendant, type Event, type Family, type Media, type Person, type Role, type Source, type Tree, type User, canEdit } from './db.js'

export const VERSION = '0.1.0'

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

export type Ctx = { user: User | null; csrf?: string; flash?: string | null; error?: string | null }

const csrfField = (ctx: Ctx) => (ctx.csrf ? `<input type="hidden" name="_csrf" value="${esc(ctx.csrf)}">` : '')

export function layout(ctx: Ctx, title: string, body: string, opts: { crumbs?: [string, string][]; wide?: boolean } = {}): string {
  const crumbs = opts.crumbs?.length ? `<nav class="crumbs">${opts.crumbs.map(([href, label]) => (href ? `<a href="${esc(href)}">${esc(label)}</a>` : `<span>${esc(label)}</span>`)).join('<span class="sep">/</span>')}</nav>` : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}${title === 'family.ancestry' ? '' : ' · family.ancestry'}</title>
<meta name="description" content="Private family trees for your family: GEDCOM import and export, pedigree charts, photos, sources, invites. Open source.">
<meta name="theme-color" content="#2f5d43">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="${asset('/style.css')}">
<script src="${asset('/app.js')}" defer></script>
</head>
<body>
<header class="top">
  <a class="brand" href="/">${leaf()}<span>family<b>.ancestry</b></span></a>
  <nav>${ctx.user ? `<a href="/trees">Trees</a><a href="/settings">${esc(ctx.user.name ?? ctx.user.email)}</a>` : '<a href="/signin">Sign in</a>'}</nav>
</header>
<main class="${opts.wide ? 'wide' : ''}">
${crumbs}
${ctx.flash ? `<p class="flash">${esc(ctx.flash)}</p>` : ''}${ctx.error ? `<p class="flash error">${esc(ctx.error)}</p>` : ''}
${body}
</main>
<footer class="foot">
  <span>family.ancestry ${VERSION} · open source (MIT) · <a href="https://github.com/moshcoder/family.ancestry">code</a> · <a href="/about">about</a> · <a href="/connect">reach it from anywhere</a></span>
  <span>A <a href="https://pit.world">Moshpit</a> name. Your tree is private to the people you invite.</span>
</footer>
</body>
</html>`
}

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
  <div><h3>Invite the family</h3><p>Editors add and fix; viewers just look. Links expire, roles can change.</p></div>
  <div><h3>Everywhere you are</h3><p>Install it as an app, or use the desktop app, the <code>ancestry</code> CLI, the terminal UI, or let your AI assistant read it over MCP.</p></div>
</section>`,
  )
}

export function signInForm(ctx: Ctx, next: string | null = null): string {
  return `<form class="signin" method="post" action="/auth/link">
  ${csrfField(ctx)}
  ${next ? `<input type="hidden" name="next" value="${esc(next)}">` : ''}
  <label for="email">Email</label>
  <div class="row"><input id="email" name="email" type="email" autocomplete="email webauthn" required placeholder="you@example.com"><button>Email me a link</button></div>
  <p class="muted small">No password. New here? The same link makes your account. <button type="button" class="link" data-passkey-signin hidden>Sign in with a passkey</button></p>
</form>`
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

export function treePage(ctx: Ctx, tree: Tree, role: Role, data: { stats: Record<string, number>; home: Person | null; people: Person[]; surnames: { surname: string; n: number }[]; query: string }): string {
  const edit = canEdit(role)
  const list = data.people.length
    ? `<table class="people"><thead><tr><th>Name</th><th>Born</th><th>Died</th></tr></thead><tbody>${data.people
        .map((p) => `<tr><td>${personLink(tree.id, p)}</td><td>${esc([p.birth_date, p.birth_place].filter(Boolean).join(', '))}</td><td>${esc([p.death_date, p.death_place].filter(Boolean).join(', '))}</td></tr>`)
        .join('')}</tbody></table>`
    : `<p class="empty">${data.query ? 'Nobody matches that.' : 'This tree is empty.'}</p>`
  return layout(
    ctx,
    tree.name,
    `<div class="titlebar"><div><h1>${esc(tree.name)}</h1>${tree.description ? `<p class="muted">${esc(tree.description)}</p>` : ''}</div>
<div class="actions">${data.home ? `<a class="btn" href="/t/${tree.id}/pedigree/${data.home.id}">Pedigree</a><a class="btn" href="/t/${tree.id}/descendants/${data.home.id}">Descendants</a>` : ''}<a class="btn" href="/t/${tree.id}/relate">How are we related?</a><a class="btn" href="/t/${tree.id}/sources">Sources</a><a class="btn" href="/t/${tree.id}/export.ged">Export GEDCOM</a>${role === 'owner' ? `<a class="btn" href="/t/${tree.id}/members">Share</a>` : `<a class="btn" href="/t/${tree.id}/members">Members</a>`}</div></div>
<p class="stats">${Object.entries(data.stats).map(([k, v]) => `<span><b>${v}</b> ${k}</span>`).join('')}</p>
${data.home ? `<p>Home person: ${personLink(tree.id, data.home)}</p>` : ''}
<form class="search" method="get" action="/t/${tree.id}"><input name="q" value="${esc(data.query)}" placeholder="Search names, places, years" aria-label="Search people"><button>Search</button></form>
${data.surnames.length && !data.query ? `<p class="surnames">${data.surnames.slice(0, 40).map((s) => `<a href="/t/${tree.id}?q=${encodeURIComponent(s.surname)}">${esc(s.surname)} <span>${s.n}</span></a>`).join('')}</p>` : ''}
${list}
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

/** "Add a relative": a new person, or someone already in the tree (picked by name from a datalist). */
function relativeForm(ctx: Ctx, tree: Tree, person: Person, kind: 'parent' | 'partner' | 'child', families: { family: Family; partner: Person | null }[]): string {
  const titles = { parent: 'Add a parent', partner: 'Add a partner', child: 'Add a child' }
  const famSelect =
    kind === 'child' && families.length
      ? `<label>With<select name="family_id">${families.map((f) => `<option value="${f.family.id}">${f.partner ? esc(fullName(f.partner)) : 'unknown partner'}</option>`).join('')}<option value="">no partner / unknown</option></select></label>`
      : ''
  const relation = kind === 'partner' ? '' : `<label>Relationship<select name="relation"><option value="birth">birth</option><option value="adopted">adopted</option><option value="step">step</option><option value="foster">foster</option></select></label>`
  const kindSelect = kind === 'partner' ? `<label>As<select name="kind"><option value="married">married</option><option value="partners">partners</option><option value="divorced">divorced</option></select></label>` : ''
  return `<details class="panel"><summary>${titles[kind]}</summary>
<form method="post" action="/t/${tree.id}/p/${person.id}/relative" class="pform">${csrfField(ctx)}<input type="hidden" name="as" value="${kind}">
  <p class="muted small">Someone already in the tree:</p>
  <div class="row"><input name="existing" list="people-${tree.id}" placeholder="Start typing a name" autocomplete="off"> </div>
  <p class="muted small">Or someone new:</p>
  <div class="grid2"><label>Given names<input name="given" maxlength="200"></label><label>Surname<input name="surname" maxlength="200" value="${kind === 'child' || (kind === 'parent' && person.sex !== 'F') ? esc(person.surname) : ''}"></label></div>
  <div class="grid3"><label>Sex<select name="sex"><option value="U">Unknown</option><option value="F">Female</option><option value="M">Male</option><option value="X">Other</option></select></label><label>Born<input name="birth_date" maxlength="200"></label><label class="check"><input type="checkbox" name="living" value="1"> Living</label></div>
  <div class="grid3">${famSelect}${relation}${kindSelect}</div>
  <button>${titles[kind]}</button>
</form></details>`
}

export type PersonView = {
  person: Person
  parents: { family: Family; relation: string; parents: Person[]; siblings: Person[] }[]
  unions: { family: Family; partner: Person | null; children: Person[] }[]
  events: Event[]
  citations: (Source & { page: string | null })[]
  media: Media[]
  sources: Source[]
  everyone: Person[]
}

export function personPage(ctx: Ctx, tree: Tree, role: Role, v: PersonView): string {
  const p = v.person
  const edit = canEdit(role)
  const photo = p.photo_id ? `<img class="portrait" src="/t/${tree.id}/media/${p.photo_id}" alt="${esc(fullName(p))}">` : `<div class="portrait none sex-${p.sex}">${esc((p.given[0] ?? '') + (p.surname[0] ?? '') || '?')}</div>`
  const facts = [
    ['Born', [p.birth_date, p.birth_place].filter(Boolean).join(' · ')],
    ['Died', [p.death_date, p.death_place].filter(Boolean).join(' · ') || (p.living ? 'Living' : '')],
  ].filter(([, val]) => val)
  const timeline = [
    ...(p.birth_date || p.birth_place ? [{ type: 'Birth', date: p.birth_date, place: p.birth_place, description: null, id: '' }] : []),
    ...v.unions.filter((u) => u.family.start_date || u.family.start_place).map((u) => ({ type: u.family.kind === 'married' ? 'Marriage' : 'Partnership', date: u.family.start_date, place: u.family.start_place, description: u.partner ? `with ${fullName(u.partner)}` : null, id: '' })),
    ...v.events,
    ...(p.death_date || p.death_place ? [{ type: 'Death', date: p.death_date, place: p.death_place, description: null, id: '' }] : []),
  ]
  const datalist = `<datalist id="people-${tree.id}">${v.everyone.filter((o) => o.id !== p.id).map((o) => `<option value="${esc(`${fullName(o)}${lifespan(o) ? ` (${lifespan(o)})` : ''} #${o.id}`)}"></option>`).join('')}</datalist>`
  return layout(
    ctx,
    fullName(p),
    `<div class="person-head">${photo}<div><h1>${esc(fullName(p))}</h1><p class="muted">${esc(lifespan(p))}${p.sex !== 'U' ? ` · ${{ M: 'male', F: 'female', X: 'other' }[p.sex] ?? ''}` : ''}</p>
${facts.map(([k, val]) => `<p><b>${k}</b> ${esc(val)}</p>`).join('')}
<div class="actions"><a class="btn" href="/t/${tree.id}/pedigree/${p.id}">Pedigree</a><a class="btn" href="/t/${tree.id}/descendants/${p.id}">Descendants</a><a class="btn" href="/t/${tree.id}/relate?a=${tree.home_person_id ?? ''}&b=${p.id}">Related how?</a>${edit && tree.home_person_id !== p.id ? `<form method="post" action="/t/${tree.id}/home" class="inline">${csrfField(ctx)}<input type="hidden" name="person_id" value="${p.id}"><button class="btn">Make home person</button></form>` : ''}</div></div></div>

<div class="cols">
<section><h2>Parents</h2>${
      v.parents.length
        ? v.parents.map((f) => `<div class="line">${f.parents.map((pp) => personLink(tree.id, pp)).join(' &amp; ') || '<span class="muted">unknown</span>'}${f.relation !== 'birth' ? ` <span class="tag">${esc(f.relation)}</span>` : ''}${edit ? ` <form method="post" action="/t/${tree.id}/p/${p.id}/unlink" class="inline">${csrfField(ctx)}<input type="hidden" name="family_id" value="${f.family.id}"><button class="x" title="Remove from this family">×</button></form>` : ''}</div>${f.siblings.length ? `<p class="small"><b>Siblings</b> ${f.siblings.map((s) => personLink(tree.id, s)).join(', ')}</p>` : ''}`).join('')
        : '<p class="muted">None recorded.</p>'
    }</section>
<section><h2>Partners and children</h2>${
      v.unions.length
        ? v.unions.map((u) => `<div class="union"><div class="line">${u.partner ? personLink(tree.id, u.partner) : '<span class="muted">unknown partner</span>'} <span class="tag">${esc(u.family.kind)}${u.family.start_date ? ` ${esc(u.family.start_date)}` : ''}${u.family.end_date ? ` · ended ${esc(u.family.end_date)}` : ''}</span></div>${u.children.length ? `<ul>${u.children.map((c) => `<li>${personLink(tree.id, c)}</li>`).join('')}</ul>` : ''}${edit ? `<details class="mini"><summary>edit</summary><form method="post" action="/t/${tree.id}/f/${u.family.id}" class="pform">${csrfField(ctx)}<div class="grid3"><label>Kind<input name="kind" value="${esc(u.family.kind)}"></label><label>Date<input name="start_date" value="${esc(u.family.start_date ?? '')}"></label><label>Place<input name="start_place" value="${esc(u.family.start_place ?? '')}"></label></div><label>Ended<input name="end_date" value="${esc(u.family.end_date ?? '')}"></label><button>Save</button></form><form method="post" action="/t/${tree.id}/f/${u.family.id}/delete" data-confirm="Remove this partnership? The people stay in the tree.">${csrfField(ctx)}<button class="danger small">Remove partnership</button></form></details>` : ''}</div>`).join('')
        : '<p class="muted">None recorded.</p>'
    }</section>
</div>
${edit ? `${datalist}<div class="cols3">${relativeForm(ctx, tree, p, 'parent', [])}${relativeForm(ctx, tree, p, 'partner', [])}${relativeForm(ctx, tree, p, 'child', v.unions)}</div>` : ''}

<section><h2>Timeline</h2>${
      timeline.length
        ? `<ol class="timeline">${timeline.map((e) => `<li><span class="when">${esc(e.date ?? '')}</span><b>${esc(e.type)}</b>${e.place ? ` · ${esc(e.place)}` : ''}${e.description ? `<br><span class="muted">${esc(e.description)}</span>` : ''}${edit && e.id ? ` <form method="post" action="/t/${tree.id}/e/${e.id}/delete" class="inline">${csrfField(ctx)}<input type="hidden" name="person_id" value="${p.id}"><button class="x" title="Delete event">×</button></form>` : ''}</li>`).join('')}</ol>`
        : '<p class="muted">Nothing yet.</p>'
    }
${edit ? `<details class="panel"><summary>Add an event</summary><form method="post" action="/t/${tree.id}/p/${p.id}/events" class="pform">${csrfField(ctx)}<div class="grid3"><label>What<input name="type" list="event-types" required placeholder="Residence, Occupation, Census…"></label><label>When<input name="date"></label><label>Where<input name="place"></label></div><label>Details<textarea name="description" rows="2"></textarea></label><button>Add event</button></form>
<datalist id="event-types">${['Residence', 'Occupation', 'Education', 'Military', 'Immigration', 'Emigration', 'Naturalization', 'Census', 'Baptism', 'Christening', 'Burial', 'Religion', 'Retirement'].map((t) => `<option value="${t}">`).join('')}</datalist></details>` : ''}
</section>

${p.notes ? `<section><h2>Notes and stories</h2><div class="notes">${esc(p.notes).replace(/\n/g, '<br>')}</div></section>` : ''}

<section><h2>Photos</h2>${v.media.length ? `<div class="photos">${v.media.map((m) => `<figure><a href="/t/${tree.id}/media/${m.id}"><img loading="lazy" src="/t/${tree.id}/media/${m.id}" alt="${esc(m.caption ?? m.filename)}"></a><figcaption>${esc(m.caption ?? '')}${edit ? ` <form method="post" action="/t/${tree.id}/media/${m.id}/primary" class="inline">${csrfField(ctx)}<button class="link small">${p.photo_id === m.id ? 'portrait' : 'use as portrait'}</button></form><form method="post" action="/t/${tree.id}/media/${m.id}/delete" class="inline" data-confirm="Delete this photo?">${csrfField(ctx)}<button class="x">×</button></form>` : ''}</figcaption></figure>`).join('')}</div>` : '<p class="muted">No photos yet.</p>'}
${edit ? `<form method="post" action="/t/${tree.id}/p/${p.id}/media" enctype="multipart/form-data" class="row">${csrfField(ctx)}<input type="file" name="file" accept="image/*" required><input name="caption" placeholder="Caption" maxlength="1000"><button>Upload</button></form>` : ''}</section>

<section><h2>Sources</h2>${v.citations.length ? `<ul>${v.citations.map((s) => `<li>${s.url ? `<a href="${esc(s.url)}" rel="noopener noreferrer" target="_blank">${esc(s.title)}</a>` : esc(s.title)}${s.page ? ` · ${esc(s.page)}` : ''}${s.author ? ` <span class="muted">${esc(s.author)}</span>` : ''}${edit ? ` <form method="post" action="/t/${tree.id}/p/${p.id}/uncite" class="inline">${csrfField(ctx)}<input type="hidden" name="source_id" value="${s.id}"><button class="x">×</button></form>` : ''}</li>`).join('')}</ul>` : '<p class="muted">No sources cited.</p>'}
${edit ? `<details class="panel"><summary>Cite a source</summary><form method="post" action="/t/${tree.id}/p/${p.id}/cite" class="pform">${csrfField(ctx)}${v.sources.length ? `<label>Existing source<select name="source_id"><option value="">— new source below —</option>${v.sources.map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join('')}</select></label>` : ''}<div class="grid2"><label>New source title<input name="title" placeholder="1910 US Census"></label><label>Link<input name="url" type="url" placeholder="https://"></label></div><label>Page or detail<input name="page" placeholder="Sheet 4A, line 12"></label><button>Cite</button></form></details>` : ''}</section>

${edit ? `<details class="panel"><summary>Edit ${esc(fullName(p))}</summary>${personForm(ctx, `/t/${tree.id}/p/${p.id}`, p, 'Save')}
<form method="post" action="/t/${tree.id}/p/${p.id}/delete" data-confirm="Delete ${esc(fullName(p))}? Their relationships go too.">${csrfField(ctx)}<button class="danger">Delete this person</button></form></details>` : ''}`,
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

export function membersPage(ctx: Ctx, tree: Tree, role: Role, members: { user_id: string; email: string; name: string | null; role: Role }[], inviteUrl: string | null): string {
  const owner = role === 'owner'
  return layout(
    ctx,
    'Members',
    `<h1>Who can see ${esc(tree.name)}</h1>
<table class="people"><thead><tr><th>Member</th><th>Role</th><th></th></tr></thead><tbody>${members
      .map(
        (m) => `<tr><td>${esc(m.name ?? m.email)}${m.name ? ` <span class="muted small">${esc(m.email)}</span>` : ''}</td><td>${
          owner && m.role !== 'owner'
            ? `<form method="post" action="/t/${tree.id}/members/${m.user_id}" class="inline">${csrfField(ctx)}<select name="role" data-autosubmit>${['editor', 'viewer'].map((r) => `<option${r === m.role ? ' selected' : ''}>${r}</option>`).join('')}</select><noscript><button>Save</button></noscript></form>`
            : m.role
        }</td><td>${owner && m.role !== 'owner' ? `<form method="post" action="/t/${tree.id}/members/${m.user_id}/remove" class="inline" data-confirm="Remove ${esc(m.email)}?">${csrfField(ctx)}<button class="x">×</button></form>` : ''}</td></tr>`,
      )
      .join('')}</tbody></table>
${
  owner
    ? `<form method="post" action="/t/${tree.id}/invites" class="panel pform">${csrfField(ctx)}<h2>Invite family</h2><p class="muted small">Editors can add and change people. Viewers can only look. A link works once and expires in 14 days.</p>
<div class="grid3"><label>Role<select name="role"><option>editor</option><option selected>viewer</option></select></label><label>Email them (optional)<input name="email" type="email" placeholder="cousin@example.com"></label></div><button>Make invite link</button></form>
${inviteUrl ? `<div class="panel"><p>Send this link. It works once.</p><p class="copy"><input readonly value="${esc(inviteUrl)}" data-copy><button type="button" data-copy-btn>Copy</button></p></div>` : ''}`
    : ''
}`,
    { crumbs: [['/trees', 'Trees'], [`/t/${tree.id}`, tree.name], ['', 'Members']] },
  )
}

export function invitePage(ctx: Ctx, tree: Tree, role: string, token: string): string {
  return layout(
    ctx,
    `Join ${tree.name}`,
    `<h1>You're invited to ${esc(tree.name)}</h1><p>As ${role === 'editor' ? 'an editor: you can add and change people' : 'a viewer: you can look at everything'}.</p>
${ctx.user ? `<form method="post" action="/invite/${esc(token)}">${csrfField(ctx)}<button>Join as ${esc(ctx.user.email)}</button></form>` : `<p>Sign in or sign up first; you'll come straight back here.</p>${signInForm(ctx, `/invite/${token}`)}`}`,
  )
}

export function settingsPage(ctx: Ctx, data: { passkeys: { id: string; label: string | null; created_at: number; last_used_at: number | null }[]; tokens: { id: string; label: string | null; created_at: number; last_used_at: number | null }[]; newToken?: string | null }): string {
  const when = (t: number | null) => (t ? new Date(t).toISOString().slice(0, 10) : 'never')
  return layout(
    ctx,
    'Settings',
    `<h1>Settings</h1>
<form method="post" action="/settings/name" class="panel pform">${csrfField(ctx)}<h2>Your name</h2><label>Shown to other members of your trees<input name="name" value="${esc(ctx.user?.name ?? '')}" maxlength="120"></label><p class="muted small">Signed in as ${esc(ctx.user?.email)}</p><button>Save</button></form>
<section class="panel"><h2>Passkeys</h2><p class="muted small">Sign in with your fingerprint, face or device PIN instead of waiting for an email.</p>
${data.passkeys.length ? `<ul>${data.passkeys.map((k) => `<li>${esc(k.label ?? 'Passkey')} <span class="muted small">added ${when(k.created_at)}, last used ${when(k.last_used_at)}</span> <form method="post" action="/settings/passkeys/${encodeURIComponent(k.id)}/delete" class="inline">${csrfField(ctx)}<button class="x">×</button></form></li>`).join('')}</ul>` : ''}
<button type="button" data-passkey-register>Add a passkey</button> <span class="muted small" data-passkey-status></span></section>
<section class="panel"><h2>Apps and tokens</h2><p class="muted small">The <code>ancestry</code> CLI, the terminal app, the desktop app and MCP clients sign in with a token. <code>ancestry login</code> makes one for you.</p>
${data.newToken ? `<p class="flash">New token (shown once): <code>${esc(data.newToken)}</code></p>` : ''}
${data.tokens.length ? `<ul>${data.tokens.map((t) => `<li>${esc(t.label ?? 'token')} <span class="muted small">made ${when(t.created_at)}, last used ${when(t.last_used_at)}</span> <form method="post" action="/settings/tokens/${t.id}/delete" class="inline">${csrfField(ctx)}<button class="x">×</button></form></li>`).join('')}</ul>` : ''}
<form method="post" action="/settings/tokens" class="row">${csrfField(ctx)}<input name="label" placeholder="What is it for?" maxlength="80"><button>Make a token</button></form></section>
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
