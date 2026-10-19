/**
 * Network and Inbox pages. Same rules as html.ts: server-rendered, forms post,
 * nothing needs JavaScript.
 */
import { adBanner, csrfField, esc, layout, type Ctx } from './html.js'
import { fullName, lifespan, type Person, type Tree, type User } from './db.js'
import { CIRCLES, contactName, formatAddresses, formatLabeled, type Circle, type Contact, type Message, type Recommendation, type Thread } from './network.js'
import { readContact } from './contact.js'

export const ADDONS = [
  {
    id: 'network',
    name: 'Network',
    summary: 'Family, friends, neighbors and business contacts with every detail you keep, a private inbox between people who know each other, and recommendations passed hand to hand.',
    href: '/network',
  },
]

const CIRCLE_LABEL: Record<Circle, string> = { family: 'Family', friends: 'Friends', neighbors: 'Neighbors', business: 'Business' }
const who = (u: Pick<User, 'name' | 'email'>) => u.name ?? u.email
const when = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ')

export function addonsPanel(): string {
  return `<section class="panel"><h2>Add-ons</h2>${ADDONS.map((a) => `<p><a href="${a.href}"><b>${esc(a.name)}</b></a> <span class="tag">included free</span><br><span class="muted small">${esc(a.summary)}</span></p>`).join('')}
<p class="muted small">Every add-on here is free with your account. Anything we ever charge for is covered by a <a href="https://profullstack.com/plans" rel="noopener">Profullstack Power Key</a>: one key, every service, for life.</p></section>`
}

const principles = `<p class="muted small">Your network is private to you. Nobody can browse it, there are no public profiles, no follower counts and no "people you may know". You can message people who said yes to connecting, or who share a tree with you, one at a time.</p>`

export function networkPage(ctx: Ctx, data: { contacts: Contact[]; circle: Circle | null; q: string; counts: Record<Circle, number> }): string {
  const total = CIRCLES.reduce((n, c) => n + data.counts[c], 0)
  const tab = (circle: Circle | null, label: string, n: number) => `<a class="btn${data.circle === circle ? ' on' : ''}" href="/network${circle ? `?circle=${circle}` : ''}">${label} <span class="muted">${n}</span></a>`
  const list = data.contacts.length
    ? `<table class="people"><thead><tr><th>Name</th><th>How you know them</th><th>Reach</th></tr></thead><tbody>${data.contacts
        .map(
          (c) =>
            `<tr><td><a href="/network/c/${c.id}">${esc(contactName(c))}</a>${c.linked_user_id ? ' <span class="tag">connected</span>' : ''}</td><td>${esc([CIRCLE_LABEL[c.circle], c.relationship, [c.title, c.company].filter(Boolean).join(', ')].filter(Boolean).join(' · '))}</td><td class="small">${esc([c.emails[0]?.value, c.phones[0]?.value].filter(Boolean).join(' · '))}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : `<p class="empty">${data.q || data.circle ? 'Nobody matches that.' : 'Nobody here yet. Add the people you actually know, or import your phone\'s contacts as a .vcf file.'}</p>`
  return layout(
    ctx,
    'Network',
    `<div class="titlebar"><div><h1>Your network</h1><p class="muted">The people in your life: family, friends, neighbors and the people you work with.</p></div>
<div class="actions"><a class="btn" href="/local">Local recommendations</a><a class="btn" href="/inbox">Inbox</a><a class="btn" href="/network/export.vcf">Export .vcf</a></div></div>
<p class="actions">${tab(null, 'Everyone', total)}${CIRCLES.map((c) => tab(c, CIRCLE_LABEL[c], data.counts[c])).join('')}</p>
<form class="search" method="get" action="/network">${data.circle ? `<input type="hidden" name="circle" value="${data.circle}">` : ''}<input name="q" value="${esc(data.q)}" placeholder="Search names, emails, companies, places" aria-label="Search contacts"><button>Search</button></form>
${list}
${adBanner()}
<details class="panel"${total ? '' : ' open'}><summary>Add a friend</summary>${contactForm(ctx, '/network/contacts', null, 'Add to my network', data.circle ?? 'friends', { connect: true })}</details>
<details class="panel"><summary>Import contacts</summary><form method="post" action="/network/import" enctype="multipart/form-data" class="pform">${csrfField(ctx)}<p class="muted small">A .vcf file from your phone, Google Contacts, Outlook or Apple Contacts. People already here (same email) are skipped.</p><div class="grid2"><label>File<input type="file" name="file" accept=".vcf,text/vcard,text/x-vcard" required></label><label>Put them in<select name="circle">${CIRCLES.map((c) => `<option value="${c}">${CIRCLE_LABEL[c]}</option>`).join('')}</select></label></div><button>Import</button></form></details>
${principles}`,
    { crumbs: [['', 'Network']], ad: false },
  )
}

