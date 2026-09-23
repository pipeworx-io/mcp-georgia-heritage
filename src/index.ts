interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Georgia (the country) — National Register of Immovable Cultural Heritage.
 *
 * Sourced from the National Agency for Cultural Heritage Preservation of
 * Georgia (memkvidreoba.gov.ge), which publishes the register through a
 * keyless ArcGIS Server REST endpoint that its own public map viewer reads:
 *   .../arcgisch/rest/services/Culture/CulturePortalService/MapServer
 * Layer 4 is the monument/object register (20,706 records), layers 5 and 6 are
 * the physical and visual protection zones keyed by ImmovableObjectID, and
 * layer 7 is the museum directory.
 *
 * TWO TRAPS, both of which return a clean zero rather than an error:
 *
 * 1. UNICODE STRING LITERALS NEED THE `N` PREFIX. The register is stored in
 *    Georgian script in SQL Server NVARCHAR columns. `Municipality='მცხეთა'`
 *    matches 0 rows; `Municipality=N'მცხეთა'` matches 480. Every literal this
 *    pack puts in a where clause goes through sqlLit(), which adds it.
 *
 * 2. THE REGISTER HAS NO ENGLISH. Every name, place and category is Georgian
 *    script only, so a Latin-script query matches nothing on its own. Rather
 *    than hand back a silent zero, LATIN_TERMS maps the common heritage words
 *    and place names to the Georgian the register actually stores, and the
 *    response reports which Georgian terms it searched in `query_terms` so the
 *    caller can see (and disagree with) the expansion.
 *
 * CreatorName / EditorName / CreateDate / EditDate exist on the upstream layer
 * and are the agency's internal CMS bookkeeping — the names of staff who typed
 * the row, not anything about the monument. This pack never selects them.
 */


const UA = 'pipeworx-mcp-georgia-heritage/1.0 (+https://pipeworx.io)';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { Accept: 'application/json', 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'Georgian Cultural Heritage Register');
}

const MAP = 'https://memkvidreoba.gov.ge/arcgisch/rest/services/Culture/CulturePortalService/MapServer';
const L_MONUMENT = `${MAP}/4`;
const L_ZONE_PHYSICAL = `${MAP}/5`;
const L_ZONE_VISUAL = `${MAP}/6`;
const L_MUSEUM = `${MAP}/7`;
/** The public register page for one object, keyed by ImmovableObjectID. */
const PORTAL_OBJECT = 'https://memkvidreoba.gov.ge/objects/immovable/immovableObject?id=';

const MONUMENT_FIELDS = [
  'OBJECTID', 'ImmovableObjectID', 'RegNum', 'ObjectName', 'ObjectFullName', 'ComplexObjectName',
  'Region', 'Municipality', 'Settlement', 'Address', 'CategoryName', 'StatusName', 'Classification',
  'Period', 'ExactDate', 'DateRangeFrom', 'DateRangeTo', 'PhysicalState', 'InitialFunction',
  'CurrentFunction', 'WorldCategoryName', 'ListingStatusDate', 'ListingStatusDocumentNumber',
  'ListingsRegistryNumber', 'ListingCategoryDate', 'ListingCategoryDocumentNumber',
  'Description', 'PhotoAddress', 'XGr', 'YGr', 'Elevation',
].join(',');

/** Fields the free-text `query` is matched against. */
const TEXT_FIELDS = ['ObjectName', 'ObjectFullName', 'ComplexObjectName', 'Settlement', 'Address', 'Description'];

const FACET_FIELDS: Record<string, string> = {
  region: 'Region',
  municipality: 'Municipality',
  settlement: 'Settlement',
  category: 'CategoryName',
  status: 'StatusName',
  classification: 'Classification',
  physical_state: 'PhysicalState',
  current_function: 'CurrentFunction',
  world_category: 'WorldCategoryName',
  period: 'Period',
};

/**
 * Latin -> Georgian, every entry verified against a live non-zero count on
 * 2026-09-09. Object-type words, the 12 regions, the larger municipalities and
 * the monuments an English-language caller is most likely to name.
 */
