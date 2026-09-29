// Owner-API extensions for Blygger Desktop (src/owner-api.ts, auth.verifyBearer,
// migration 0012). Shapes are checked against what the desktop client's serde
// structs require: booleans must be booleans, not 0/1.
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { verifyBearer } from "../src/auth.ts";
import { apiJson, BASE, createAndPublish, login } from "./helpers.ts";

const TOKEN = "test-owner-token";

beforeEach(async () => {
  await env.DB.batch(
    ["read_state", "hopper_items", "hoppers", "signals", "imported_items", "subscriptions", "mentions_in", "settings"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
});

async function bearer(method: string, path: string, body?: unknown, token = TOKEN) {
  const res = await SELF.fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

async function seedSubscription(id = "sub1", title = "Other blyg") {
  await env.DB.prepare(
    "INSERT INTO subscriptions (id, kind, origin, feed_url, title, status, in_blogroll, created) VALUES (?, 'blyg', ?, ?, ?, 'active', 1, ?)",
  )
    .bind(id, `https://other.example/${id}/`, `https://other.example/${id}/feed.xml`, title, "2026-09-01T00:00:00Z")
    .run();
}

async function seedImported(sub: string, remoteId: string, observedAt: string, extra: Record<string, unknown> = {}) {
  await env.DB.prepare(
    `INSERT INTO imported_items (subscription_id, remote_id, kind, state, version, created, updated, observed_at,
       content_md, content_html, author_json, transclusions_json, page)
     VALUES (?, ?, 'fragment', 'current', 2, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      sub,
      remoteId,
      observedAt,
      observedAt,
      observedAt,
      `text ${remoteId}`,
      `<p>text ${remoteId}</p>`,
      (extra.author_json as string) ?? JSON.stringify({ name: "Ada", url: "https://other.example/" }),
      (extra.transclusions_json as string) ?? null,
      `f/${remoteId}/`,
    )
    .run();
}

describe("extension 1: bearer-token owner auth", () => {
  it("accepts the configured token on /api", async () => {
    const r = await bearer("GET", "/api/items");
    expect(r.status).toBe(200);
  });

  it("rejects a wrong token with 401 {error}", async () => {
    const r = await bearer("GET", "/api/items", undefined, "nope");
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: "unauthorized" });
  });

  it("rejects a missing header", async () => {
    const res = await SELF.fetch(`${BASE}/api/items`);
    expect(res.status).toBe(401);
  });

  it("still accepts the studio cookie", async () => {
    const cookie = await login();
    const r = await apiJson(cookie, "GET", "/api/items");
    expect(r.status).toBe(200);
  });

  it("can write, not only read", async () => {
    const r = await bearer("POST", "/api/items", { content_md: "from the app" });
    expect(r.status).toBe(201);
  });

  it("is disabled entirely when BLYG_OWNER_TOKEN is unset or empty", async () => {
    const base = { ...env, BLYG_OWNER_TOKEN: undefined };
    expect(await verifyBearer(base, "Bearer anything")).toBe(false);
    expect(await verifyBearer({ ...env, BLYG_OWNER_TOKEN: "" }, "Bearer ")).toBe(false);
    expect(await verifyBearer(env, `Bearer ${TOKEN}`)).toBe(true);
    expect(await verifyBearer(env, `Basic ${TOKEN}`)).toBe(false);
  });

  it("does not open the studio pages", async () => {
    const res = await SELF.fetch(`${BASE}/blyg/studio`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
  });
});

describe("extension 2: owner JSON reads", () => {
  it("lists items with the client's field types", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "hello, published");
    await bearer("POST", "/api/items", { content_md: "a draft" });
    const r = await bearer("GET", "/api/items");
    expect(r.status).toBe(200);
    const pub = r.json.items.find((i: any) => i.id === id);
    expect(pub).toMatchObject({
      id,
      kind: "fragment",
      authored_kind: "fragment",
      status: "public",
      version: 1,
      dirty: false,
      show_responses: false,
      stub_of: null,
      forked_from: null,
    });
    expect(pub.permalink).toBe(`${BASE}/blyg/f/${id}/`);
    const draft = r.json.items.find((i: any) => i.content_md === "a draft");
    expect(draft).toMatchObject({ status: "draft", version: 0, dirty: true, permalink: null });
  });

  it("returns one item with its versions (pinned/endcap as booleans)", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "v1 text");
    await apiJson(cookie, "POST", `/api/items/${id}/pin`, { version: 1 });
    await apiJson(cookie, "POST", `/api/items/${id}/withdraw`, { note: "bye" });
    const r = await bearer("GET", `/api/items/${id}`);
    expect(r.status).toBe(200);
    expect(r.json.authored_kind).toBe("fragment");
    expect(r.json.status).toBe("withdrawn");
    expect(r.json.versions).toEqual([
      expect.objectContaining({ version: 1, pinned: true, endcap: false }),
      expect.objectContaining({ version: 2, pinned: false, endcap: true, note: "bye" }),
    ]);
  });

  it("404s an unknown item", async () => {
    expect((await bearer("GET", "/api/items/nope")).status).toBe(404);
  });

  it("lists subscriptions with in_blogroll as a boolean", async () => {
    await seedSubscription();
    const r = await bearer("GET", "/api/subscriptions");
    expect(r.status).toBe(200);
    expect(r.json.subscriptions).toEqual([
      expect.objectContaining({
        id: "sub1",
        kind: "blyg",
        origin: "https://other.example/sub1/",
        feed_url: "https://other.example/sub1/feed.xml",
        title: "Other blyg",
        status: "active",
        in_blogroll: true,
      }),
    ]);
  });
});

describe("extension 3: read extensions", () => {
  beforeEach(async () => {
    await seedSubscription();
  });

  it("pages the reading list newest-observed first with an opaque cursor", async () => {
    for (let i = 1; i <= 5; i++) await seedImported("sub1", `r${i}`, `2026-09-0${i}T00:00:00Z`);
    const p1 = await bearer("GET", "/api/reading?limit=2");
    expect(p1.status).toBe(200);
    expect(p1.json.read_state).toBe(true);
    expect(p1.json.items.map((i: any) => i.remote_id)).toEqual(["r5", "r4"]);
    expect(typeof p1.json.next).toBe("string");
    const p2 = await bearer("GET", `/api/reading?limit=2&before=${encodeURIComponent(p1.json.next)}`);
    expect(p2.json.items.map((i: any) => i.remote_id)).toEqual(["r3", "r2"]);
    const p3 = await bearer("GET", `/api/reading?limit=2&before=${encodeURIComponent(p2.json.next)}`);
    expect(p3.json.items.map((i: any) => i.remote_id)).toEqual(["r1"]);
    expect(p3.json.next).toBeNull();
  });

  it("breaks observed_at ties deterministically across pages", async () => {
    for (const id of ["a", "b", "c"]) await seedImported("sub1", id, "2026-09-01T00:00:00Z");
    const seen: string[] = [];
    let next: string | null = null;
    do {
      const r = await bearer("GET", `/api/reading?limit=1${next ? `&before=${encodeURIComponent(next)}` : ""}`);
      seen.push(...r.json.items.map((i: any) => i.remote_id));
      next = r.json.next;
    } while (next);
    expect(seen.sort()).toEqual(["a", "b", "c"]);
  });

  it("carries the fields the client requires", async () => {
    await seedImported("sub1", "x", "2026-09-02T00:00:00Z", {
      transclusions_json: JSON.stringify([{ id: "q", version: 1 }]),
    });
    await env.DB.prepare("INSERT INTO signals (subscription_id, remote_id, thumb, at) VALUES ('sub1','x',1,'2026-09-03T00:00:00Z')").run();
    await env.DB.prepare("INSERT INTO hoppers (id, name, slug, public, created) VALUES ('h1','Keep','keep',0,'2026-09-01T00:00:00Z')").run();
    await env.DB.prepare("INSERT INTO hopper_items (hopper_id, subscription_id, remote_id, added_at) VALUES ('h1','sub1','x','2026-09-03T00:00:00Z')").run();
    const r = await bearer("GET", "/api/reading");
    expect(r.json.items[0]).toMatchObject({
      subscription_id: "sub1",
      remote_id: "x",
      subscription_title: "Other blyg",
      origin: "https://other.example/sub1/",
      kind: "fragment",
      state: "current",
      version: 2,
      observed_at: "2026-09-02T00:00:00Z",
      content_md: "text x",
      content_html: "<p>text x</p>",
      author: { name: "Ada", url: "https://other.example/" },
      page: "f/x/",
      thumb: 1,
      hoppers: ["h1"],
      transclusions: [{ id: "q", version: 1 }],
      read_version: null,
    });
  });

  it("rejects a malformed cursor", async () => {
    expect((await bearer("GET", "/api/reading?before=%%%")).status).toBe(400);
  });

  it("lists hoppers with counts and public as a boolean", async () => {
    await env.DB.prepare("INSERT INTO hoppers (id, name, slug, public, created) VALUES ('h1','Keep','keep',1,'2026-09-01T00:00:00Z')").run();
    await seedImported("sub1", "x", "2026-09-02T00:00:00Z");
    await env.DB.prepare("INSERT INTO hopper_items (hopper_id, subscription_id, remote_id, added_at) VALUES ('h1','sub1','x','2026-09-03T00:00:00Z')").run();
    const r = await bearer("GET", "/api/hoppers");
    expect(r.json.hoppers).toEqual([{ id: "h1", name: "Keep", slug: "keep", public: true, count: 1 }]);
  });

  it("returns only public-safe settings", async () => {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('ai_style_prompt','secret-ish'), ('author_name','Giovanni')").run();
    const r = await bearer("GET", "/api/settings");
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(
      ["author_bio", "author_links", "author_name", "avatar_media_id", "site_title", "site_url", "theme"].sort(),
    );
    expect(r.json.author_name).toBe("Giovanni");
    expect(r.json.site_title).toBe("blyg");
  });

  it("lists mentions with hidden as a boolean and parsed author", async () => {
    await env.DB.prepare(
      `INSERT INTO mentions_in (id, source, target, target_item_id, status, relation, source_origin, source_id,
         source_kind, source_version, source_author_json, first_seen, last_seen, hidden)
       VALUES ('m1','https://o/f/s/','https://me/f/t/','t','verified','stub','https://o/','s','thread',1,?, '2026-09-01T00:00:00Z','2026-09-01T00:00:00Z',1)`,
    )
      .bind(JSON.stringify({ name: "Bo" }))
      .run();
    const r = await bearer("GET", "/api/mentions");
    expect(r.json.mentions[0]).toMatchObject({
      id: "m1",
      target_item_id: "t",
      status: "verified",
      relation: "stub",
      source: "https://o/f/s/",
      source_version: 1,
      source_author: { name: "Bo", url: null },
      hidden: true,
      first_seen: "2026-09-01T00:00:00Z",
    });
  });
});

describe("extension 4: client-recorded TK provenance", () => {
  it("writes text and provenance atomically and discloses at publish", async () => {
    const created = await bearer("POST", "/api/items", { content_md: "draft" });
    const id = created.json.id;
    const text = "Lead. [TK]say why[=]Because it matters.[/TK] End.";
    const put = await bearer("PUT", `/api/items/${id}/tk-provenance`, {
      content_md: text,
      scopes: [{ index: 0, model: "claude-test", sources: [] }],
    });
    expect(put.status).toBe(200);
    expect(put.json).toEqual({ ok: true, disclosed: 1 });

    const got = await bearer("GET", `/api/items/${id}/tk-provenance`);
    expect(got.json.scopes).toHaveLength(1);
    expect(got.json.scopes[0]).toMatchObject({ model: "claude-test", sources: [] });
    expect(JSON.stringify(got.json)).not.toContain("say why");

    const pub = await bearer("POST", `/api/items/${id}/publish`, {});
    expect(pub.status).toBe(200);
    const doc = await SELF.fetch(`${BASE}/blyg/items/${id}.json`);
    const body = await doc.json<any>();
    expect(JSON.stringify(body)).toContain("blyg-tk-gen");
    expect(body.generated?.[0]?.model).toBe("claude-test");
  });

  it("writes nothing on a 400 (count mismatch)", async () => {
    const created = await bearer("POST", "/api/items", { content_md: "original" });
    const id = created.json.id;
    const put = await bearer("PUT", `/api/items/${id}/tk-provenance`, {
      content_md: "new [TK]a[=]b[/TK]",
      scopes: [],
    });
    expect(put.status).toBe(400);
    const item = await bearer("GET", `/api/items/${id}`);
    expect(item.json.content_md).toBe("original");
  });

  it("rejects an entry without a model and a mismatched index", async () => {
    const id = (await bearer("POST", "/api/items", { content_md: "x [TK]a[=]b[/TK] y [TK]c[=]d[/TK]" })).json.id;
    const put = await bearer("PUT", `/api/items/${id}/tk-provenance`, {
      scopes: [{ index: 0 }, { index: 0, model: "m" }],
    });
    expect(put.status).toBe(400);
    expect(put.json.errors.map((e: any) => e.index)).toEqual([0, 1]);
  });

  it("null entries mean hand-written: not disclosed", async () => {
    const id = (await bearer("POST", "/api/items", { content_md: "x [TK]a[=]b[/TK]" })).json.id;
    const put = await bearer("PUT", `/api/items/${id}/tk-provenance`, { scopes: [null] });
    expect(put.json).toEqual({ ok: true, disclosed: 0 });
  });

  it("fills in the current version of a source given without one", async () => {
    const cookie = await login();
    const src = await createAndPublish(cookie, "a source fragment");
    const id = (await bearer("POST", "/api/items", { content_md: "t", kind: "thread" })).json.id;
    const put = await bearer("PUT", `/api/items/${id}/tk-provenance`, {
      content_md: `[TK]sum ![[${src}]][=]summary[/TK]`,
      scopes: [{ index: 0, model: "m", sources: [{ id: src }] }],
    });
    expect(put.status).toBe(200);
    const got = await bearer("GET", `/api/items/${id}/tk-provenance`);
    expect(got.json.scopes[0].sources).toEqual([{ id: src, version: 1 }]);
  });
});

describe("extension 5: read-state sync", () => {
  beforeEach(async () => {
    await seedSubscription();
    await seedImported("sub1", "r1", "2026-09-01T00:00:00Z");
  });

  it("stores max(existing, version) and never lowers it", async () => {
    let r = await bearer("PUT", "/api/reading/sub1/r1/read", { version: 2 });
    expect(r.json).toEqual({ ok: true, stored: true, read_version: 2 });
    r = await bearer("PUT", "/api/reading/sub1/r1/read", { version: 1 });
    expect(r.json.read_version).toBe(2);
    const page = await bearer("GET", "/api/reading");
    expect(page.json.items[0].read_version).toBe(2);
  });

  it("acknowledges unknown rows without writing (never 404)", async () => {
    const r = await bearer("PUT", "/api/reading/sub1/ghost/read", { version: 1 });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, stored: false, read_version: null });
  });

  it("batches, skipping unknown rows", async () => {
    const r = await bearer("POST", "/api/reading/read", {
      items: [
        { sub: "sub1", remote_id: "r1", version: 3 },
        { sub: "sub1", remote_id: "ghost", version: 1 },
      ],
    });
    expect(r.json).toEqual({ ok: true, received: 2 });
    const page = await bearer("GET", "/api/reading");
    expect(page.json.items[0].read_version).toBe(3);
  });

  it("rejects a malformed batch whole", async () => {
    const r = await bearer("POST", "/api/reading/read", {
      items: [
        { sub: "sub1", remote_id: "r1", version: 3 },
        { sub: "sub1", version: -1 },
      ],
    });
    expect(r.status).toBe(400);
    expect(r.json.errors[0].index).toBe(1);
    const page = await bearer("GET", "/api/reading");
    expect(page.json.items[0].read_version).toBeNull();
  });

  it("rejects more than 500 entries", async () => {
    const items = Array.from({ length: 501 }, () => ({ sub: "sub1", remote_id: "r1", version: 1 }));
    expect((await bearer("POST", "/api/reading/read", { items })).status).toBe(400);
  });

  it("drops read state when the imported item or subscription goes", async () => {
    await bearer("PUT", "/api/reading/sub1/r1/read", { version: 1 });
    await env.DB.prepare("DELETE FROM subscriptions WHERE id = 'sub1'").run();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM read_state").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("is never exposed publicly", async () => {
    await bearer("PUT", "/api/reading/sub1/r1/read", { version: 1 });
    for (const p of ["/blyg/blyg.json", "/blyg/feed.xml", "/blyg/items/index.json"]) {
      const text = await (await SELF.fetch(`${BASE}${p}`)).text();
      expect(text).not.toContain("read_version");
    }
  });
});

describe("DELETE /api/media/:id", () => {
  async function upload(): Promise<{ id: string; url: string }> {
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array([137, 80, 78, 71])], "a.png", { type: "image/png" }));
    const res = await SELF.fetch(`${BASE}/api/media`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: fd });
    return res.json();
  }

  it("removes an unpublished upload", async () => {
    const m = await upload();
    expect((await bearer("DELETE", `/api/media/${m.id}`)).status).toBe(200);
    expect(await env.MEDIA.get(m.url)).toBeNull();
    expect((await bearer("DELETE", `/api/media/${m.id}`)).status).toBe(404);
  });

  it("refuses the avatar", async () => {
    const m = await upload();
    await bearer("PUT", "/api/settings", { avatar_media_id: m.id });
    expect((await bearer("DELETE", `/api/media/${m.id}`)).status).toBe(409);
  });

  it("refuses media a published version uses", async () => {
    const m = await upload();
    const cookie = await login();
    await createAndPublish(cookie, `![pic](${m.url})`);
    expect((await bearer("DELETE", `/api/media/${m.id}`)).status).toBe(409);
  });
});