export function contactForm(ctx: Ctx, action: string, c: Contact | null, label: string, circle: Circle = 'family', opts: { connect?: boolean } = {}): string {
  const v = (k: keyof Contact) => esc((c?.[k] as string | null) ?? '')
  const current = c?.circle ?? circle
  return `<form method="post" action="${esc(action)}" class="pform">${csrfField(ctx)}
  <div class="grid3"><label>Name<input name="name" value="${v('name')}" maxlength="200" required></label><label>Goes by<input name="nickname" value="${v('nickname')}" maxlength="200"></label><label>Circle<select name="circle">${CIRCLES.map((x) => `<option value="${x}"${x === current ? ' selected' : ''}>${CIRCLE_LABEL[x]}</option>`).join('')}</select></label></div>
  <div class="grid3"><label>How you know them<input name="relationship" value="${v('relationship')}" maxlength="200" placeholder="cousin, next door, our accountant"></label><label>Company<input name="company" value="${v('company')}" maxlength="200"></label><label>Title<input name="title" value="${v('title')}" maxlength="200"></label></div>
  <div class="grid2"><label>Emails <span class="muted small">one per line, "work: a@b.com"</span><textarea name="emails" rows="2">${esc(formatLabeled(c?.emails ?? []))}</textarea></label><label>Phones <span class="muted small">one per line, "cell: 555 0100"</span><textarea name="phones" rows="2">${esc(formatLabeled(c?.phones ?? []))}</textarea></label></div>
  <label>Addresses <span class="muted small">a blank line between addresses; "home:" before the first line labels it</span><textarea name="addresses" rows="3">${esc(formatAddresses(c?.addresses ?? []))}</textarea></label>
  <div class="grid3"><label>Birthday<input name="birthday" value="${v('birthday')}" maxlength="200" placeholder="14 MAY 1958"></label><label>Anniversary<input name="anniversary" value="${v('anniversary')}" maxlength="200"></label><label>Links <span class="muted small">one per line</span><textarea name="links" rows="1">${esc(formatLabeled(c?.links ?? []))}</textarea></label></div>
  <label>Notes<textarea name="notes" rows="3" maxlength="20000">${v('notes')}</textarea></label>
  ${opts.connect ? connectFields('note_to_them') : ''}
  <button>${esc(label)}</button></form>`
}