const LATIN_TERMS: Record<string, string> = {
  // object types
  church: 'ეკლესია', churches: 'ეკლესია', monastery: 'მონასტერი', monasteries: 'მონასტერი',
  fortress: 'ციხე', fort: 'ციხე', castle: 'ციხე', tower: 'კოშკი', towers: 'კოშკი',
  basilica: 'ბაზილიკა', cathedral: 'ტაძარი', temple: 'ტაძარი', chapel: 'სამლოცველო',
  house: 'საცხოვრებელი სახლი', dwelling: 'საცხოვრებელი სახლი', bridge: 'ხიდი',
  cemetery: 'სამაროვანი', burial: 'სამაროვანი', necropolis: 'სამაროვანი',
  cave: 'გამოქვაბული', bath: 'აბანო', baths: 'აბანო', mosque: 'მეჩეთი',
  synagogue: 'სინაგოგა', palace: 'სასახლე', theatre: 'თეატრი', theater: 'თეატრი',
  school: 'სკოლა', wall: 'გალავანი', mill: 'წისქვილი',
  // regions
  kakheti: 'კახეთი', imereti: 'იმერეთი', guria: 'გურია', adjara: 'აჭარა', ajara: 'აჭარა',
  abkhazia: 'აფხაზეთი', tbilisi: 'თბილისი',
  // municipalities / towns
  mtskheta: 'მცხეთა', kutaisi: 'ქუთაისი', batumi: 'ბათუმი', telavi: 'თელავი', gori: 'გორი',
  zugdidi: 'ზუგდიდი', rustavi: 'რუსთავი', poti: 'ფოთი', akhaltsikhe: 'ახალციხე',
  borjomi: 'ბორჯომი', sighnaghi: 'სიღნაღი', ambrolauri: 'ამბროლაური', ozurgeti: 'ოზურგეთი',
  khashuri: 'ხაშური', mestia: 'მესტია', ushguli: 'უშგული', shatili: 'შატილი',
  // named monuments
  svetitskhoveli: 'სვეტიცხოველი', gelati: 'გელათი', jvari: 'ჯვარი', vardzia: 'ვარძია',
  uplistsikhe: 'უფლისციხე', ananuri: 'ანანური', bagrati: 'ბაგრატი', alaverdi: 'ალავერდი',
  gareji: 'გარეჯი', narikala: 'ნარიყალა', nikortsminda: 'ნიკორწმინდა', katskhi: 'კაცხი',
};

/**
 * Multi-word Latin region names, matched before the single-token map so
 * "Samtskhe-Javakheti" resolves as one region rather than two loose tokens.
 */
const LATIN_REGIONS: Record<string, string> = {
  kakheti: 'კახეთი',
  'mtskheta-mtianeti': 'მცხეთა-მთიანეთი',
  tbilisi: 'თბილისი',
  'samegrelo-zemo svaneti': 'სამეგრელო-ზემო სვანეთი',
  'kvemo kartli': 'ქვემო ქართლი',
  'shida kartli': 'შიდა ქართლი',
  'samtskhe-javakheti': 'სამცხე-ჯავახეთი',
  imereti: 'იმერეთი',
  'racha-lechkhumi-kvemo svaneti': 'რაჭა-ლეჩხუმი-ქვემო სვანეთი',
  adjara: 'აჭარა',
  ajara: 'აჭარა',
  abkhazia: 'აფხაზეთი',
  guria: 'გურია',
};

/** Georgian -> English for the register's closed vocabularies, so a caller who
 *  cannot read the script still gets a legible `*_en` alongside the original. */
