// Owner-API extensions for native clients (Blygger Desktop).
//
// Contract: https://github.com/aneeshsathe/blygger-desktop/blob/main/docs/SERVER.md
// and docs/SPEC.md § API / § Client-recorded provenance in that repo.
//
// Everything here is additive: read-only JSON views of state the studio already
// renders as HTML (extensions 2 and 3), one bookkeeping write for provenance the
// app records itself (extension 4), per-row read state (extension 5, migration
// 0012), and media deletion. No existing route changes behaviour, and nothing
// here is reachable without owner auth — it is mounted under /api, behind the
// same middleware as api.ts (cookie session, or the bearer token from
// extension 1, see auth.ts verifyBearer).

import { Hono } from "hono";
import { authoredKind, getItem, getSettings, getTkProvenance, listAll, listVersions } from "./model.ts";
import { siteOrigin } from "./protocol.ts";
import { parseScopes } from "./tk.ts";
import { resolveFragment } from "./transclusion.ts";
import type { Env, ItemRow, ScopeProvenance } from "./types.ts";
import { normalizeMount, nowIso } from "./util.ts";

export const ownerApi = new Hono<{ Bindings: Env }>({ strict: false });

function parseJson(s: string | null | undefined): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function itemJson(db: D1Database, item: ItemRow, origin: string) {
  const authored = await authoredKind(db, item);
  return {
    id: item.id,
    kind: item.kind,
    authored_kind: authored,
    status: item.status,
    version: item.version,
    dirty: item.dirty === 1,
    created: item.created,
    updated: item.updated,
    content_md: item.content_md,
    stub_of: parseJson(item.stub_of),
    forked_from: parseJson(item.forked_from),
    // Same shape as the item document's `page` (protocol.ts), made absolute.
    // Drafts have no public page yet.
    permalink: item.version > 0 ? `${origin}${authored === "thread" ? "t" : "f"}/${item.id}/` : null,
    show_responses: item.show_responses === 1,
  };
}

async function originFor(c: { env: Env; req: { url: string } }): Promise<string> {
  return siteOrigin(await getSettings(c.env.DB), c.req.url, normalizeMount(c.env.MOUNT));
}

// ---------- extension 2: owner JSON reads ----------

ownerApi.get("/items", async (c) => {
  const origin = await originFor(c);
  const rows = await listAll(c.env.DB);
  const items = [];
  for (const row of rows) items.push(await itemJson(c.env.DB, row, origin));
  return c.json({ items });
});

ownerApi.get("/items/:id", async (c) => {
  const item = await getItem(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  const origin = await originFor(c);
  const versions = (await listVersions(c.env.DB, item.id)).map((v) => ({
    version: v.version,
    published_at: v.published_at,
    note: v.note,
    pinned: v.pinned === 1,
    // A withdrawal endcap carries no content (§2.8); same test api.ts's pin route uses.
    endcap: !v.content_md,
  }));
  return c.json({ ...(await itemJson(c.env.DB, item, origin)), versions });
});

ownerApi.get("/subscriptions", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, kind, origin, feed_url, title, status, in_blogroll, last_poll_at, fail_count, created FROM subscriptions ORDER BY created ASC, id ASC",
  ).all<{
    id: string;
    kind: string;
    origin: string;
    feed_url: string;
    title: string;
    status: string;
    in_blogroll: number;
    last_poll_at: string | null;
    fail_count: number;
    created: string;
  }>();
  return c.json({
    subscriptions: rows.results.map((r) => ({ ...r, in_blogroll: r.in_blogroll === 1 })),
  });
});

// ---------- extension 3: read extensions ----------

const READING_DEFAULT_LIMIT = 100;
const READING_MAX_LIMIT = 500;

/** Opaque keyset cursor over (observed_at, subscription_id, remote_id). */
function encodeCursor(k: [string, string, string]): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(k)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(s: string): [string, string, string] | null {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const v = JSON.parse(decodeURIComponent(escape(atob(b64))));
    if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "string")) return v as [string, string, string];
  } catch {
    // fall through
  }
  return null;
}

type ReadingRow = {
  subscription_id: string;
  remote_id: string;
  kind: string;
  state: string;
  version: number;
  created: string | null;
  updated: string | null;
  observed_at: string;
  content_md: string;
  content_html: string;
  author_json: string | null;
  transclusions_json: string | null;
  pinned_version_retained: number | null;
  page: string | null;
  sub_title: string;
  sub_origin: string;
  thumb: number | null;
  read_version: number | null;
};

