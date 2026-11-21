import { FirehoseSubscriptionBase, JetstreamEvent } from './util/subscription'

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
  async handleEvent(evt: JetstreamEvent) {
    const commit = evt.commit
    if (evt.kind !== 'commit' || !commit || commit.collection !== 'app.bsky.feed.post') return

    const uri = `at://${evt.did}/${commit.collection}/${commit.rkey}`

    if (commit.operation === 'delete') {
      await this.db.deleteFrom('post').where('uri', '=', uri).execute()
      return
    }

    // updates not supported yet
    if (commit.operation !== 'create' || !commit.record || !commit.cid) return
    if (!matchesTag(commit.record)) return

    const text = typeof commit.record.text === 'string' ? commit.record.text : ''
    console.log(`[match] ${uri} :: ${text.slice(0, 80).replace(/\n/g, ' ')}`)
    await this.db
      .insertInto('post')
      .values({ uri, cid: commit.cid, indexedAt: new Date().toISOString() })
      .onConflict((oc) => oc.doNothing())
      .execute()
  }
}
