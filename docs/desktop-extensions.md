# Owner-API extensions for Blygger Desktop

This fork of [blygger-studio](https://github.com/blygger/blygger-studio) carries the
server extensions that [Blygger Desktop](https://github.com/aneeshsathe/blygger-desktop)
needs ([its `docs/SERVER.md`](https://github.com/aneeshsathe/blygger-desktop/blob/main/docs/SERVER.md)
is the contract). Everything is additive and owner-only.

| # | What | Where |
|---|------|-------|
| 1 | `Authorization: Bearer <BLYG_OWNER_TOKEN>` accepted on `/api/*` wherever the owner cookie is. Unset secret = off. Studio pages stay cookie-only. | `auth.ts` `verifyBearer`, `index.ts` |
| 2 | `GET /api/items`, `GET /api/items/:id` (+`versions`), `GET /api/subscriptions` | `owner-api.ts` |
| 3 | `GET /api/reading?limit&before` (opaque keyset cursor, ≤500/page), `GET /api/mentions`, `GET /api/settings` (public-safe fields only), `GET /api/hoppers`; `show_responses` on item JSON | `owner-api.ts` |
| 4 | `GET`/`PUT /api/items/:id/tk-provenance` — text + position-keyed provenance in one statement, validated first, never stores the instruction | `owner-api.ts` |
| 5 | Read-state sync: `read_state: true` + `read_version` on reading pages, `PUT /api/reading/:sub/:remoteId/read`, `POST /api/reading/read` (≤500), max-merge, unknown rows acknowledged | `owner-api.ts`, `migrations/0012_read_state.sql` |
| – | `DELETE /api/media/:id` — 404 unknown, 409 for the avatar **and for media any published version references** (a pin is a promise) | `owner-api.ts` |

Not implemented: `POST /api/media` duplicate detection (`duplicate: true`). The app
works without it; an identical re-paste just stores a second copy.

## Setting the token

```
openssl rand -base64 32 | tr -d '\n' | npx wrangler secret put BLYG_OWNER_TOKEN --env <yourenv>
```

Paste the same value into Blygger Desktop's *Connect your blyg* step (it goes to
the macOS Keychain). Treat it like the studio password: it grants full owner
write access. Rotate by putting a new value and reconnecting the app.

Version: `blygger-studio-desktop-ext/0.7.0-ext.1`, based on upstream 0.7.0. **Migrations: `0012_read_state.sql`** (run `npx wrangler d1 migrations apply DB --remote`).

Tests: `test/owner-api.test.ts` (33 tests; shapes checked against the desktop
client's serde structs — booleans are booleans).