ownerApi.get("/reading", async (c) => {
  const rawLimit = Number(c.req.query("limit") ?? READING_DEFAULT_LIMIT);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, READING_MAX_LIMIT) : READING_DEFAULT_LIMIT;
  const before = c.req.query("before");
  let cursor: [string, string, string] | null = null;
  if (before) {
    cursor = decodeCursor(before);
    if (!cursor) return c.json({ error: "bad cursor" }, 400);
  }

  const where = cursor ? "WHERE (i.observed_at, i.subscription_id, i.remote_id) < (?, ?, ?)" : "";
  const sql = `
    SELECT i.subscription_id, i.remote_id, i.kind, i.state, i.version, i.created, i.updated,
           i.observed_at, i.content_md, i.content_html, i.author_json, i.transclusions_json,
           i.pinned_version_retained, i.page,
           s.title AS sub_title, s.origin AS sub_origin,
           g.thumb AS thumb, r.read_version AS read_version
      FROM imported_items i
      JOIN subscriptions s ON s.id = i.subscription_id
      LEFT JOIN signals g ON g.subscription_id = i.subscription_id AND g.remote_id = i.remote_id
      LEFT JOIN read_state r ON r.subscription_id = i.subscription_id AND r.remote_id = i.remote_id
      ${where}
     ORDER BY i.observed_at DESC, i.subscription_id DESC, i.remote_id DESC
     LIMIT ?`;
  const stmt = cursor ? c.env.DB.prepare(sql).bind(...cursor, limit + 1) : c.env.DB.prepare(sql).bind(limit + 1);
  const rows = (await stmt.all<ReadingRow>()).results;
  const page = rows.slice(0, limit);

  // Hopper membership for this page only, one query.
  const hopperMap = new Map<string, string[]>();
  if (page.length) {
    const hops = await c.env.DB.prepare("SELECT hopper_id, subscription_id, remote_id FROM hopper_items").all<{
      hopper_id: string;
      subscription_id: string;
      remote_id: string;
    }>();
    for (const h of hops.results) {
      const key = `${h.subscription_id}\u0000${h.remote_id}`;
      const list = hopperMap.get(key) ?? [];
      list.push(h.hopper_id);
      hopperMap.set(key, list);
    }
  }

  const items = page.map((r) => {
    const author = parseJson(r.author_json) as { name?: unknown; url?: unknown } | null;
    const transclusions = parseJson(r.transclusions_json);
    return {
      subscription_id: r.subscription_id,
      remote_id: r.remote_id,
      subscription_title: r.sub_title,
      origin: r.sub_origin,
      kind: r.kind,
      state: r.state,
      version: r.version,
      created: r.created,
      updated: r.updated,
      observed_at: r.observed_at,
      content_md: r.content_md,
      content_html: r.content_html,
      author:
        author && typeof author === "object"
          ? { name: typeof author.name === "string" ? author.name : null, url: typeof author.url === "string" ? author.url : null }
          : null,
      page: r.page,
      thumb: r.thumb === 1 || r.thumb === -1 ? r.thumb : null,
      hoppers: hopperMap.get(`${r.subscription_id}\u0000${r.remote_id}`) ?? [],
      pinned_version_retained: r.pinned_version_retained,
      transclusions: Array.isArray(transclusions) ? transclusions : [],
      read_version: r.read_version,
    };
  });
  const last = page[page.length - 1];
  const next = rows.length > limit && last ? encodeCursor([last.observed_at, last.subscription_id, last.remote_id]) : null;
  return c.json({ items, next, read_state: true });
});

ownerApi.get("/mentions", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, target_item_id, status, relation, source, source_origin, source_id, source_kind,
            source_version, source_author_json, first_seen, verified_at, hidden
       FROM mentions_in ORDER BY first_seen DESC, id DESC`,
  ).all<{
    id: string;
    target_item_id: string;
    status: string;
    relation: string | null;
    source: string;
    source_origin: string | null;
    source_id: string | null;
    source_kind: string | null;
    source_version: number | null;
    source_author_json: string | null;
    first_seen: string;
    verified_at: string | null;
    hidden: number;
  }>();
  return c.json({
    mentions: rows.results.map(({ source_author_json, hidden, ...m }) => {
      const a = parseJson(source_author_json) as { name?: unknown; url?: unknown } | null;
      return {
        ...m,
        source_author:
          a && typeof a === "object"
            ? { name: typeof a.name === "string" ? a.name : null, url: typeof a.url === "string" ? a.url : null }
            : null,
        hidden: hidden === 1,
      };
    }),
  });
});

/** Public-safe fields only: never AI keys, style prompts, or anything secret. */
ownerApi.get("/settings", async (c) => {
  const s = await getSettings(c.env.DB);
  return c.json({
    site_title: s.site_title,
    author_name: s.author_name,
    author_bio: s.author_bio,
    site_url: s.site_url,
    theme: s.theme,
    avatar_media_id: s.avatar_media_id,
    author_links: s.author_links,
  });
});

ownerApi.get("/hoppers", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT h.id, h.name, h.slug, h.public, COUNT(hi.hopper_id) AS count
       FROM hoppers h LEFT JOIN hopper_items hi ON hi.hopper_id = h.id
      GROUP BY h.id ORDER BY h.created ASC, h.id ASC`,
  ).all<{ id: string; name: string; slug: string | null; public: number; count: number }>();
  return c.json({ hoppers: rows.results.map((h) => ({ ...h, public: h.public === 1 })) });
});