export function contactPage(ctx: Ctx, c: Contact, data: { trees: Tree[]; person: { tree: Tree; person: Person } | null; linked: User | null; canMessage: boolean; blocked: boolean; reachable: User[] }): string {
  const rows = [
    ...c.emails.map((e) => [e.label ?? 'email', `<a href="mailto:${esc(e.value)}">${esc(e.value)}</a>`]),
    ...c.phones.map((p) => [p.label ?? 'phone', `<a href="tel:${esc(p.value.replace(/[^\d+]/g, ''))}">${esc(p.value)}</a>`]),
    ...c.addresses.map((a) => [a.label ?? 'address', esc(a.lines).replace(/\n/g, '<br>')]),
    ...c.links.map((l) => [l.label ?? 'link', `<a href="${esc(l.value)}" rel="noopener noreferrer" target="_blank">${esc(l.value.replace(/^https?:\/\//, ''))}</a>`]),
    ...(c.birthday ? [['birthday', esc(c.birthday)]] : []),
    ...(c.anniversary ? [['anniversary', esc(c.anniversary)]] : []),
  ]
  const email = c.emails[0]?.value
  const owned = data.trees
  return layout(
    ctx,
    contactName(c),
    `<div class="titlebar"><div><h1>${esc(contactName(c))}${c.nickname ? ` <span class="muted">"${esc(c.nickname)}"</span>` : ''}</h1>
<p class="muted">${esc([CIRCLE_LABEL[c.circle], c.relationship, [c.title, c.company].filter(Boolean).join(' at ')].filter(Boolean).join(' · '))}</p></div>
<div class="actions">${data.canMessage && c.linked_user_id ? `<a class="btn" href="/inbox/${c.linked_user_id}">Message</a>` : ''}${data.person ? `<a class="btn" href="/t/${data.person.tree.id}/p/${data.person.person.id}">In ${esc(data.person.tree.name)}</a>` : ''}</div></div>
${rows.length ? `<table class="facts">${rows.map(([k, val]) => `<tr><th>${esc(k)}</th><td>${val}</td></tr>`).join('')}</table>` : '<p class="muted">No details yet.</p>'}
${c.notes ? `<div class="notes">${esc(c.notes).replace(/\n/g, '<br>')}</div>` : ''}
${
  data.linked
    ? `<p class="small">Connected as <b>${esc(who(data.linked))}</b>.${data.blocked ? ' You blocked them.' : ''}</p>`
    : email
      ? `<form method="post" action="/network/c/${c.id}/connect" class="panel pform">${csrfField(ctx)}<h2>Connect</h2><p class="muted small">We email ${esc(email)} once, with your name and a link. If they say yes you can message each other here. If not, nothing happens.</p><label>A line from you (optional)<input name="note" maxlength="1000" placeholder="It's Tony, finally got us all on here"></label><button>Ask to connect</button></form>`
      : '<p class="muted small">Add an email to connect with them here.</p>'
}
${
  owned.length && email
    ? `<form method="post" action="/network/c/${c.id}/invite" class="panel pform">${csrfField(ctx)}<h2>Invite to a family tree</h2><div class="grid3"><label>Tree<select name="tree_id">${owned.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label><label>Role${roleSelect(['viewer', 'editor', 'admin'], '')}</label></div><button>Email an invite</button></form>`
    : ''
}
${recommendForm(ctx, c, data.reachable.filter((u) => u.id !== c.linked_user_id))}
<details class="panel"><summary>Edit</summary>${contactForm(ctx, `/network/c/${c.id}`, c, 'Save')}
<form method="post" action="/network/c/${c.id}/delete" data-confirm="Remove ${esc(contactName(c))} from your network?">${csrfField(ctx)}<button class="danger">Remove from my network</button></form></details>`,
    { crumbs: [['/network', 'Network'], ['', contactName(c)]] },
  )
}

/** Pass this contact on to someone you know. Only the card travels: never your notes or how you know them. */
function recommendForm(ctx: Ctx, c: Contact, to: User[]): string {
  if (!to.length) return ''
  return `<details class="panel"><summary>Recommend ${esc(contactName(c))}</summary><form method="post" action="/network/c/${c.id}/recommend" class="pform">${csrfField(ctx)}
<p class="muted small">Send their name, phones, emails, addresses and links to someone you know. Your notes and "how you know them" stay with you.</p>
<div class="grid2"><label>To<select name="to">${to.map((u) => `<option value="${u.id}">${esc(who(u))}</option>`).join('')}</select></label><label>Why (optional)<input name="note" maxlength="1000" placeholder="Fixed our fence in a day, fair price"></label></div>
<button>Recommend</button></form></details>`
}

export function connectInvitePage(ctx: Ctx, from: User, note: string | null, token: string): string {
  return layout(
    ctx,
    `Connect with ${who(from)}`,
    `<h1>${esc(who(from))} wants to stay in touch</h1>
${note ? `<blockquote class="notes">${esc(note)}</blockquote>` : ''}
<p>If you say yes, you'll each be in the other's network and can message each other privately. Nothing is public, and you can block them any time.</p>
${ctx.user ? `<form method="post" action="/network/accept/${esc(token)}">${csrfField(ctx)}<button>Yes, connect as ${esc(ctx.user.email)}</button></form>` : `<p>Sign in or sign up first; you'll come straight back here.</p><form class="signin" method="post" action="/auth/link">${csrfField(ctx)}<input type="hidden" name="next" value="/network/accept/${esc(token)}"><label for="email">Email</label><div class="row"><input id="email" name="email" type="email" autocomplete="email" required><button>Email me a link</button></div></form>`}`,
  )
}

export function inboxPage(ctx: Ctx, threads: Thread[], reachable: User[], recs: { rec: Recommendation; from: User }[] = []): string {
  const me = ctx.user!
  const started = new Set(threads.map((t) => t.other.id))
  const fresh = reachable.filter((u) => !started.has(u.id))
  return layout(
    ctx,
    'Inbox',
    `<h1>Inbox</h1>
${recs.length ? `<section class="panel"><h2>Recommended to you</h2><ul class="threads">${recs.map(({ rec, from }) => recItem(ctx, rec, from)).join('')}</ul></section>` : ''}
${
  threads.length
    ? `<ul class="threads">${threads.map((t) => `<li${t.unread ? ' class="unread"' : ''}><a href="/inbox/${t.other.id}"><b>${esc(who(t.other))}</b>${t.unread ? ` <span class="badge">${t.unread}</span>` : ''}<br><span class="muted small">${t.last.sender_id === me.id ? 'You: ' : ''}${esc(t.last.body.slice(0, 140))}</span></a><span class="muted small">${when(t.last.created_at)}</span></li>`).join('')}</ul>`
    : '<p class="empty">No messages yet.</p>'
}
${fresh.length ? `<section class="panel"><h2>Write to someone</h2><p class="muted small">People you're connected with or share a tree with.</p><p>${fresh.map((u) => `<a class="btn" href="/inbox/${u.id}">${esc(who(u))}</a>`).join(' ')}</p></section>` : ''}
${principles}`,
    { crumbs: [['', 'Inbox']] },
  )
}

function recItem(ctx: Ctx, rec: Recommendation, from: User): string {
  const c = rec.card
  const what = [CIRCLE_LABEL[c.circle], [c.title, c.company].filter(Boolean).join(', ')].filter(Boolean).join(' · ')
  const reach = [...c.phones.map((p) => p.value), ...c.emails.map((e) => e.value)].slice(0, 3).join(' · ')
  return `<li><div><b>${esc(contactName(c))}</b>${what ? ` <span class="muted small">${esc(what)}</span>` : ''}<br><span class="small">${esc(reach)}</span><br><span class="muted small">from ${esc(who(from))}${rec.note ? `: ${esc(rec.note)}` : ''}</span></div>
<div class="actions"><form method="post" action="/network/r/${rec.id}/save" class="inline">${csrfField(ctx)}<button>Save to my network</button></form><form method="post" action="/network/r/${rec.id}/dismiss" class="inline">${csrfField(ctx)}<button class="btn">Dismiss</button></form></div></li>`
}

export function threadPage(ctx: Ctx, other: User, messages: Message[], opts: { canMessage: boolean; blocked: boolean }): string {
  const me = ctx.user!
  return layout(
    ctx,
    who(other),
    `<div class="titlebar"><h1>${esc(who(other))}</h1><div class="actions"><form method="post" action="/inbox/${other.id}/${opts.blocked ? 'unblock' : 'block'}" class="inline"${opts.blocked ? '' : ` data-confirm="Block ${esc(who(other))}? Neither of you can message the other until you unblock."`}>${csrfField(ctx)}<button class="btn${opts.blocked ? '' : ' danger'}">${opts.blocked ? 'Unblock' : 'Block'}</button></form></div></div>
${messages.length ? `<ol class="messages">${messages.map((m) => `<li class="${m.sender_id === me.id ? 'mine' : 'theirs'}"><div>${esc(m.body).replace(/\n/g, '<br>')}</div><span class="muted small">${when(m.created_at)}</span></li>`).join('')}</ol>` : '<p class="muted">Say hello.</p>'}
${
  opts.canMessage
    ? `<form method="post" action="/inbox/${other.id}" class="pform compose">${csrfField(ctx)}<label>Message<textarea name="body" rows="3" maxlength="5000" required></textarea></label><button>Send</button></form>`
    : `<p class="muted small">${opts.blocked ? 'You blocked them.' : 'You can only message people you are connected with or share a tree with.'}</p>`
}`,
    { crumbs: [['/inbox', 'Inbox'], ['', who(other)]] },
  )
}

/** "Also email them to connect", for any form that adds someone with an email. */
const connectFields = (noteName: string) =>
  `<label class="check"><input type="checkbox" name="connect" value="1" checked> Email them to connect <span class="muted small">one email from you; if they say yes you can message each other here</span></label>
  <label>A line from you (optional)<input name="${noteName}" maxlength="1000" placeholder="It's Tony, finally got us all on here"></label>`

/**
 * On a person's page: add them to your own network, the way you add a friend. Once
 * they are in it, a button to their card instead. Private to you, like every contact.
 */
export function personNetworkBox(ctx: Ctx, tree: Tree, person: Person, contact: Contact | null): string {
  if (contact) return `<a class="btn" href="/network/c/${contact.id}">In my network · ${CIRCLE_LABEL[contact.circle]}</a>`
  const name = person.given || fullName(person)
  return `<details class="mini"><summary>Add ${esc(name)} to my network</summary><form method="post" action="/t/${tree.id}/p/${person.id}/network" class="pform">${csrfField(ctx)}
<div class="grid3"><label>Circle<select name="circle">${CIRCLES.map((x) => `<option value="${x}"${x === 'friends' ? ' selected' : ''}>${CIRCLE_LABEL[x]}</option>`).join('')}</select></label><label>Their email<input name="email" type="email" value="${esc(readContact(person.contact).emails[0]?.value ?? '')}" placeholder="${esc(name.toLowerCase().replace(/\W+/g, '') || 'them')}@example.com"></label><label>How you know them<input name="relationship" maxlength="200" placeholder="cousin, college roommate"></label></div>
${connectFields('note')}
<p class="muted small">Your network is private to you: ${esc(name)} sees nothing unless you ask to connect.</p><button>Add to my network</button></form></details>`
}

/** On your own page: bring a friend in. They land in your network and get one email asking to connect. */
export function inviteFriendBox(ctx: Ctx): string {
  return `<details class="panel"><summary>Invite a friend</summary><form method="post" action="/network/contacts" class="pform">${csrfField(ctx)}
<div class="grid3"><label>Name<input name="name" maxlength="200" required></label><label>Their email<input name="emails" type="email" required></label><label>Circle<select name="circle">${CIRCLES.map((x) => `<option value="${x}"${x === 'friends' ? ' selected' : ''}>${CIRCLE_LABEL[x]}</option>`).join('')}</select></label></div>
<input type="hidden" name="connect" value="1"><label>A line from you (optional)<input name="note_to_them" maxlength="1000" placeholder="Come see the family tree"></label>
<p class="muted small">One email from you with a link to connect. If they say yes you can message each other here. <a href="/network">Your network</a></p><button>Send invite</button></form></details>`
}

/** The quiet offer under a person's name: invite them to be themselves in the tree. */
export function profileInvite(ctx: Ctx, tree: Tree, person: Person, opts: { justAdded: boolean; roles: string[] }): string {
  const name = person.given || fullName(person)
  const form = `<form method="post" action="/t/${tree.id}/invites" class="pform">${csrfField(ctx)}<input type="hidden" name="person_id" value="${person.id}"><input type="hidden" name="back" value="person">
<div class="row"><input name="email" type="email" required placeholder="${esc(name.toLowerCase().replace(/\W+/g, '') || 'them')}@example.com" aria-label="Their email">${opts.roles.length > 1 ? roleSelect(opts.roles) : ''}<button>Send invite</button></div>
<p class="muted small">They get one email from you. If they join, this is their profile: they keep it up to date and are part of the family here. A viewer keeps their own profile; an editor can fill in their whole branch; an admin can also invite and manage the family.</p></form>`
  return opts.justAdded
    ? `<div class="panel invite-nudge"><p><b>Added ${esc(fullName(person))}${lifespan(person) ? ` (${esc(lifespan(person))})` : ''}.</b> Is ${esc(name)} around? Invite them to manage their own profile and join the family.</p>${form}</div>`
    : `<section class="panel invite-nudge"><h2>Invite ${esc(name)}</h2><p>Send ${esc(name)} an email to join the family and manage this profile${opts.roles.includes('editor') ? ', or make them an editor to fill in their branch' : ''}.</p>${form}</section>`
}

/** Role picker for an invite: viewer first (the safe default), each saying what it can do. */
export function roleSelect(roles: string[], attrs = ' aria-label="Role"'): string {
  const words: Record<string, string> = { viewer: 'viewer: sees the tree, keeps their own profile', editor: 'editor: adds and changes people (their branch)', admin: 'admin: also invites and manages the family' }
  return `<select name="role"${attrs}>${['viewer', 'editor', 'admin'].filter((r) => roles.includes(r)).map((r) => `<option value="${r}">${words[r]}</option>`).join('')}</select>`
}