const GLOSS: Record<string, string> = {
  // status
  'კულტურული მემკვიდრეობის ძეგლი': 'listed cultural heritage monument',
  'კულტურული მემკვიდრეობის ობიექტი': 'cultural heritage object',
  'ობიექტი სტატუსის გარეშე': 'object without listed status',
  // category
  'ეროვნული': 'national significance',
  'ობიექტი/ძეგლი კატეგორიის გარეშე': 'object/monument without category',
  // world category
  'მსოფლიო მნიშვნელობის': 'world significance',
  'მსოფლიო მნიშვნელობის კატეგორიის გარეშე': 'without world-significance category',
  // physical state
  'კარგი': 'good', 'დამაკმაყოფილებელი': 'satisfactory', 'საშუალო': 'average',
  'ცუდი': 'poor', 'ძალიან ცუდი': 'very poor', 'დანგრეული': 'ruined',
  // classification
  'არქიტექტურის': 'architectural', 'არქეოლოგიური': 'archaeological',
  'ეთნოგრაფიული': 'ethnographic', 'მემორიალური': 'memorial', 'საინჟინრო': 'engineering',
  'ქალაქთმშენებლობის (ურბანული)': 'urban planning',
  'საბაღე-საპარკო ხელოვნებისა და ლანდშაფტური არქიტექტურის': 'garden/park and landscape architecture',
  // regions
  'კახეთი': 'Kakheti', 'მცხეთა-მთიანეთი': 'Mtskheta-Mtianeti', 'თბილისი': 'Tbilisi',
  'სამეგრელო-ზემო სვანეთი': 'Samegrelo-Zemo Svaneti', 'ქვემო ქართლი': 'Kvemo Kartli',
  'შიდა ქართლი': 'Shida Kartli', 'სამცხე-ჯავახეთი': 'Samtskhe-Javakheti',
  'იმერეთი': 'Imereti', 'რაჭა-ლეჩხუმი-ქვემო სვანეთი': 'Racha-Lechkhumi-Kvemo Svaneti',
  'აჭარა': 'Adjara', 'აფხაზეთი': 'Abkhazia', 'გურია': 'Guria',
};

const WORLD_SIGNIFICANCE = 'მსოფლიო მნიშვნელობის';

// ── SQL + arg helpers ───────────────────────────────────────────────────────

/** A Unicode-safe SQL literal. The `N` prefix is not optional here — without
 *  it every Georgian comparison matches zero rows and returns a clean 200. */
function sqlLit(v: string): string {
  return `N'${v.replace(/'/g, "''")}'`;
}

function sqlLike(field: string, v: string): string {
  return `${field} LIKE ${sqlLit(`%${v}%`)}`;
}

function isGeorgian(s: string): boolean {
  return /[Ⴀ-ჿ]/.test(s);
}

