# @pipeworx/georgia-heritage

The National Register of Immovable Cultural Heritage of **Georgia the country**
(საქართველო, in the Caucasus — not the US state): 20,706 monuments and heritage
objects published by the National Agency for Cultural Heritage Preservation of
Georgia, searchable by name, place, category and listing status, with WGS84
coordinates and the listing decree that put each object on the register.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `georgia_heritage_search(query?, region?, municipality?, settlement?, category?, status?, classification?, physical_state?, period?, listed_only?, world_significance_only?, with_coordinates_only?, limit?, offset?)` —
  the register itself. Returns the **true total** for the filter (a separate
  `returnCountOnly` call, not the page size), the registry number `RegNum`, the
  stable `ImmovableObjectID`, coordinates, the listing decree number and date,
  and a `source_url` + `portal_url` per record.
- `georgia_heritage_object(reg_num? | object_id?)` — one object in full:
  description, dating, initial and current function, physical state, listing
  paper trail, plus how many physical and visual protection zones the agency has
  drawn around it.
- `georgia_heritage_nearby(latitude, longitude, radius_m?, limit?)` — what is
  registered around a point, nearest first, with distance in metres.
- `georgia_heritage_facets(field, region?, municipality?, limit?)` — the distinct
  values the register actually stores for a field, with counts. This is the
  discovery step (see "Everything is in Georgian script" below).
- `georgia_heritage_museums(query?, region?, municipality?, limit?)` — the 20
  museums the agency registers, with visitor contact details, opening hours and
  ticket price.

## Auth

Keyless.

## Data sources

- <https://memkvidreoba.gov.ge/arcgisch/rest/services/Culture/CulturePortalService/MapServer/4> —
  monument / heritage-object register, 20,706 records. The layer the agency's own
  public map viewer reads.
- `.../MapServer/5` and `.../MapServer/6` — physical protection zones (9,741) and
  visual protection areas (9,731), keyed by `ImmovableObjectID`.
- `.../MapServer/7` — museum directory, 20 records.
- Public register page per object:
  `https://memkvidreoba.gov.ge/objects/immovable/immovableObject?id=<ImmovableObjectID>`

### Unicode literals need the `N` prefix — without it every filter returns zero

The register is Georgian-script text in SQL Server `NVARCHAR` columns.
`where=Municipality='მცხეთა'` returns `{"count":0}`. `where=Municipality=N'მცხეთა'`
returns `{"count":480}`. Same for `LIKE`. There is no error either way — the
un-prefixed form is a clean 200 with an empty feature array, which is the
silent-zero failure class (`docs/silent-zero-policy.md`). Every literal this pack
puts in a `where` clause goes through `sqlLit()`, which adds the prefix.

### Everything is in Georgian script, so a Latin query matches nothing

There is no English anywhere in the data — not names, not places, not the
category vocabularies. A caller typing "church" or "Kakheti" would otherwise get
a perfectly clean zero. Two mitigations:

- `LATIN_TERMS` / `LATIN_REGIONS` map the common heritage words, the 12 regions,
  the larger municipalities and the best-known monuments to the Georgian the
  register stores. Every entry was checked against a live non-zero count.
  The response reports what it actually searched in `filters.query_terms`, and
  anything it could not translate in `filters.query_terms_unmapped`.
- `georgia_heritage_facets` lists the exact stored values with counts, so a
  caller can read the Georgian for a region/municipality/category and filter on
  it directly. Every empty result points at it.

`GLOSS` adds `*_en` English labels beside the Georgian for the closed
vocabularies (status, category, classification, physical state, region) so a
caller who cannot read the script still gets legible output. It deliberately
does **not** attempt to translate free text — object names and descriptions come
back exactly as the agency wrote them.

### Other things worth knowing

- **Identifiers.** `ImmovableObjectID` is present on every record; `RegNum` is
  `null` for many recorded-but-unnumbered objects, including major ones (the
  Mtskheta historical monuments group, `ImmovableObjectID` 18026, has no
  `RegNum`). Key anything you store on `ImmovableObjectID`, not `OBJECTID` and
  not `RegNum`.
- **Coordinates.** `XGr` is longitude and `YGr` is latitude, both WGS84 — the
  `x`/`y` fields on the same layer are EPSG:32638 metres and are not what you
  want. Some records carry 0/null; `with_coordinates_only` filters them out.
- **`status` vs `category`.** 10,822 of the 20,706 rows are *recorded objects
  without listed status* — surveyed, but not monuments. `listed_only: true`
  restricts to the 9,883 that carry monument status. 1,799 are categorised as of
  national significance and 87 as of world significance.
- **One object can have several boundary polygons** (a complex recorded in
  parts), so a `RegNum` lookup can match more than one row.
  `georgia_heritage_object` returns the first and reports
  `additional_boundary_records` rather than hiding them.
- **`nearby` measures two different things.** The radius filter runs against each
  object's boundary polygon upstream; `distance_m` is computed from the
  register's recorded point. A large site can therefore report a distance beyond
  the radius, which the response says in `distance_note`.
- **ArcGIS reports query errors inside a 200** with an `error` object and no
  features. This pack raises those rather than returning an empty result.
- **Photo URLs are on non-standard ports** (`:60`, `:8443`) — they are handed to
  the caller as the agency published them, and are not fetched by this pack.
- **`CreatorName` / `EditorName` / `CreateDate` / `EditDate` are never
  selected.** They are the agency's internal CMS bookkeeping — which staff member
  typed the row — not anything about the monument.
- The register also covers heritage in historically Georgian territory outside
  today's borders (Türkiye, Azerbaijan, the North Caucasus) and in Abkhazia; the
  `Region` facet shows those as small tails.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "georgia-heritage": {
      "url": "https://gateway.pipeworx.io/georgia-heritage/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/georgia-heritage/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/georgia_heritage_search \
  -H 'Content-Type: application/json' \
  -d '{"query":"monastery","region":"Kakheti","limit":2}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/georgia_heritage_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-georgia-heritage` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/georgia-heritage/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "georgia-heritage": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-georgia-heritage"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Georgia Heritage data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
