import { describe, expect, test } from 'bun:test'
import { Store, lifespan, normalizePerson, yearOf } from '../src/db.ts'
import { addRelative } from '../src/server.ts'
import { bloodTerm, describePath } from '../src/relate.ts'

const setup = () => {
  const store = new Store(':memory:')
  const user = store.findOrCreateUser('Anthony@Example.com')
  const tree = store.createTree(user.id, 'Test family')
  return { store, user, tree }
}

describe('store', () => {
  test('emails are case-insensitive and the owner is a member', () => {
    const { store, user, tree } = setup()
    expect(store.findOrCreateUser('anthony@example.com').id).toBe(user.id)
    expect(store.role(tree.id, user.id)).toBe('owner')
    expect(store.treesFor(user.id)[0]!.name).toBe('Test family')
  })

  test('the first person becomes the home person', () => {
    const { store, tree } = setup()
    const p = store.addPerson(tree.id, { given: 'Ada', surname: 'Lovelace' })
    expect(store.tree(tree.id)!.home_person_id).toBe(p.id)
  })

  test('a person in one tree is invisible from another', () => {
    const { store, user, tree } = setup()
    const other = store.createTree(user.id, 'Other')
    const p = store.addPerson(tree.id, { given: 'Ada' })
    expect(store.person(other.id, p.id)).toBeNull()
    expect(() => store.createFamily(other.id, p.id, null)).toThrow()
  })

  test('addRelative builds families the GEDCOM way', () => {
    const { store, tree } = setup()
    const kid = store.addPerson(tree.id, { given: 'Kid', surname: 'Smith', sex: 'F' })
    const dad = addRelative(store, tree.id, kid.id, { as: 'parent', given: 'Dad', surname: 'Smith', sex: 'M' })
    const mum = addRelative(store, tree.id, kid.id, { as: 'parent', given: 'Mum', surname: 'Jones', sex: 'F' })
    // Both parents land in one family, not two single-parent families.
    const fams = store.parentFamilies(tree.id, kid.id)
    expect(fams).toHaveLength(1)
    expect(fams[0]!.parents.map((p) => p.id).sort()).toEqual([dad.id, mum.id].sort())
    // A sibling added as a child of dad joins the same family.
    const sib = addRelative(store, tree.id, dad.id, { as: 'child', given: 'Sib', family_id: fams[0]!.family.id })
    expect(store.parentFamilies(tree.id, kid.id)[0]!.siblings.map((s) => s.id)).toEqual([sib.id])
    const partner = addRelative(store, tree.id, kid.id, { as: 'partner', given: 'Pat' })
    expect(store.spouseFamilies(tree.id, kid.id)[0]!.partner!.id).toBe(partner.id)
  })

  test('nobody can become their own ancestor', () => {
    const { store, tree } = setup()
    const a = store.addPerson(tree.id, { given: 'A' })
    const b = addRelative(store, tree.id, a.id, { as: 'child', given: 'B' })
    expect(() => addRelative(store, tree.id, b.id, { as: 'child', existing_id: a.id })).toThrow(/own ancestor/)
  })

  test('pedigree numbers ancestors Ahnentafel-style, father first', () => {
    const { store, tree } = setup()
    const me = store.addPerson(tree.id, { given: 'Me' })
    const mum = addRelative(store, tree.id, me.id, { as: 'parent', given: 'Mum', sex: 'F' })
    const dad = addRelative(store, tree.id, me.id, { as: 'parent', given: 'Dad', sex: 'M' })
    const gran = addRelative(store, tree.id, mum.id, { as: 'parent', given: 'Gran', sex: 'F' })
    const ped = store.pedigree(tree.id, me.id, 3)
    expect(ped.get(1)!.id).toBe(me.id)
    expect(ped.get(2)!.id).toBe(dad.id)
    expect(ped.get(3)!.id).toBe(mum.id)
    expect(ped.get(7)!.id).toBe(gran.id)
  })

  test('search matches every word across names, places and dates', () => {
    const { store, tree } = setup()
    store.addPerson(tree.id, { given: 'Johann', surname: 'Ettinger', birth_place: 'Baden', birth_date: '1871' })
    store.addPerson(tree.id, { given: 'Karl', surname: 'Ettinger', birth_place: 'Chicago' })
    expect(store.search(tree.id, 'ettinger')).toHaveLength(2)
    expect(store.search(tree.id, 'ettinger baden').map((p) => p.given)).toEqual(['Johann'])
    expect(store.search(tree.id, '1871')).toHaveLength(1)
    expect(store.search(tree.id, '100%')).toHaveLength(0)
  })

  test('invites never demote and work once', () => {
    const { store, user, tree } = setup()
    const cousin = store.findOrCreateUser('cousin@example.com')
    const token = store.createInvite(tree.id, user.id, 'viewer')
    expect(store.acceptInvite(token, cousin.id)).toBe(tree.id)
    expect(store.role(tree.id, cousin.id)).toBe('viewer')
    expect(store.acceptInvite(token, cousin.id)).toBeNull()
    const own = store.createInvite(tree.id, user.id, 'viewer')
    store.acceptInvite(own, user.id)
    expect(store.role(tree.id, user.id)).toBe('owner')
  })

  test('deleting a person cleans up empty families', () => {
    const { store, tree } = setup()
    const a = store.addPerson(tree.id, { given: 'A' })
    const b = addRelative(store, tree.id, a.id, { as: 'partner', given: 'B' })
    store.deletePerson(tree.id, a.id)
    store.deletePerson(tree.id, b.id)
    expect(store.families(tree.id)).toHaveLength(0)
    expect(store.tree(tree.id)!.home_person_id).toBeNull()
  })

  test('normalizePerson and dates', () => {
    expect(normalizePerson({ sex: 'female', living: 'on', given: '  Ada\u0000 ' })).toEqual({ sex: 'F', living: 1, given: 'Ada' })
    expect(yearOf('ABT 1890')).toBe(1890)
    expect(lifespan({ birth_date: '1 JAN 1900', death_date: null, living: 1 })).toBe('1900–')
  })
})

