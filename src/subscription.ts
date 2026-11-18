import {
  OutputSchema as RepoEvent,
  isCommit,
} from './lexicon/types/com/atproto/sync/subscribeRepos'
import { FirehoseSubscriptionBase, getOpsByType } from './util/subscription'

const parse = (v: string | undefined, d: string) =>
  new Set(
    (v ?? d)
      .split(',')
      .map((t) => t.trim().toLowerCase().replace(/^#/, ''))
      .filter(Boolean),
  )

// Match rules (lowercase, no '#'):
//  ANY:     a post carrying any of these tags matches on its own
//  REQUIRE: a post carrying any of these tags matches only if it ALSO carries a WITH tag
//  WITH:    context tags that qualify a REQUIRE tag
const ANY = parse(process.env.FEEDGEN_TAGS, 'briar')
const REQUIRE = parse(process.env.FEEDGEN_TAGS_REQUIRE, '')
const WITH = parse(process.env.FEEDGEN_TAGS_WITH, '')
// EXCLUDE: any post carrying one of these tags is dropped, even if it matches
const EXCLUDE = parse(process.env.FEEDGEN_TAGS_EXCLUDE, '')

const textTagRegex = /(?:^|[^\p{L}\p{N}_#])#([\p{L}\p{N}_]+)/gu

export function extractTags(record: any): Set<string> {
  const tags = new Set<string>()
  // 1. Proper hashtag facets (what the Bluesky app produces)
  for (const facet of record.facets ?? []) {
    for (const feat of facet.features ?? []) {
      if (feat.$type === 'app.bsky.richtext.facet#tag' && typeof feat.tag === 'string') {
        tags.add(feat.tag.toLowerCase().replace(/^#/, ''))
      }
    }
  }
  // 2. Post-level tags (hidden "outline" tags)
  for (const t of record.tags ?? []) {
    if (typeof t === 'string') tags.add(t.toLowerCase().replace(/^#/, ''))
  }
  // 3. Fallback: raw text, for clients that don't emit facets
  if (typeof record.text === 'string') {
    for (const m of record.text.matchAll(textTagRegex)) tags.add(m[1].toLowerCase())
  }
  return tags
}

export function matchesTag(record: any): boolean {
  const tags = extractTags(record)
  const has = (set: Set<string>) => [...tags].some((t) => set.has(t))
  if (EXCLUDE.size > 0 && has(EXCLUDE)) return false
  if (has(ANY)) return true
  if (has(REQUIRE) && has(WITH)) return true
  // Text pair: the words "briar" and "league" together (clients without tags)
  const text = typeof record.text === 'string' ? record.text : ''
  return /briar/i.test(text) && /league/i.test(text)
}

export class FirehoseSubscription extends FirehoseSubscriptionBase {
  async handleEvent(evt: RepoEvent) {
    if (!isCommit(evt)) return

    const ops = await getOpsByType(evt)

    const postsToDelete = ops.posts.deletes.map((del) => del.uri)
    const postsToCreate = ops.posts.creates
      .filter((create) => matchesTag(create.record))
      .map((create) => {
        console.log(`[match] ${create.uri} :: ${create.record.text.slice(0, 80).replace(/\n/g, ' ')}`)
        return {
          uri: create.uri,
          cid: create.cid,
          indexedAt: new Date().toISOString(),
        }
      })

    if (postsToDelete.length > 0) {
      await this.db.deleteFrom('post').where('uri', 'in', postsToDelete).execute()
    }
    if (postsToCreate.length > 0) {
      await this.db
        .insertInto('post')
        .values(postsToCreate)
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
  }
}
