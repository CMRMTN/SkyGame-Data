/**
 * Runs an ad-hoc query against the resolved Sky data.
 *
 * Usage (from the repo root):
 *   npx tsx .claude/skills/query-data/scripts/query.ts <snippet.mts>
 *   npx tsx .claude/skills/query-data/scripts/query.ts -e "<async function body>"
 *
 * A snippet file default-exports `(ctx) => result`. An inline `-e` body sees the ctx
 * members as variables and must `return` its result. The result is printed as JSON
 * (cycle-safe, DateTime → ISO date) or verbatim if it is a string.
 *
 * Rebuilds /assets first if any src/assets file is newer than assets/everything.json.
 */
import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { DateTime } from 'luxon';
import { SkyDataResolver } from '../../../../src/resolver.js';
import { NodeHelper } from '../../../../src/helpers/node-helper.js';
import { SpiritTreeHelper } from '../../../../src/helpers/spirit-tree-helper.js';
import { SkyDateHelper } from '../../../../src/helpers/date-helper.js';
import type { ICost } from '../../../../src/interfaces/cost.interface.js';
import type { IEventInstance } from '../../../../src/interfaces/event.interface.js';
import type { IItem } from '../../../../src/interfaces/item.interface.js';
import type { INode } from '../../../../src/interfaces/node.interface.js';
import type { IShop } from '../../../../src/interfaces/shop.interface.js';
import type { ISpiritTree } from '../../../../src/interfaces/spirit-tree.interface.js';

const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../..');
const srcAssets = join(repoRoot, 'src/assets');
const everythingPath = join(repoRoot, 'assets/everything.json');

// #region Build freshness

const newestMtime = (dir: string): number => {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
};

if (!existsSync(everythingPath) || newestMtime(srcAssets) > statSync(everythingPath).mtimeMs) {
  console.error('[query] /assets is stale, running json-build...');
  execFileSync(process.execPath, [join(repoRoot, 'src/scripts/json-build.cjs')], { stdio: ['ignore', 'ignore', 'inherit'] });
}

// #endregion

const d = SkyDataResolver.resolve(SkyDataResolver.parse(readFileSync(everythingPath, 'utf-8')));

// #region Helpers

const COST_KEYS = ['c', 'h', 'sc', 'sh', 'ac', 'ec'] as const;
const COST_NAMES: Record<string, string> = { c: 'candles', h: 'hearts', sc: 'seasonal candles', sh: 'seasonal hearts', ac: 'ascended candles', ec: 'event currency' };

/** Current moment in Sky time. */
const now = DateTime.now().setZone(SkyDateHelper.skyTimeZone);

/** Formats a DateTime (or date string) as YYYY-MM-DD. */
const ymd = (date?: DateTime | string): string | undefined =>
  typeof date === 'string' ? date : date?.toISODate() ?? undefined;

/** Picks the non-zero cost fields of a node / list node. */
const cost = (obj?: ICost): Partial<ICost> => {
  const out: Partial<ICost> = {};
  for (const k of COST_KEYS) { if (obj?.[k]) { out[k] = obj[k]; } }
  return out;
};

/** Human-readable cost, e.g. "30 hearts". Empty string when free. */
const costText = (obj?: ICost): string =>
  Object.entries(cost(obj)).map(([k, v]) => `${v} ${COST_NAMES[k]}`).join(' + ');

/** Whether a period contains `at` (defaults to now). */
const isActive = (p: { date?: DateTime; endDate?: DateTime }, at: DateTime = now): boolean =>
  !!p.date && p.date <= at && (!p.endDate || at <= p.endDate);

/** Spirit tree a node belongs to (only root/tier nodes carry `tree` directly). */
const treeOf = (node?: INode): ISpiritTree | undefined => node?.tree ?? node?.root?.tree;

/** Describes where a spirit tree is offered: event, traveling spirit, special visit, season or regular. */
const treeContext = (tree?: ISpiritTree) => {
  if (!tree) { return undefined; }
  const spirit = tree.spirit ?? tree.travelingSpirit?.spirit ?? tree.specialVisitSpirit?.spirit ?? tree.eventInstanceSpirit?.spirit;
  const base = { tree: tree.name, spirit: spirit?.name, spiritType: spirit?.type, draft: tree.draft || undefined };
  if (tree.eventInstanceSpirit) {
    const ei = tree.eventInstanceSpirit.eventInstance;
    return { ...base, kind: 'event', event: ei && eventName(ei), number: ei?.number, date: ymd(ei?.date), endDate: ymd(ei?.endDate) };
  }
  if (tree.travelingSpirit) {
    const ts = tree.travelingSpirit;
    return { ...base, kind: 'travelingSpirit', number: ts.number, visit: ts.visit, date: ymd(ts.date), endDate: ymd(ts.endDate) };
  }
  if (tree.specialVisitSpirit) {
    const sv = tree.specialVisitSpirit.visit;
    return { ...base, kind: 'specialVisit', visit: sv?.name, date: ymd(sv?.date), endDate: ymd(sv?.endDate) };
  }
  if ('revisionType' in tree) {
    return { ...base, kind: 'revisedTree', revisionType: (tree as any).revisionType };
  }
  if (spirit?.season) {
    return { ...base, kind: 'season', season: spirit.season.name, date: ymd(spirit.season.date), endDate: ymd(spirit.season.endDate) };
  }
  return { ...base, kind: spirit ? 'spirit' : 'unknown', area: spirit?.area?.name, realm: spirit?.area?.realm?.name };
};

/** Display name of an event instance (instances may override the event name). */
const eventName = (ei: IEventInstance): string => ei.name ?? ei.event?.name;