// ---------- extension 4: client-recorded TK provenance ----------

ownerApi.get("/items/:id/tk-provenance", async (c) => {
  const item = await getItem(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  const { scopes } = parseScopes(item.content_md);
  const cache = getTkProvenance(item);
  // Report positionally against the *current* scopes, so a stale longer cache
  // never shows phantom entries.
  return c.json({ scopes: scopes.map((_, i) => cache[i] ?? null) });
});

type ScopeIn = { index?: unknown; model?: unknown; sources?: unknown; at?: unknown } | null;

/**
 * Text + provenance in one atomic write. Validation runs first and nothing is
 * written on a 400. Only {model, sources, at} are stored — never the
 * instruction, which stays in the working copy where the author wrote it.
 */
ownerApi.put("/items/:id/tk-provenance", async (c) => {
  const item = await getItem(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ content_md?: unknown; scopes?: unknown }>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "JSON body required" }, 400);
  if (body.content_md !== undefined && typeof body.content_md !== "string") {
    return c.json({ error: "content_md must be a string" }, 400);
  }
  if (!Array.isArray(body.scopes)) return c.json({ error: "scopes must be an array" }, 400);

  const contentMd = typeof body.content_md === "string" ? body.content_md : item.content_md;
  const { scopes, errors: parseErrors } = parseScopes(contentMd);
  if (parseErrors.length) return c.json({ error: "working copy has malformed TK scopes", errors: parseErrors }, 400);
  if (body.scopes.length !== scopes.length) {
    return c.json({ error: `scopes has ${body.scopes.length} entries, the text has ${scopes.length} TK scopes` }, 400);
  }

  const errors: { index: number; reason: string }[] = [];
  const out: (ScopeProvenance | null)[] = [];
  const at = nowIso();
  for (let i = 0; i < body.scopes.length; i++) {
    const e = body.scopes[i] as ScopeIn;
    if (e === null) {
      out.push(null);
      continue;
    }
    if (typeof e !== "object") {
      errors.push({ index: i, reason: "entry must be an object or null" });
      continue;
    }
    if (e.index !== undefined && e.index !== i) {
      errors.push({ index: i, reason: "index does not match position" });
      continue;
    }
    if (typeof e.model !== "string" || !e.model.trim()) {
      errors.push({ index: i, reason: "model required" });
      continue;
    }
    if (e.at !== undefined && (typeof e.at !== "string" || Number.isNaN(Date.parse(e.at)))) {
      errors.push({ index: i, reason: "at must be an ISO-8601 time" });
      continue;
    }
    const rawSources = e.sources === undefined ? [] : e.sources;
    if (!Array.isArray(rawSources)) {
      errors.push({ index: i, reason: "sources must be an array" });
      continue;
    }
    const sources: { id: string; version: number }[] = [];
    let bad = false;
    for (const s of rawSources as { id?: unknown; version?: unknown }[]) {
      if (!s || typeof s !== "object" || typeof s.id !== "string") {
        errors.push({ index: i, reason: "each source needs an id" });
        bad = true;
        break;
      }
      if (s.version !== undefined && s.version !== null && !(Number.isInteger(s.version) && (s.version as number) > 0)) {
        errors.push({ index: i, reason: `source ${s.id}: version must be a positive integer` });
        bad = true;
        break;
      }
      let version = s.version as number | undefined | null;
      if (version == null) {
        // "None lets the server record the current one" — same resolution the
        // Worker's own /generate uses for its sources.
        const resolved = await resolveFragment(c.env.DB, s.id);
        if (!resolved.ok) {
          errors.push({ index: i, reason: `source ${s.id}: ${resolved.reason}` });
          bad = true;
          break;
        }
        version = resolved.version.version;
      }
      sources.push({ id: s.id, version });
    }
    if (bad) continue;
    out.push({ sources, model: e.model.trim(), at: typeof e.at === "string" ? e.at : at });
  }
  if (errors.length) return c.json({ error: "invalid provenance", errors }, 400);

  const provJson = JSON.stringify(out);
  if (typeof body.content_md === "string") {
    // Same semantics as model.saveWorkingCopy, plus the cache, in one statement.
    await c.env.DB.prepare(
      "UPDATE items SET content_md = ?, tk_provenance_json = ?, dirty = 1, updated = CASE WHEN version = 0 THEN ? ELSE updated END WHERE id = ?",
    )
      .bind(contentMd, provJson, nowIso(), item.id)
      .run();
  } else {
    await c.env.DB.prepare("UPDATE items SET tk_provenance_json = ? WHERE id = ?").bind(provJson, item.id).run();
  }
  return c.json({ ok: true, disclosed: out.filter((p) => p !== null).length });
});