function strArg(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function numArg(v: unknown, dflt: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Epoch-milliseconds (how ArcGIS returns esriFieldTypeDate) -> ISO date. */
function isoDate(v: unknown): string | null {
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString().slice(0, 10);
}

function gloss(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return null;
  // Classification arrives comma-joined ("არქეოლოგიური,არქიტექტურის").
  const parts = s.split(',').map((p) => GLOSS[p.trim()]).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/**
 * Turn a caller's query into the Georgian terms actually searched. A Georgian
 * query is used verbatim. A Latin query is expanded through LATIN_TERMS token
 * by token; unmapped tokens are dropped rather than searched, because a Latin
 * token cannot match a Georgian column and keeping it would only ever subtract.
 */
function expandQuery(q: string): { terms: string[]; unmapped: string[] } {
  if (isGeorgian(q)) return { terms: [q], unmapped: [] };
  const lower = q.toLowerCase().trim();
  if (LATIN_REGIONS[lower]) return { terms: [LATIN_REGIONS[lower]], unmapped: [] };
  const terms: string[] = [];
  const unmapped: string[] = [];
  for (const tok of lower.split(/[^a-z]+/).filter(Boolean)) {
    const hit = LATIN_TERMS[tok];
    if (hit) {
      if (!terms.includes(hit)) terms.push(hit);
    } else if (!unmapped.includes(tok)) {
      unmapped.push(tok);
    }
  }
  return { terms, unmapped };
}

/** Latin place name -> the Georgian the register stores, for the structured
 *  region / municipality / settlement filters. Georgian passes through. */
function normalizePlace(v: string, kind: 'region' | 'other'): string {
  if (!v || isGeorgian(v)) return v;
  const lower = v.toLowerCase();
  if (kind === 'region' && LATIN_REGIONS[lower]) return LATIN_REGIONS[lower];
  return LATIN_TERMS[lower] ?? v;
}

// ── ArcGIS query plumbing ───────────────────────────────────────────────────

interface ArcgisFeature { attributes: Record<string, unknown>; geometry?: { x?: number; y?: number } }

async function arcgis(layer: string, params: Record<string, string>): Promise<{
  features: ArcgisFeature[]; count?: number; exceededTransferLimit?: boolean;
}> {
  const p = new URLSearchParams({ f: 'json', ...params });
  const url = `${layer}/query?${p}`;
  const res = await pwFetch(url);
  if (!res.ok) throw await httpError(res, 'Georgian Cultural Heritage Register');
  const body = (await res.json()) as {
    error?: { message?: string; details?: string[] };
    features?: ArcgisFeature[]; count?: number; exceededTransferLimit?: boolean;
  };
  // ArcGIS reports query errors inside a 200. Surfacing them as errors is the
  // difference between "your where clause is wrong" and a silent empty result.
  if (body.error) {
    const detail = [body.error.message, ...(body.error.details ?? [])].filter(Boolean).join(' — ');
    throw new Error(`Georgian Cultural Heritage Register rejected the query: ${detail || 'unknown error'}`);
  }
  return { features: body.features ?? [], count: body.count, exceededTransferLimit: body.exceededTransferLimit };
}

async function arcgisCount(layer: string, where: string): Promise<number | null> {
  const { count } = await arcgis(layer, { where, returnCountOnly: 'true' });
  return typeof count === 'number' ? count : null;
}

function queryUrl(layer: string, where: string): string {
  return `${layer}/query?where=${encodeURIComponent(where)}&outFields=*&f=json`;
}

function shapeMonument(a: Record<string, unknown>): Record<string, unknown> {
  const objectId = a.ImmovableObjectID as number | null;
  const lon = typeof a.XGr === 'number' && a.XGr !== 0 ? a.XGr : null;
  const lat = typeof a.YGr === 'number' && a.YGr !== 0 ? a.YGr : null;
  return {
    reg_num: a.RegNum ?? null,
    object_id: objectId,
    name: a.ObjectName ?? null,
    full_name: a.ObjectFullName ?? null,
    complex_name: a.ComplexObjectName ?? null,
    region: a.Region ?? null,
    region_en: gloss(a.Region),
    municipality: a.Municipality ?? null,
    settlement: a.Settlement ?? null,
    address: a.Address ?? null,
    category: a.CategoryName ?? null,
    category_en: gloss(a.CategoryName),
    status: a.StatusName ?? null,
    status_en: gloss(a.StatusName),
    classification: a.Classification ?? null,
    classification_en: gloss(a.Classification),
    world_category: a.WorldCategoryName ?? null,
    world_category_en: gloss(a.WorldCategoryName),
    period: a.Period ?? null,
    exact_date: a.ExactDate ?? null,
    date_range_from: a.DateRangeFrom ?? null,
    date_range_to: a.DateRangeTo ?? null,
    physical_state: a.PhysicalState ?? null,
    physical_state_en: gloss(a.PhysicalState),
    initial_function: a.InitialFunction ?? null,
    current_function: a.CurrentFunction ?? null,
    listing_status_date: isoDate(a.ListingStatusDate),
    listing_status_document_number: a.ListingStatusDocumentNumber ?? null,
    listings_registry_number: a.ListingsRegistryNumber ?? null,
    listing_category_date: isoDate(a.ListingCategoryDate),
    listing_category_document_number: a.ListingCategoryDocumentNumber ?? null,
    description: a.Description ?? null,
    latitude: lat,
    longitude: lon,
    elevation_m: typeof a.Elevation === 'number' && a.Elevation !== 0 ? a.Elevation : null,
    photo_url: a.PhotoAddress ?? null,
    portal_url: objectId != null ? `${PORTAL_OBJECT}${objectId}` : null,
    source_url: objectId != null ? queryUrl(L_MONUMENT, `ImmovableObjectID=${objectId}`) : null,
  };
}

/** Build the where clause shared by search and nearby. */
function monumentWhere(args: Record<string, unknown>): { where: string; applied: Record<string, unknown> } {
  const clauses: string[] = [];
  const applied: Record<string, unknown> = {};

  const q = strArg(args.query);
  if (q) {
    const { terms, unmapped } = expandQuery(q);
    if (terms.length) {
      const per = terms.map((t) => `(${TEXT_FIELDS.map((f) => sqlLike(f, t)).join(' OR ')})`);
      // Multiple mapped terms narrow (AND) — "tbilisi church" should mean both.
      clauses.push(`(${per.join(' AND ')})`);
    } else {
      // The caller asked for something and NOTHING survived translation. Dropping
      // the clause here would answer with the entire 20,706-row register, which
      // reads as a broad match rather than as a failure to understand the query.
      clauses.push('1=0');
      applied.query_unresolved = true;
    }
    applied.query_terms = terms;
    if (unmapped.length) applied.query_terms_unmapped = unmapped;
  }

  for (const [arg, field, kind] of [
    ['region', 'Region', 'region'],
    ['municipality', 'Municipality', 'other'],
    ['settlement', 'Settlement', 'other'],
  ] as const) {
    const v = strArg(args[arg]);
    if (!v) continue;
    const norm = normalizePlace(v, kind);
    clauses.push(sqlLike(field, norm));
    applied[arg] = norm;
  }

  for (const [arg, field] of [
    ['category', 'CategoryName'],
    ['status', 'StatusName'],
    ['classification', 'Classification'],
    ['physical_state', 'PhysicalState'],
    ['period', 'Period'],
  ] as const) {
    const v = strArg(args[arg]);
    if (!v) continue;
    clauses.push(sqlLike(field, v));
    applied[arg] = v;
  }

  if (args.world_significance_only === true) {
    clauses.push(`WorldCategoryName=${sqlLit(WORLD_SIGNIFICANCE)}`);
    applied.world_significance_only = true;
  }
  if (args.listed_only === true) {
    clauses.push(`StatusName LIKE ${sqlLit('%ძეგლი%')}`);
    applied.listed_only = true;
  }
  if (args.with_coordinates_only === true) {
    clauses.push('XGr IS NOT NULL AND XGr <> 0 AND YGr IS NOT NULL AND YGr <> 0');
    applied.with_coordinates_only = true;
  }

  return { where: clauses.length ? clauses.join(' AND ') : '1=1', applied };
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/** The one note every empty result carries — the register holds only Georgian
 *  script, so "no rows" is far more often a script problem than an absence. */
const EMPTY_HINT =
  'No rows matched. The register stores every name, place and category in Georgian script only — '
  + 'if you searched in Latin script, the term may not be in this pack\'s Latin→Georgian map. '
  + 'Call georgia_heritage_facets to list the exact Georgian values for region, municipality, '
  + 'settlement, category, status or classification, then filter on one of those.';

/** Says WHY it is empty when we know: an untranslatable query is a different
 *  failure from a filter that genuinely matched nothing, and conflating them
 *  sends the caller looking in the wrong place. */
function emptyNote(applied: Record<string, unknown>): string {
  if (applied.query_unresolved === true) {
    const toks = (applied.query_terms_unmapped as string[] | undefined) ?? [];
    return `None of the query terms${toks.length ? ` (${toks.join(', ')})` : ''} could be translated into `
      + 'the Georgian script the register stores, so no search was run — this is NOT evidence that nothing '
      + 'matches. Re-run with the Georgian term, or call georgia_heritage_facets to read the exact stored '
      + 'values for region, municipality, settlement, category, status or classification.';
  }
  return EMPTY_HINT;
}

// ── Tools ───────────────────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'georgia_heritage_search',
    description:
      'Search the National Register of Immovable Cultural Heritage of Georgia — the country in the Caucasus (საქართველო), NOT the US state. '
      + '20,706 monuments and heritage objects (churches, monasteries, fortresses, Svan towers, archaeological sites, listed houses and bridges) '
      + 'published by the National Agency for Cultural Heritage Preservation of Georgia. Filter by free text, region, municipality, settlement, '
      + 'category, listing status, classification or physical state. Returns the true total (not just the page), the registry number (RegNum), '
      + 'the stable ImmovableObjectID, WGS84 coordinates, the listing decree number and date, and a source_url plus portal_url per record. '
      + 'The register is Georgian-script only; common English terms and place names ("church", "Tbilisi", "Svetitskhoveli") are translated '
      + 'automatically and the Georgian terms actually searched come back in query_terms.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free text over object name, settlement, address and description. Georgian script is used verbatim; English is translated where known (e.g. "monastery" → მონასტერი).' },
        region: { type: 'string', description: 'Region, Georgian or English (e.g. "Kakheti", "Samtskhe-Javakheti", "კახეთი").' },
        municipality: { type: 'string', description: 'Municipality, Georgian or English (e.g. "Mtskheta", "მცხეთა").' },
        settlement: { type: 'string', description: 'Settlement / village name.' },
        category: { type: 'string', description: 'CategoryName value, e.g. "ეროვნული" (national significance). Use georgia_heritage_facets to list them.' },
        status: { type: 'string', description: 'StatusName value, e.g. "კულტურული მემკვიდრეობის ძეგლი" (listed monument).' },
        classification: { type: 'string', description: 'Classification value, e.g. "არქეოლოგიური" (archaeological), "არქიტექტურის" (architectural).' },
        physical_state: { type: 'string', description: 'PhysicalState value, e.g. "დანგრეული" (ruined), "კარგი" (good).' },
        period: { type: 'string', description: 'Substring of the Period field, e.g. "მე-19 ს." for the 19th century.' },
        listed_only: { type: 'boolean', description: 'Only objects that carry monument status (excludes the ~10,800 recorded objects with no listed status).' },
        world_significance_only: { type: 'boolean', description: 'Only the 87 objects categorised as of world significance (მსოფლიო მნიშვნელობის).' },
        with_coordinates_only: { type: 'boolean', description: 'Only records that carry usable WGS84 coordinates.' },
        limit: { type: 'number', description: 'Records per page, 1-200 (default 25).' },
        offset: { type: 'number', description: 'Pagination offset into the full result set (default 0).' },
      },
    },
  },
  {
    name: 'georgia_heritage_object',
    description:
      'Full register record for one Georgian (country) cultural-heritage object, by its registry number (reg_num / RegNum) or its stable '
      + 'ImmovableObjectID. Returns the description, dating, initial and current function, physical state, the listing decree number and date, '
      + 'coordinates, photo URL, and how many physical and visual protection zones the agency has drawn around it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reg_num: { type: 'string', description: 'Registry number as printed in the register, e.g. "4". RegNum is null for objects recorded but not yet numbered — use object_id for those.' },
        object_id: { type: 'number', description: 'ImmovableObjectID — the stable upstream identifier, present on every record. Prefer this for anything you store.' },
      },
    },
  },
  {
    name: 'georgia_heritage_nearby',
    description:
      'Cultural-heritage monuments near a point in Georgia (the country), by latitude/longitude and radius. Returns each object with its '
      + 'straight-line distance in metres from the register\'s recorded point, nearest first — for "what heritage is around this village / '
      + 'trailhead / development site".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        latitude: { type: 'number', description: 'WGS84 latitude, e.g. 41.8458 (Mtskheta).' },
        longitude: { type: 'number', description: 'WGS84 longitude, e.g. 44.7194.' },
        radius_m: { type: 'number', description: 'Search radius in metres, 50-50000 (default 2000).' },
        limit: { type: 'number', description: 'Max monuments, 1-200 (default 25).' },
      },
      required: ['latitude', 'longitude'],
    },
  },
  {
    name: 'georgia_heritage_facets',
    description:
      'List the distinct values, with record counts, that the Georgian (country) heritage register actually uses for a field — region, '
      + 'municipality, settlement, category, status, classification, physical_state, current_function, world_category or period. '
      + 'This is the discovery step for a register written entirely in Georgian script: read the exact stored value here, then pass it to '
      + 'georgia_heritage_search.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        field: { type: 'string', description: 'One of: region, municipality, settlement, category, status, classification, physical_state, current_function, world_category, period.' },
        region: { type: 'string', description: 'Optional: restrict the facet to one region (Georgian or English).' },
        municipality: { type: 'string', description: 'Optional: restrict the facet to one municipality (Georgian or English).' },
        limit: { type: 'number', description: 'Max distinct values, 1-500 (default 50), most frequent first.' },
      },
      required: ['field'],
    },
  },
  {
    name: 'georgia_heritage_museums',
    description:
      'Museums registered by the National Agency for Cultural Heritage Preservation of Georgia (the country): name, region, municipality, '
      + 'address, coordinates, and the visitor contact details, opening hours and ticket price the agency publishes for each.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free text over museum name and address (Georgian, or English where mapped).' },
        region: { type: 'string', description: 'Region, Georgian or English.' },
        municipality: { type: 'string', description: 'Municipality, Georgian or English.' },
        limit: { type: 'number', description: 'Max museums, 1-100 (default 50).' },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'georgia_heritage_search': {
      const limit = clamp(Math.trunc(numArg(args.limit, 25)), 1, 200);
      const offset = Math.max(0, Math.trunc(numArg(args.offset, 0)));
      const { where, applied } = monumentWhere(args);

      const [total, page] = await Promise.all([
        arcgisCount(L_MONUMENT, where),
        arcgis(L_MONUMENT, {
          where,
          outFields: MONUMENT_FIELDS,
          returnGeometry: 'false',
          orderByFields: 'OBJECTID ASC',
          resultOffset: String(offset),
          resultRecordCount: String(limit),
        }),
      ]);

      const results = page.features.map((f) => shapeMonument(f.attributes));
      return {
        register: 'National Register of Immovable Cultural Heritage of Georgia (the country)',
        total,
        count: results.length,
        offset,
        next_offset: total != null && offset + results.length < total ? offset + results.length : null,
        filters: applied,
        results,
        ...(results.length === 0 ? { note: emptyNote(applied) } : {}),
        source_url: queryUrl(L_MONUMENT, where),
      };
    }

    case 'georgia_heritage_object': {
      const regNum = strArg(args.reg_num);
      const objectId = args.object_id != null ? Math.trunc(numArg(args.object_id, NaN)) : NaN;
      if (!regNum && !Number.isFinite(objectId)) {
        throw new Error('georgia_heritage_object requires reg_num or object_id.');
      }
      const where = Number.isFinite(objectId)
        ? `ImmovableObjectID=${objectId}`
        : `RegNum=${sqlLit(regNum)}`;

      const { features } = await arcgis(L_MONUMENT, {
        where, outFields: MONUMENT_FIELDS, returnGeometry: 'false', resultRecordCount: '5',
      });
      if (!features.length) {
        return {
          found: false,
          lookup: Number.isFinite(objectId) ? { object_id: objectId } : { reg_num: regNum },
          note: 'No object with that identifier. RegNum is null for many recorded objects — search by name or place with '
            + 'georgia_heritage_search and use the object_id it returns.',
          source_url: queryUrl(L_MONUMENT, where),
        };
      }

      const object = shapeMonument(features[0].attributes);
      const id = object.object_id as number | null;
      let zones: Record<string, unknown> | null = null;
      if (id != null) {
        const [physical, visual] = await Promise.all([
          arcgisCount(L_ZONE_PHYSICAL, `ImmovableObjectID=${id}`),
          arcgisCount(L_ZONE_VISUAL, `ImmovableObjectID=${id}`),
        ]);
        zones = {
          physical_protection_zones: physical,
          visual_protection_zones: visual,
          source_url: queryUrl(L_ZONE_PHYSICAL, `ImmovableObjectID=${id}`),
        };
      }

      return {
        found: true,
        object,
        protection_zones: zones,
        // One RegNum can carry several boundary polygons (a complex recorded in
        // parts). Say so rather than silently returning the first.
        additional_boundary_records: features.length - 1,
        source_url: queryUrl(L_MONUMENT, where),
      };
    }

    case 'georgia_heritage_nearby': {
      const lat = numArg(args.latitude, NaN);
      const lon = numArg(args.longitude, NaN);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new Error('georgia_heritage_nearby requires numeric latitude and longitude (WGS84).');
      }
      const radius = clamp(numArg(args.radius_m, 2000), 50, 50000);
      const limit = clamp(Math.trunc(numArg(args.limit, 25)), 1, 200);

      const { features } = await arcgis(L_MONUMENT, {
        where: '1=1',
        geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
        geometryType: 'esriGeometryPoint',
        inSR: '4326',
        distance: String(radius),
        units: 'esriSRUnit_Meter',
        spatialRel: 'esriSpatialRelIntersects',
        outFields: MONUMENT_FIELDS,
        returnGeometry: 'false',
        // Over-fetch so the distance sort below ranks the whole neighbourhood,
        // not just the first `limit` rows ArcGIS happened to return.
        resultRecordCount: String(Math.max(limit * 4, 100)),
      });

      const results = features
        .map((f) => shapeMonument(f.attributes))
        .map((m) => {
          const mlat = m.latitude as number | null;
          const mlon = m.longitude as number | null;
          return {
            ...m,
            distance_m: mlat != null && mlon != null ? haversineM(lat, lon, mlat, mlon) : null,
          };
        })
        .sort((a, b) => (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity))
        .slice(0, limit);

      return {
        center: { latitude: lat, longitude: lon },
        radius_m: radius,
        count: results.length,
        results,
        // The spatial filter runs against each object's boundary polygon; the
        // distance is measured to the register's recorded point for that
        // object, so a large site can report a distance beyond the radius.
        distance_note: 'distance_m is measured from the register\'s recorded point for the object, while the radius filter tests its boundary polygon.',
        ...(results.length === 0 ? { note: `No registered heritage object within ${radius} m of that point. Widen radius_m, or check the coordinates are in Georgia (roughly 41.0–43.6 N, 40.0–46.7 E).` } : {}),
        source_url: `${L_MONUMENT}/query?where=1%3D1&geometryType=esriGeometryPoint&inSR=4326&distance=${radius}&units=esriSRUnit_Meter&geometry=${encodeURIComponent(JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }))}&outFields=*&f=json`,
      };
    }

    case 'georgia_heritage_facets': {
      const key = strArg(args.field).toLowerCase();
      const field = FACET_FIELDS[key];
      if (!field) {
        throw new Error(`Unknown field "${strArg(args.field)}". Supported: ${Object.keys(FACET_FIELDS).join(', ')}.`);
      }
      const limit = clamp(Math.trunc(numArg(args.limit, 50)), 1, 500);
      const { where, applied } = monumentWhere({ region: args.region, municipality: args.municipality });

      const { features } = await arcgis(L_MONUMENT, {
        where,
        groupByFieldsForStatistics: field,
        outStatistics: JSON.stringify([{ statisticType: 'count', onStatisticField: 'OBJECTID', outStatisticFieldName: 'cnt' }]),
        orderByFields: 'cnt DESC',
      });

      const values = features
        .map((f) => ({
          value: f.attributes[field] ?? null,
          value_en: gloss(f.attributes[field]),
          count: f.attributes.cnt ?? null,
        }))
        .slice(0, limit);

      return {
        field: key,
        upstream_field: field,
        filters: applied,
        distinct_values: features.length,
        count: values.length,
        values,
        ...(values.length === 0 ? { note: emptyNote(applied) } : {}),
        source_url: queryUrl(L_MONUMENT, where),
      };
    }

    case 'georgia_heritage_museums': {
      const limit = clamp(Math.trunc(numArg(args.limit, 50)), 1, 100);
      const clauses: string[] = [];
      const applied: Record<string, unknown> = {};

      const q = strArg(args.query);
      if (q) {
        const { terms, unmapped } = expandQuery(q);
        if (terms.length) {
          clauses.push(`(${terms.map((t) => `(${sqlLike('Name', t)} OR ${sqlLike('Address', t)} OR ${sqlLike('Settlement', t)})`).join(' AND ')})`);
        } else {
          // Same reason as in monumentWhere: an untranslatable query must not
          // silently widen to every museum.
          clauses.push('1=0');
          applied.query_unresolved = true;
        }
        applied.query_terms = terms;
        if (unmapped.length) applied.query_terms_unmapped = unmapped;
      }
      for (const [arg, field, kind] of [['region', 'Region', 'region'], ['municipality', 'Municipality', 'other']] as const) {
        const v = strArg(args[arg]);
        if (!v) continue;
        const norm = normalizePlace(v, kind);
        clauses.push(sqlLike(field, norm));
        applied[arg] = norm;
      }
      const where = clauses.length ? clauses.join(' AND ') : '1=1';

      const [total, page] = await Promise.all([
        arcgisCount(L_MUSEUM, where),
        arcgis(L_MUSEUM, {
          where,
          outFields: 'MuseumID,Name,Region,Municipality,Settlement,Address,Email,Phone,MobPhone,WorkDayAndHours,TicketPrice,X,Y,PhotoAddress',
          returnGeometry: 'false',
          orderByFields: 'MuseumID ASC',
          resultRecordCount: String(limit),
        }),
      ]);

      const results = page.features.map((f) => {
        const a = f.attributes;
        return {
          museum_id: a.MuseumID ?? null,
          name: a.Name ?? null,
          region: a.Region ?? null,
          region_en: gloss(a.Region),
          municipality: a.Municipality ?? null,
          settlement: a.Settlement ?? null,
          address: a.Address ?? null,
          email: a.Email ?? null,
          phone: a.Phone ?? null,
          mobile_phone: a.MobPhone ?? null,
          opening_hours: a.WorkDayAndHours ?? null,
          ticket_price: a.TicketPrice ?? null,
          latitude: typeof a.Y === 'number' && a.Y !== 0 ? a.Y : null,
          longitude: typeof a.X === 'number' && a.X !== 0 ? a.X : null,
          photo_url: a.PhotoAddress ?? null,
        };
      });

      return {
        total,
        count: results.length,
        filters: applied,
        results,
        ...(results.length === 0 ? { note: emptyNote(applied) } : {}),
        source_url: queryUrl(L_MUSEUM, where),
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