describe('relationships', () => {
  test('blood terms', () => {
    expect(bloodTerm(1, 0, 'F')).toBe('mother')
    expect(bloodTerm(2, 0, 'M')).toBe('grandfather')
    expect(bloodTerm(4, 0, 'U')).toBe('2x great-grandparent')
    expect(bloodTerm(1, 1, 'F')).toBe('sister')
    expect(bloodTerm(2, 1, 'M')).toBe('uncle')
    expect(bloodTerm(3, 1, 'F')).toBe('great-aunt')
    expect(bloodTerm(1, 2, 'F')).toBe('niece')
    expect(bloodTerm(2, 2, 'U')).toBe('first cousin')
    expect(bloodTerm(3, 2, 'U')).toBe('first cousin once removed')
    expect(bloodTerm(3, 3, 'U')).toBe('second cousin')
    expect(bloodTerm(0, 3, 'M')).toBe('great-grandson')
  })

  test('relationship() finds the path and describePath names it', () => {
    const { store, tree } = setup()
    const gp = store.addPerson(tree.id, { given: 'Grandpa', sex: 'M' })
    const dad = addRelative(store, tree.id, gp.id, { as: 'child', given: 'Dad', sex: 'M' })
    const aunt = addRelative(store, tree.id, gp.id, { as: 'child', given: 'Aunt', sex: 'F' })
    const me = addRelative(store, tree.id, dad.id, { as: 'child', given: 'Me', sex: 'F' })
    const cousin = addRelative(store, tree.id, aunt.id, { as: 'child', given: 'Cuz', sex: 'M' })
    const wife = addRelative(store, tree.id, cousin.id, { as: 'partner', given: 'Wife', sex: 'F' })
    expect(describePath(store.relationship(tree.id, me.id, cousin.id))).toBe('first cousin')
    expect(describePath(store.relationship(tree.id, me.id, gp.id))).toBe('grandfather')
    expect(describePath(store.relationship(tree.id, me.id, aunt.id))).toBe('aunt')
    expect(describePath(store.relationship(tree.id, cousin.id, wife.id))).toBe('wife or partner')
    expect(describePath(store.relationship(tree.id, dad.id, wife.id))).toBe("nephew's wife")
    expect(describePath(store.relationship(tree.id, wife.id, aunt.id))).toBe('mother-in-law')
    const stranger = store.addPerson(tree.id, { given: 'Nobody' })
    expect(describePath(store.relationship(tree.id, me.id, stranger.id))).toBe('No connection found in this tree.')
  })
})
