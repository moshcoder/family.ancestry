/** Pages and panels for credit codes and invites (rewards.ts). */
import type { Tree } from './db.js'
import { csrfField, esc, layout, type Ctx } from './html.js'
import { day, INVITE_BONUS_DAYS } from './rewards.js'

const copy = (value: string) => `<p class="copy"><input readonly value="${esc(value)}" data-copy><button type="button" data-copy-btn>Copy</button></p>`
const treeSelect = (targets: Tree[], selected?: string) =>
  targets.length > 1 ? `<select name="tree" aria-label="Which family">${targets.map((t) => `<option value="${esc(t.id)}"${t.id === selected ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select>` : targets.length === 1 ? `<input type="hidden" name="tree" value="${esc(targets[0]!.id)}">` : ''

/** "Have a code?" plus any plan days still waiting. On a tree's plan page, `tree` pins where the days go. */
export function codePanel(ctx: Ctx, v: { days: number; targets: Tree[]; tree?: Tree | null; back: string }): string {
  const targets = v.tree ? v.targets.filter((t) => t.id === v.tree!.id) : v.targets
  const waiting =
    v.days > 0
      ? targets.length
        ? `<form method="post" action="/settings/plan-days" class="row">${csrfField(ctx)}<input type="hidden" name="back" value="${esc(v.back)}"><span>You have <b>${v.days}</b> Family plan day${v.days === 1 ? '' : 's'} waiting.</span>${treeSelect(targets, v.tree?.id)}<button>Put them on ${targets.length === 1 ? esc(targets[0]!.name) : 'this family'}</button></form>`
        : `<p>You have <b>${v.days}</b> Family plan day${v.days === 1 ? '' : 's'} waiting. Start a family tree and they go on it.</p>`
      : ''
  return `<section class="panel" id="code"><h2>Have a code?</h2>
<p class="muted small">A credit code is days of the Family plan (pets, and invite everyone) for one of your families.</p>
${waiting}
<form method="post" action="/settings/redeem" class="row">${csrfField(ctx)}<input type="hidden" name="back" value="${esc(v.back)}"><input name="code" required placeholder="CR-XXXX-XXXX-XXXX-XXXX" aria-label="Credit code" autocomplete="off" maxlength="64">${treeSelect(targets, v.tree?.id)}<button>Redeem</button></form>
<p class="small"><a href="/invites">Your invite links</a></p></section>`
}

export function invitedPage(ctx: Ctx): string {
  return layout(
    ctx,
    "You're invited",
    `<h1>You're invited to family.ancestry.</h1>
<p>Someone wants you here: private family trees for your family, with photos, stories, GEDCOM, and a feed only your family sees. No ads in your tree, nothing sold.</p>
<p>Make your account through this invite and you both get <b>${INVITE_BONUS_DAYS} days of the Family plan</b> (pets, and invite the whole family at once).</p>
${ctx.user ? '<p class="muted">You are already signed in, so this invite is for someone new. Pass it on.</p>' : '<p><a class="btn" href="/signup">Accept: make my account</a> <a href="/signin">I have an account</a></p>'}`,
    { noAd: true },
  )
}

export function invitesPage(
  ctx: Ctx,
  data: { quota: { total: number; used: number; left: number }; invites: { id: string; createdAt: number; expiresAt: number | null; usedBy: string | null; usedAt: number | null; note: string }[]; affiliate: string; link?: string; error?: string },
): string {
  return layout(
    ctx,
    'Invites',
    `<h1>Invites</h1>
${data.error ? `<p class="flash error">${esc(data.error)}</p>` : ''}
<p>You have <b>${data.quota.left}</b> of ${data.quota.total} invite links left. Each works once, for 30 days. When someone new makes an account through yours, you both get ${INVITE_BONUS_DAYS} days of the Family plan.</p>
${data.link ? `<p class="flash">Your new invite link, shown once:</p>${copy(data.link)}` : ''}
${data.quota.left > 0 ? `<form method="post" action="/invites" class="row">${csrfField(ctx)}<input name="note" maxlength="80" placeholder="Who is it for? (only you see this)" aria-label="Note"><button>Make an invite link</button></form>` : ''}
${data.invites.length ? `<ul>${data.invites.map((i) => `<li>${esc(i.note || 'invite')} <span class="muted small">${i.usedAt ? `used ${day(i.usedAt)}` : i.expiresAt && i.expiresAt < Date.now() ? 'expired' : `open, made ${day(i.createdAt)}`}</span></li>`).join('')}</ul>` : ''}
<section class="panel"><h2>Your link for everyone else</h2><p class="muted small">Share it anywhere. People who sign up through it are counted as yours.</p>${copy(data.affiliate)}</section>
<p class="muted small">To bring someone into one of your family trees, invite them from the tree's Members page instead.</p>`,
    { crumbs: [['/settings', 'Settings'], ['', 'Invites']], noAd: true },
  )
}

/** The plan page's line for days that run out. */
export const untilNote = (until: number | null) => (until ? `On plan days until ${day(until)}.` : '')
