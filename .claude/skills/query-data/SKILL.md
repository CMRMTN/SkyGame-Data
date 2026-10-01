---
name: query-data
description: Answer ad-hoc questions about the Sky dataset (events, spirits, items, costs, shops, IAPs, seasons, traveling spirits, dates) by running a small query against the resolved data model. Use for any "which/when/how many/what did X cost" question about the data, not for editing it.
---

Task:
Answer a question about the data, e.g. *"What was the most recent event instance that had
items available for hearts, and which items were these?"*. Write a short query against the
**resolved** model, run it, and report the answer.

## Why not grep

Most questions take several GUID hops (event → instance → shop → item list → item, or
spirit → tree → linked node chain → item). The resolver already does those joins, adds reverse
links and converts dates to Sky time. Grep/Read is only for single-entity lookups ("which file
defines X?") or for citing the source file when an edit comes next.

## How to run

From the repo root (the runner needs the repo's `node_modules`):

```bash
# Short query: an async function body with the ctx members in scope; must `return`.
NODE_NO_WARNINGS=1 npx tsx .claude/skills/query-data/scripts/query.ts -e "return search('towel cape')"

# Anything longer: a snippet file that default-exports (ctx) => result.
NODE_NO_WARNINGS=1 npx tsx .claude/skills/query-data/scripts/query.ts <scratchpad>/q-name.mts
```

- Write snippet files to the session scratchpad directory, and always give its **full absolute
  path**. Outside the repo package a snippet **must use `.mts`**, or tsx compiles it as CJS.
- Snippets import nothing. Everything comes in through `ctx`. Type the parameter as `any`.
- For `-e`, wrap the body in double quotes and escape `$` as `\$`. Use a file if the body needs
  template literals or mixed quotes.
- The runner rebuilds `/assets` (json-build) when any `src/assets` file is newer than
  `assets/everything.json`, so don't run the build by hand.
- Return **plain projections** (names, dates, numbers) rather than raw entities. The output is
  cycle-safe, but raw entities are noisy: nested entities collapse to `{ $ref, name }` and
  DateTimes print as `YYYY-MM-DD`.
- When you aren't sure of a shape, check it first (`return Object.keys(x)`, or return one raw
  entity) before writing the full query.

### ctx

| Member | What it is |
| --- | --- |
| `d` | Resolved `ISkyData`: `d.<collection>.items`, plus `d.guids` (Map guid→entity) and `d.itemIds` (Map id→item). |
| `now` | Current moment as a luxon `DateTime` in Sky time (`America/Los_Angeles`). Use it for "current/most recent/upcoming". |
| `DateTime`, `SkyDateHelper` | luxon, and the date helper. `SkyDateHelper.fromStringSky('2025-01-01')` makes a date to compare against. |
| `NodeHelper`, `SpiritTreeHelper` | Library helpers. `SpiritTreeHelper.getNodes(tree)` / `getItems(tree, includeHidden)` handle both node-chain and tier trees. |
| `search(text, collections?)` | Case-insensitive name search across collections, returning `{ collection, guid, name, type }`. Start here to turn a name from the question into an entity. |
| `byGuid(guid)` | Any entity by GUID. |
| `itemSources(item)` | Every way to get an item: tree nodes, hidden nodes, item-list nodes, IAPs. Each comes with its cost or price and context (event/TS/special visit/season/spirit, number, dates). |
| `eventInstanceItems(ei)` | Every item offered by an event instance, as `{ item, cost?, price?, via, source }`. Includes spirit trees, item lists and IAPs. |
| `treeContext(tree)`, `shopContext(shop)` | Where a tree or shop is offered, with dates. |
| `treeOf(node)` | Spirit tree that owns a node. |
| `cost(x)`, `costText(x)` | Non-zero cost fields as an object, or as text ("30 hearts"). |
| `isActive(period, at?)` | `date <= at <= endDate`. |
| `eventName(ei)`, `ymd(date)` | Display name of an instance (it can override the event name), and `YYYY-MM-DD` formatting. |
| `safeStringify(v, depth?)` | The serializer the runner uses, for building a string result yourself. |

## Data model cheat-sheet

The authoritative shapes are in `src/interfaces/*.interface.ts`. Read the relevant one if a
field below isn't enough.

**Collections on `d`:** `realms`, `areas`, `constellations`, `spirits`, `spiritTrees`,
`spiritTreeTiers`, `nodes`, `items`, `itemLists`, `shops`, `iaps`, `seasons`, `events`,
`eventInstances`, `eventInstanceSpirits`, `travelingSpirits`, `specialVisits`,
`specialVisitSpirits`, `wingedLights`, `mapShrines`, `candles` (unstable, unresolved raw map data).

**Relationships (after resolve):**

```
realm ─areas→ area ─spirits→ spirit ─tree→ spiritTree ─node→ node ─n/nw/ne→ node …
                   ├wingedLights, mapShrines, specialVisits          └tier→ tier ─rows[][]→ node, ─next→ tier
spirit ─treeRevisions→ revised trees (revisionType) · ─season · ─area · ─shops
       ─travelingSpirits[] · ─specialVisitSpirits[] · ─eventInstanceSpirits[]
season ─spirits[] (incl. guide) ─shops[] ─includedTrees[]
event ─instances[]→ eventInstance ─spirits[]→ eventInstanceSpirit { spirit, tree, name? }
                                  └shops[]→ shop
shop { type: Store|Spirit|Object, permanent? } ─iaps[]→ iap ─items[]→ item
                                               └itemList→ itemList ─items[]→ itemListNode { item, cost, quantity? }
travelingSpirit { number, visit, spirit, tree } · specialVisit ─spirits[]→ { spirit, tree, visit }
spiritTree back-links: spirit | travelingSpirit | specialVisitSpirit | eventInstanceSpirit
item back-links: nodes[], hiddenNodes[], listNodes[], iaps[], season? (season trees/IAPs only)
```

**Costs (`ICost`, on nodes and item-list nodes):** `c` candles, `h` hearts, `sc` seasonal
candles, `sh` seasonal hearts, `ac` ascended candles, `ec` event currency. A missing key means 0.
IAPs carry `price` (USD), not ICost. Items can show up in several places over time (e.g. the same
cape in an event tree one year and an item list the next), so look at every source.

**Items:** `type` is an `ItemType` (`Cape`, `Mask`, `Emote`, `Music`, `Prop`, `Furniture`,
`WingBuff`, `Special`, …). `group` is one of `Elder|SeasonPass|Ultimate|Limited`. Emotes have
one item per `level`. Blessings, cutscenes etc. are items too (`type: 'Special'`), so filter
them out when the question is about cosmetics.

**Spirit types:** `Regular | Elder | Guide | Season | Event | Special`.

**Dates:** after resolve, `date`/`endDate` on seasons, event instances, traveling spirits and
special visits are luxon `DateTime`s in Sky time. `endDate` is end-of-day. A traveling
spirit's `endDate` defaults to `date + 3 days`. Compare with `<`/`>` or `.toMillis()`, and
format with `ymd()`. **Not converted:** `calculatorData.timedCurrency[].date/endDate` stay
`YYYY-MM-DD` strings.

**Numbering:** `eventInstance.number` is the 1-based index within its event (= "Days of X #n").
`season.number` starts at 1 for Gratitude. `travelingSpirit.number` is global and `.visit`
is per spirit.

## Pitfalls

- **Drafts.** `draft: true` on event instances, seasons, special visits or trees means the data
  may be incomplete. Say so whenever a draft affects the answer.
- **"Most recent" vs "current".** Decide whether a running instance counts (`ei.date <= now`)
  or only finished ones (`ei.endDate < now`). State which you used if it changes the answer.
- **Spirit/item names aren't unique** (e.g. two "Anniversary Guide" spirits). Match by GUID once
  you've found the right one, and say so when a name is ambiguous.
- `NodeHelper.all(tree.node)` misses tier-based (friendship) trees.
  `SpiritTreeHelper.getNodes(tree)` handles both kinds.
- `node.tree` is only set on root nodes (or every node in tier trees). Use `treeOf(node)`.
- Never `JSON.stringify` the resolved model. Return projections, or use `safeStringify`.

## Example snippets

Most recent event instance (started on or before today) with heart items:

```ts
export default ({ d, now, eventName, eventInstanceItems, ymd }: any) =>
  d.eventInstances.items
    .filter((ei: any) => ei.date <= now)
    .map((ei: any) => ({ ei, hearts: eventInstanceItems(ei).filter((x: any) => x.cost?.h) }))
    .filter((r: any) => r.hearts.length)
    .sort((a: any, b: any) => b.ei.date.toMillis() - a.ei.date.toMillis())
    .slice(0, 1)
    .map((r: any) => ({ event: eventName(r.ei), number: r.ei.number, date: ymd(r.ei.date), endDate: ymd(r.ei.endDate),
      items: r.hearts.map((x: any) => `${x.item.name} (${x.item.type}): ${x.cost.h} hearts, ${x.source}`) }));
```

Every source of an item, by name:

```bash
... query.ts -e "return search('Sunlight Pink Towel Cape', ['items']).map(r => itemSources(byGuid(r.guid)))"
```

Traveling spirits that visited in 2025, with total candle cost of their tree:

```ts
export default ({ d, SpiritTreeHelper, ymd }: any) => d.travelingSpirits.items
  .filter((ts: any) => ts.date.year === 2025)
  .map((ts: any) => ({ n: ts.number, spirit: ts.spirit.name, visit: ts.visit, date: ymd(ts.date),
    candles: SpiritTreeHelper.getNodes(ts.tree).reduce((s: number, n: any) => s + (n.c ?? 0), 0) }));
```

What's running right now:

```bash
... query.ts -e "return [...d.eventInstances.items, ...d.seasons.items, ...d.travelingSpirits.items, ...d.specialVisits.items].filter(p => isActive(p)).map(p => p.name ?? p.event?.name ?? p.spirit?.name)"
```

## Answering

- Lead with the direct answer, then the supporting rows (dates as `YYYY-MM-DD`, costs with
  currency names). Keep it short and use a table when there are many rows.
- Mention what you assumed (current vs finished, draft data included, which same-named spirit
  you picked) whenever it changes the answer.
- If the data can't answer the question (e.g. it isn't tracked), say that plainly rather than
  guessing from game knowledge.