// ---------- extension 5: read-state sync (migration 0012) ----------

const READ_BATCH_MAX = 500;

async function storeRead(db: D1Database, sub: string, remoteId: string, version: number): Promise<number | null> {
  const known = await db
    .prepare("SELECT 1 AS ok FROM imported_items WHERE subscription_id = ? AND remote_id = ?")
    .bind(sub, remoteId)
    .first<{ ok: number }>();
  if (!known) return null;
  await db
    .prepare(
      `INSERT INTO read_state (subscription_id, remote_id, read_version, updated) VALUES (?, ?, ?, ?)
       ON CONFLICT(subscription_id, remote_id) DO UPDATE SET
         read_version = MAX(read_state.read_version, excluded.read_version),
         updated = CASE WHEN excluded.read_version > read_state.read_version THEN excluded.updated ELSE read_state.updated END`,
    )
    .bind(sub, remoteId, version, nowIso())
    .run();
  const row = await db
    .prepare("SELECT read_version FROM read_state WHERE subscription_id = ? AND remote_id = ?")
    .bind(sub, remoteId)
    .first<{ read_version: number }>();
  return row?.read_version ?? null;
}

const isVersion = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

ownerApi.put("/reading/:sub/:remoteId/read", async (c) => {
  const body = await c.req.json<{ version?: unknown }>().catch(() => null);
  if (!body || !isVersion(body.version)) return c.json({ error: "version must be an integer >= 0" }, 400);
  const stored = await storeRead(c.env.DB, c.req.param("sub"), c.req.param("remoteId"), body.version);
  return c.json({ ok: true, stored: stored !== null, read_version: stored });
});

ownerApi.post("/reading/read", async (c) => {
  const body = await c.req.json<{ items?: unknown }>().catch(() => null);
  if (!body || !Array.isArray(body.items)) return c.json({ error: "items must be an array" }, 400);
  if (body.items.length > READ_BATCH_MAX) return c.json({ error: `at most ${READ_BATCH_MAX} items` }, 400);
  const errors: { index: number; reason: string }[] = [];
  body.items.forEach((e: unknown, index: number) => {
    const x = e as { sub?: unknown; remote_id?: unknown; version?: unknown } | null;
    if (!x || typeof x !== "object") errors.push({ index, reason: "entry must be an object" });
    else if (typeof x.sub !== "string" || !x.sub) errors.push({ index, reason: "sub required" });
    else if (typeof x.remote_id !== "string" || !x.remote_id) errors.push({ index, reason: "remote_id required" });
    else if (!isVersion(x.version)) errors.push({ index, reason: "version must be an integer >= 0" });
  });
  if (errors.length) return c.json({ error: "invalid items", errors }, 400);
  for (const x of body.items as { sub: string; remote_id: string; version: number }[]) {
    await storeRead(c.env.DB, x.sub, x.remote_id, x.version);
  }
  return c.json({ ok: true, received: body.items.length });
});

// ---------- media deletion ("also used when present") ----------

ownerApi.delete("/media/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT id, r2_key FROM media WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ id: string; r2_key: string }>();
  if (!row) return c.json({ error: "not found" }, 404);
  const settings = await getSettings(c.env.DB);
  if (settings.avatar_media_id === row.id) return c.json({ error: "this is the site avatar" }, 409);
  // A published version (pinned or not) may reference it; removing the file
  // would break a page and, for a pin, a promise. Only unpublished uploads go.
  const used = await c.env.DB.prepare("SELECT 1 AS ok FROM versions WHERE instr(content_md, ?) > 0 LIMIT 1")
    .bind(row.r2_key)
    .first<{ ok: number }>();
  if (used) return c.json({ error: "used by a published version" }, 409);
  await c.env.MEDIA.delete(row.r2_key);
  await c.env.DB.prepare("DELETE FROM media WHERE id = ?").bind(row.id).run();
  return c.json({ ok: true });
});
