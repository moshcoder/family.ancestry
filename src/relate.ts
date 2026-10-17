/**
 * Turn a path through the tree into the words a family uses: "grandmother",
 * "first cousin once removed", "brother-in-law".
 *
 * A blood relationship is a climb to a common ancestor and a descent from it:
 * `up` parent steps, then `down` child steps. Everything else in English kinship
 * is a function of those two numbers. A partner step at either end makes it an
 * in-law (or a spouse, when it is the only step).
 *
 * A parent or child step that is not by birth (adopted, step, foster) qualifies
 * the word: "adoptive mother", "stepson", "grandfather (by adoption)". Whether a
 * brother is a half-brother cannot be read off one path (and siblings whose parents
 * are unknown have no path), so describeRelation takes the kind from Store.siblings().
 */
import type { PathStep, Person, SiblingKind } from './db.js'

type Step = PathStep

const ordinal = (n: number) => {
  const words = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']
  return words[n] ?? `${n}th`
}
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : n === 3 ? 'three times' : `${n} times`)
const greats = (n: number) => (n <= 0 ? '' : n === 1 ? 'great-' : `${n}x great-`)

const gendered = (sex: string, male: string, female: string, neutral: string) => (sex === 'M' ? male : sex === 'F' ? female : neutral)

/** The blood term for how `target` relates to the start, given the climb and the descent. */
export function bloodTerm(up: number, down: number, sex: string): string {
  if (up === 0 && down === 0) return 'self'
  if (down === 0) {
    if (up === 1) return gendered(sex, 'father', 'mother', 'parent')
    return `${greats(up - 2)}${gendered(sex, 'grandfather', 'grandmother', 'grandparent')}`
  }
  if (up === 0) {
    if (down === 1) return gendered(sex, 'son', 'daughter', 'child')
    return `${greats(down - 2)}${gendered(sex, 'grandson', 'granddaughter', 'grandchild')}`
  }
  if (up === 1 && down === 1) return gendered(sex, 'brother', 'sister', 'sibling')
  if (down === 1) return `${greats(up - 2)}${gendered(sex, 'uncle', 'aunt', 'pibling')}`
  if (up === 1) return `${greats(down - 2)}${gendered(sex, 'nephew', 'niece', 'nibling')}`
  const degree = Math.min(up, down) - 1
  const removed = Math.abs(up - down)
  return `${ordinal(degree)} cousin${removed ? ` ${times(removed)} removed` : ''}`
}

const QUALIFIER: Record<string, { parent: [string, string, string]; child: [string, string, string]; tail: string }> = {
  adopted: { parent: ['adoptive father', 'adoptive mother', 'adoptive parent'], child: ['adopted son', 'adopted daughter', 'adopted child'], tail: 'by adoption' },
  step: { parent: ['stepfather', 'stepmother', 'step-parent'], child: ['stepson', 'stepdaughter', 'stepchild'], tail: 'step' },
  foster: { parent: ['foster father', 'foster mother', 'foster parent'], child: ['foster son', 'foster daughter', 'foster child'], tail: 'foster' },
}

const SIBLING: Record<SiblingKind, [string, string, string]> = {
  full: ['brother', 'sister', 'sibling'],
  half: ['half-brother', 'half-sister', 'half-sibling'],
  step: ['stepbrother', 'stepsister', 'step-sibling'],
  adoptive: ['brother (by adoption)', 'sister (by adoption)', 'sibling (by adoption)'],
  foster: ['foster brother', 'foster sister', 'foster sibling'],
}

/**
 * The words for how `b` is to `a`, given the path and, when the store knows they
 * are siblings, how. Siblings in a family with no parents recorded have no path
 * at all, and are still brother and sister.
 */
export function describeRelation(path: Step[] | null, sibling: { person: Person; kind: SiblingKind } | null | undefined): string {
  if (sibling) return gendered(sibling.person.sex, ...SIBLING[sibling.kind])
  return describePath(path)
}

/** Describe a path from relationship(): what the last person is to the first. */
export function describePath(path: Step[] | null): string {
  const words = describeBlood(path)
  if (!path || path.length < 2) return words
  // One non-birth link anywhere in a longer chain: say how, once, the strongest first.
  const relations = path.slice(1).map((s) => s.relation).filter((r): r is string => Boolean(r && r !== 'birth'))
  const strongest = ['adopted', 'foster', 'step'].find((r) => relations.includes(r))
  if (!strongest || /adopt|step|foster/.test(words)) return words
  return `${words} (${QUALIFIER[strongest]!.tail})`
}

function describeBlood(path: Step[] | null): string {
  if (!path) return 'No connection found in this tree.'
  if (path.length === 1) return 'the same person'
  const steps = path.slice(1).map((s) => s.step)
  const target = path[path.length - 1]!.person
  if (steps.length === 1 && steps[0] !== 'partner') {
    const q = QUALIFIER[path[1]!.relation ?? '']
    if (q) return gendered(target.sex, ...(steps[0] === 'parent' ? q.parent : q.child))
  }
  if (steps.length === 1 && steps[0] === 'partner') return gendered(target.sex, 'husband or partner', 'wife or partner', 'partner')

  // Strip a leading partner (your spouse's relatives) and a trailing one (a relative's spouse).
  let lead = 0
  let tail = 0
  let core = steps
  if (core[0] === 'partner') {
    lead = 1
    core = core.slice(1)
  }
  if (core[core.length - 1] === 'partner') {
    tail = 1
    core = core.slice(0, -1)
  }
  let up = 0
  let i = 0
  while (core[i] === 'parent') {
    up++
    i++
  }
  let down = 0
  while (core[i] === 'child') {
    down++
    i++
  }
  if (i !== core.length || core.includes('partner')) {
    return `related by marriage, ${steps.length} steps apart`
  }
  // With a trailing partner step the blood relative is the second-to-last person, so their sex picks the word.
  const relative = tail ? path[path.length - 2]!.person : target
  const term = bloodTerm(up, down, relative.sex)
  const spouseWord = gendered(target.sex, 'husband', 'wife', 'partner')
  if (!lead && !tail) return term
  if (lead && !tail && up <= 1 && down <= 1) {
    if (up === 1 && down === 0) return `${gendered(target.sex, 'father', 'mother', 'parent')}-in-law`
    if (up === 1 && down === 1) return `${gendered(target.sex, 'brother', 'sister', 'sibling')}-in-law`
    if (up === 0 && down === 1) return `${gendered(target.sex, 'stepson', 'stepdaughter', 'stepchild')}`
  }
  if (tail && !lead) {
    if (up === 0 && down === 1) return `${gendered(target.sex, 'son', 'daughter', 'child')}-in-law`
    if (up === 1 && down === 1) return `${gendered(target.sex, 'brother', 'sister', 'sibling')}-in-law`
    if (up === 1 && down === 0) return `${gendered(target.sex, 'stepfather', 'stepmother', 'step-parent')}`
    return `${term}'s ${spouseWord}`
  }
  if (lead && !tail) return `partner's ${term}`
  return `partner's ${term}'s ${spouseWord}`
}