/** Describes where a shop is offered. */
const shopContext = (shop?: IShop) => {
  if (!shop) { return undefined; }
  const base = { shop: shop.name ?? shop.type, shopType: shop.type, permanent: shop.permanent || undefined };
  if (shop.event) {
    return { ...base, kind: 'event', event: eventName(shop.event), number: shop.event.number, date: ymd(shop.event.date), endDate: ymd(shop.event.endDate) };
  }
  if (shop.season) {
    return { ...base, kind: 'season', season: shop.season.name, date: ymd(shop.season.date), endDate: ymd(shop.season.endDate) };
  }
  if (shop.spirit) { return { ...base, kind: 'spirit', spirit: shop.spirit.name }; }
  return { ...base, kind: 'shop' };
};

/** Every way to obtain an item: spirit tree nodes (incl. hidden), item list nodes and IAPs. */
const itemSources = (item: IItem) => [
  ...(item.nodes ?? []).map(n => ({ via: 'node' as const, cost: cost(n), ...treeContext(treeOf(n)) })),
  ...(item.hiddenNodes ?? []).map(n => ({ via: 'hiddenNode' as const, cost: cost(n), ...treeContext(treeOf(n)) })),
  ...(item.listNodes ?? []).map(ln => ({ via: 'list' as const, cost: cost(ln), quantity: ln.quantity, ...shopContext(ln.itemList?.shop) })),
  ...(item.iaps ?? []).map(iap => ({ via: 'iap' as const, iap: iap.name, price: iap.price, returning: iap.returning || undefined, ...shopContext(iap.shop) })),
];

/** Every item offered by an event instance, with cost and where it is offered. */
const eventInstanceItems = (ei: IEventInstance) => [
  ...(ei.spirits ?? []).flatMap(es => SpiritTreeHelper.getNodes(es.tree).flatMap(n => [
    ...(n.item ? [{ item: n.item, cost: cost(n), via: 'node' as const, source: es.name ?? es.spirit?.name }] : []),
    ...(n.hiddenItems ?? []).map(item => ({ item, cost: cost(n), via: 'hiddenNode' as const, source: es.name ?? es.spirit?.name })),
  ])),
  ...(ei.shops ?? []).flatMap(shop => [
    ...(shop.itemList?.items ?? []).map(ln => ({ item: ln.item, cost: cost(ln), via: 'list' as const, source: shop.name ?? shop.type })),
    ...(shop.iaps ?? []).flatMap(iap => (iap.items ?? []).map(item => ({ item, price: iap.price, via: 'iap' as const, source: `${shop.name ?? shop.type} / ${iap.name ?? 'IAP'}` }))),
  ]),
];

/** Case-insensitive substring search on `name` across all collections. Returns `{ collection, guid, name, type? }`. */
const search = (text: string, collections?: Array<string>) => {
  const q = text.toLowerCase();
  const out: Array<{ collection: string; guid: string; name: string; type?: string }> = [];
  for (const [key, config] of Object.entries(d)) {
    if (collections && !collections.includes(key)) { continue; }
    const items = (config as any)?.items;
    if (!Array.isArray(items)) { continue; }
    for (const obj of items) {
      if (typeof obj?.name === 'string' && obj.name.toLowerCase().includes(q)) {
        out.push({ collection: key, guid: obj.guid, name: obj.name, type: obj.type });
      }
    }
  }
  return out;
};

/** Looks up any entity by guid. */
const byGuid = (guid: string) => d.guids.get(guid) as any;

// #endregion

// #region Output

/**
 * JSON with cycles broken. DateTimes become ISO dates, Maps are dropped, and entities
 * (objects with a guid) nested deeper than `maxDepth` collapse to `{ $ref, name }`.
 */
const safeStringify = (value: unknown, maxDepth = 3): string => {
  const stack: Array<object> = [];
  const walk = (v: any, depth: number): any => {
    if (v === null || typeof v !== 'object') { return v; }
    if (DateTime.isDateTime(v)) { return v.toISODate(); }
    if (v instanceof Map) { return `[Map(${v.size})]`; }
    if (stack.includes(v) || (depth > maxDepth && v.guid)) { return { $ref: v.guid, name: v.name }; }
    stack.push(v);
    const out = Array.isArray(v)
      ? v.map(x => walk(x, depth + 1))
      : Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, walk(x, depth + 1)]));
    stack.pop();
    return out;
  };
  return JSON.stringify(walk(value, 0), null, 2);
};

// #endregion

const ctx = {
  d, now, DateTime, NodeHelper, SpiritTreeHelper, SkyDateHelper,
  ymd, cost, costText, isActive, treeOf, treeContext, shopContext, eventName,
  itemSources, eventInstanceItems, search, byGuid, safeStringify,
};

const [arg, inline] = process.argv.slice(2);
let result: unknown;
if (arg === '-e' && inline) {
  const AsyncFunction = (async () => {}).constructor as new (...args: Array<string>) => (...args: Array<unknown>) => Promise<unknown>;
  result = await new AsyncFunction(...Object.keys(ctx), inline)(...Object.values(ctx));
} else if (arg) {
  const file = isAbsolute(arg) ? arg : resolvePath(process.cwd(), arg);
  const mod = await import(pathToFileURL(file).href);
  const fn = typeof mod.default === 'function' ? mod.default : mod.default?.default;
  if (typeof fn !== 'function') { throw new Error(`${arg} must default-export a function (ctx) => result.`); }
  result = await fn(ctx);
} else {
  console.error('Usage: query.ts <snippet.mts> | -e "<async function body>"');
  process.exit(1);
}

if (result !== undefined) {
  console.log(typeof result === 'string' ? result : safeStringify(result));
}
