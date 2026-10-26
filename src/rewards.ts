/**
 * Credit codes and invites.
 *
 * A credit code (@profullstack/redeem-credits, unit `plan_days`) is days of the Family plan.
 * Days land on the person's balance, then go onto one of their families: the same tree row
 * the paid plan writes (`trees.plan_until`, read by `hasPlan`), so there is one plan, not two.
 *
 * Invites (@profullstack/affiliates) are scarce: three links per person, each works once.
 * When someone new signs up through one, both of them get INVITE_BONUS_DAYS plan days.
 * Affiliate links (?ref=) are open and only record who brought whom, first touch.
 */
import { Credits, sqliteStore } from '@profullstack/redeem-credits'
import { Affiliates, sqliteStore as affiliateStore } from '@profullstack/affiliates'
import type { Store, Tree, User } from './db.js'
import { hasPlan, isAdmin, type PlanConfig } from './plan.js'

export const PLAN_UNIT = 'plan_days'
/** Invite links each person can hand out. Scarce on purpose: an invite should mean something. */
export const INVITES_PER_PERSON = 3
/** Family plan days both people get when an invite brings someone new in. */
export const INVITE_BONUS_DAYS = 7

const WHY: Record<string, string> = {
  invalid: 'That code is not valid.',
  expired: 'That code has expired.',
  used_up: 'That code has been used.',
  already_redeemed: 'You already redeemed that code.',
  revoked: 'That code was withdrawn.',
}

export class RewardError extends Error {}

export type Applied = { tree: Tree; days: number; until: number }

export const day = (ms: number) => new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })

export class Rewards {
  readonly credits: Credits
  readonly affiliates: Affiliates

  constructor(
    private store: Store,
    private plan: PlanConfig,
  ) {
    this.credits = new Credits(sqliteStore(store.db as never))
    this.affiliates = new Affiliates(affiliateStore(store.db as never), { defaultQuota: INVITES_PER_PERSON })
  }

  /** Plan days waiting on this person's balance, not yet on a family. */
  days(userId: string): Promise<number> {
    return this.credits.balance(userId, PLAN_UNIT)
  }

  /** Families this person can put days on: any they belong to that is not on the plan for good. */
  targets(userId: string): Tree[] {
    return this.store
      .treesFor(userId)
      .map((t) => this.store.tree(t.id))
      .filter((t): t is Tree => Boolean(t && !t.plan_paid_at && !isAdmin(this.plan, this.store.user(t.owner_id))))
  }

  /** Move every waiting day onto a family. */
  async apply(user: User, treeId: string): Promise<Applied> {
    const tree = this.targets(user.id).find((t) => t.id === treeId)
    if (!tree) throw new RewardError(this.store.role(treeId, user.id) ? 'That family is on the Family plan for good already.' : 'Pick one of your families.')
    const days = await this.days(user.id)
    if (days <= 0) throw new RewardError('You have no plan days waiting.')
    const spent = await this.credits.spend(user.id, PLAN_UNIT, days, `tree ${tree.id}`)
    if (!spent.ok) throw new RewardError('Those days were just used. Reload and try again.')
    const until = this.store.extendPlan(tree.id, days)!
    return { tree: this.store.tree(tree.id)!, days, until }
  }

  /** With exactly one family to put them on, days go there by themselves. */
  async autoApply(user: User): Promise<Applied | null> {
    const targets = this.targets(user.id)
    if (targets.length !== 1 || (await this.days(user.id)) <= 0) return null
    return this.apply(user, targets[0]!.id).catch(() => null)
  }

  /** Redeem a credit code; the days go onto `treeId` when given, or onto the only family there is. */
  async redeem(user: User, code: string, treeId?: string | null): Promise<{ message: string; days: number; applied: Applied | null }> {
    const r = await this.credits.redeem(String(code ?? ''), user.id)
    if (!r.ok) throw new RewardError(WHY[r.reason] ?? 'That code did not work.')
    const g = r.grant
    const planDays = g.unit === PLAN_UNIT
    const what = planDays ? `${g.amount} Family plan day${g.amount === 1 ? '' : 's'}` : `${g.amount} ${g.unit}`
    const every = g.every === 'month' ? ` every month${g.months ? ` for ${g.months} months` : ''}` : ''
    const applied = !planDays ? null : treeId ? await this.apply(user, treeId).catch(() => null) : await this.autoApply(user)
    const where = applied ? ` ${applied.tree.name} is on the Family plan until ${day(applied.until)}.` : planDays ? ' Put them on one of your families in Settings.' : ''
    return { message: `Added ${what}${every}.${where}`, days: g.amount, applied }
  }

  /**
   * Someone new signed up through an invite: the invite is spent, and both they and
   * whoever invited them get plan days. False when the invite did not work.
   */
  async acceptInvite(code: string, user: User): Promise<{ ok: boolean; reason?: string; inviterId?: string }> {
    const r = await this.affiliates.redeemInvite(code, user.id)
    if (!r.ok) return { ok: false, reason: r.reason }
    const bonus = { unit: PLAN_UNIT, amount: INVITE_BONUS_DAYS } as const
    await this.credits.grant(user.id, bonus, `invited by ${r.inviterId}`)
    await this.credits.grant(r.inviterId, bonus, `invited ${user.id}`)
    const inviter = this.store.user(r.inviterId)
    if (inviter) await this.autoApply(inviter)
    return { ok: true, inviterId: r.inviterId }
  }

  /** What the plan says for one tree, for pages and the API. */
  status(tree: Tree, now = Date.now()): { active: boolean; forever: boolean; until: number | null } {
    const active = hasPlan(this.plan, this.store, tree, now)
    const forever = Boolean(tree.plan_paid_at) || isAdmin(this.plan, this.store.user(tree.owner_id))
    return { active, forever, until: !forever && tree.plan_until && tree.plan_until > now ? tree.plan_until : null }
  }
}
