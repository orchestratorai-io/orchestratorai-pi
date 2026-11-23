/**
 * Report guards: the calibrated rubrics run over a workflow's finished output.
 *
 * A guard is deterministic code around the decision model. The code splits the
 * report (or the source folder) into items - a checkable statement, a checklist
 * finding, a document, a signal, a coaching note - asks Clef the rubric's
 * questions about each item, and combines the routed decisions: the most severe
 * one wins. No chat model reads, copies or summarises the text along the way,
 * which is what made the first, prompt-only attempts unreliable on a local model.
 *
 * Kept free of the Pi extension API so the case runner and tests can load it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { runRubric, type DecisionClient, type Rubric, type RubricResult } from "./decisions/index.ts";

export type Decision = "pass" | "review" | "block";
export const GUARDS = ["citations", "severity", "privilege", "signals", "coaching"] as const;
export type GuardName = (typeof GUARDS)[number];

const RANK: Record<Decision, number> = { pass: 0, review: 1, block: 2 };
const worst = (ds: Decision[]): Decision => ds.reduce<Decision>((a, d) => (RANK[d] > RANK[a] ? d : a), "pass");

export interface Doc { name: string; text: string }
export interface ItemResult { item: string; decision: Decision; reason: string; result?: RubricResult; error?: string }
export interface GuardResult { guard: GuardName; rubric: string; decision: Decision; reason: string; items: ItemResult[] }

// ------------------------------------------------------------------ text helpers

const TEXT_EXT = /\.(md|markdown|txt|text)$/i;

/** Read files and folders (recursively) as plain-text documents. Names are relative to baseDir. */
export function loadDocs(paths: string[], baseDir: string, maxFiles = 200): Doc[] {
  const out: Doc[] = [];
  const seen = new Set<string>();
  const add = (full: string) => {
    if (out.length >= maxFiles || seen.has(full)) return;
    seen.add(full);
    out.push({ name: path.relative(baseDir, full) || path.basename(full), text: fs.readFileSync(full, "utf8") });
  };
  const walk = (full: string) => {
    for (const e of fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".")) continue;
      if (/^readme\.(md|markdown|txt)$/i.test(e.name)) continue; // describes the folder; not one of its documents
      const child = path.join(full, e.name);
      if (e.isDirectory()) walk(child);
      else if (TEXT_EXT.test(e.name)) add(child);
    }
  };
  for (const p of paths) {
    if (!p || !p.trim()) continue;
    const full = path.resolve(baseDir, p.trim());
    if (!fs.existsSync(full)) throw new Error(`record path not found: ${p}`);
    if (fs.statSync(full).isDirectory()) walk(full);
    else add(full);
  }
  return out;
}

export interface Section { heading: string; body: string }

/** Split Markdown into sections at every heading. The text before the first heading has heading "". */
export function sections(md: string): Section[] {
  const out: Section[] = [{ heading: "", body: "" }];
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^#{1,6}\s+(.*)$/.exec(line);
    if (h) out.push({ heading: h[1].trim(), body: "" });
    else out[out.length - 1].body += line + "\n";
  }
  return out;
}

// Word-bounded, so "Verified authorities" does not also match "Unverified authorities".
const headingMatches = (heading: string, names: string[]) =>
  names.some((n) => new RegExp(`(^|[^a-z0-9])${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(heading.toLowerCase().replace(/[*_`]/g, "")));

/** The text of the sections whose heading contains one of `include` (all when empty), minus those matching `skip`. */
export function selectSections(md: string, include: string[] = [], skip: string[] = []): string {
  // A skipped heading hides its whole subtree: track the level that started the skip.
  const lines = md.split("\n");
  const out: string[] = [];
  let skipLevel = 0, includeLevel = include.length ? 0 : -1, fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length, heading = h[2];
      if (skipLevel && level <= skipLevel) skipLevel = 0;
      if (includeLevel > 0 && level <= includeLevel) includeLevel = 0;
      if (!skipLevel && skip.length && headingMatches(heading, skip)) skipLevel = level;
      if (includeLevel === 0 && include.length && headingMatches(heading, include)) includeLevel = level;
    }
    if (!skipLevel && includeLevel !== 0) out.push(line);
  }
  return out.join("\n");
}

const MONTH = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;

/** A rough priority: statements carrying the details that get invented most often come first. */
function specificity(s: string): number {
  let p = 0;
  if (MONTH.test(s) && /\d/.test(s)) p += 4;
  if (/\b(19|20)\d\d\b/.test(s)) p += 3;
  if (/[$€£]\s?\d|\d\s?%|\bpercent\b/i.test(s)) p += 3;
  if (/§|\bs\.\s?\d|\b(section|clause|article|art\.|rule|exhibit|schedule)\s+[\dA-Z]/i.test(s)) p += 2;
  if (/\bv\.?\s+[A-Z]/.test(s)) p += 2; // case names
  if (/"[^"]{6,}"|“[^”]{6,}”/.test(s)) p += 2;
  if (/\d/.test(s)) p += 1;
  return p;
}

// Abbreviations that end with a period but do not end a sentence.
const ABBREV = /\b(inc|ltd|llc|llp|co|corp|plc|no|nos|s|ss|sec|art|arts|para|cl|v|vs|e\.g|i\.e|u\.s|u\.k|st|mr|ms|mrs|dr|jr|sr|approx|cf|fig|p|pp)\.$/i;

/** Split prose into sentences without breaking after "Inc." or "s." or before a parenthesis. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?]["”')\]]?\s+(?=[A-Z"“\[])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].trimEnd().length;
    if (ABBREV.test(text.slice(Math.max(start, m.index - 8), m.index + 1))) continue;
    out.push(text.slice(start, end).trim());
    start = m.index + m[0].length;
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

/** Statements about the workflow's own process (its gates, this report), which no record contains. */
const PROCESS = /\b(attorney gate|gate\s*\d|gates?\s+(approved|decision)|click-through|ct-\d{6,}|this (report|review|run|memo|digest|package|simulation)|reviewer decision|checkpoint)\b/i;

/** Strip Markdown decoration from one line so a statement reads as prose. */
function plain(line: string): string {
  return line
    .replace(/^\s*>+\s?/, "")
    .replace(/^\s*([-*+]|\d+[.)])\s+/, "")
    .replace(/^\[[ xX]?\]\s*/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
}

/**
 * The statements in a report that can be checked against a record: sentences carrying
 * a date, figure, section, case name or quotation. Headings, tables' rule lines and code
 * are skipped; table rows become one statement. At most `max`, the most specific first,
 * returned in document order.
 */
export function extractClaims(md: string, max = 10): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  let fence = false;
  for (const raw of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
    if (fence || /^\s*#/.test(raw) || /^\s*\|?\s*:?-{3,}/.test(raw) || !raw.trim()) continue;
    const line = raw.includes("|") && raw.trim().startsWith("|")
      ? raw.split("|").map((c) => plain(c)).filter(Boolean).join("; ")
      : plain(raw);
    // A checklist item's own severity label is the report's judgment, not a statement about the record.
    const body = line.replace(/^\[?(CRITICAL|HIGH|MEDIUM|LOW)\]?\s*[—–:\-]+\s*/, "");
    for (const s of splitSentences(body)) {
      const t = s.trim();
      if (t.length < 30 || t.length > 500) continue;
      if (/:\s*$/.test(t) || t.split(/\s+/).length < 6) continue; // a label or heading fragment, not a statement
      if (PROCESS.test(t)) continue; // about this run's own review steps, not about the record
      if (/\?\s*[)"”]?\s*$/.test(t)) continue; // a question asks; it does not state anything
      if (specificity(t) === 0) continue;
      const key = t.toLowerCase().replace(/\W+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(t);
    }
  }
  if (found.length <= max) return found;
  const ranked = found.map((t, i) => ({ t, i, p: specificity(t) })).sort((a, b) => b.p - a.p || a.i - b.i).slice(0, max);
  return ranked.sort((a, b) => a.i - b.i).map((r) => r.t);
}

const STOP = new Set("that this with from have were which their there would should could about under into over than then they them these those been being shall must will also only such other each where when what".split(" "));
const words = (s: string) => (s.toLowerCase().match(/[a-z0-9][a-z0-9.'-]{2,}/g) ?? []).filter((w) => !STOP.has(w));

/** Split a document into chunks of about `size` characters at paragraph breaks (hard-split very long paragraphs). */
function chunks(text: string, size = 1500): string[] {
  const out: string[] = [];
  let cur = "";
  for (const para of text.split(/\n\s*\n/)) {
    const pieces = para.length > size ? para.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? [] : [para];
    for (const p of pieces) {
      if (cur && cur.length + p.length > size) { out.push(cur); cur = ""; }
      cur += (cur ? "\n\n" : "") + p;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * The record text to check one claim against: all of it when it fits the budget, else the chunks
 * that share the most terms with the claim (numbers count double), kept in document order.
 * Small budgets matter: Clef reads the whole record for every statement.
 */
export function pickRecord(claim: string, docs: Doc[], budget = 8_000): string {
  const block = (d: Doc) => `=== ${d.name} ===\n${d.text.trim()}\n`;
  const all = docs.map(block).join("\n");
  if (all.length <= budget) return all;
  const terms = new Set(words(claim));
  const parts = docs.flatMap((d, di) => chunks(d.text).map((text, ci) => ({ d, di, ci, text })));
  const scored = parts.map((p) => {
    const hay = (p.d.name + " " + p.text).toLowerCase();
    let s = 0;
    for (const t of terms) if (hay.includes(t)) s += /\d/.test(t) ? 2 : 1;
    return { ...p, s };
  }).sort((a, b) => b.s - a.s || a.di - b.di || a.ci - b.ci);
  const chosen: typeof scored = [];
  let used = 0;
  for (const p of scored) {
    const cost = p.text.length + p.d.name.length + 10;
    if (used + cost > budget) continue;
    chosen.push(p);
    used += cost;
  }
  chosen.sort((a, b) => a.di - b.di || a.ci - b.ci);
  let out = "", last = "";
  for (const p of chosen) {
    if (p.d.name !== last) { out += `${out ? "\n" : ""}=== ${p.d.name} (excerpts) ===\n`; last = p.d.name; }
    out += p.text.trim() + "\n…\n";
  }
  return out;
}

export type Severity = "HIGH" | "MEDIUM" | "LOW";
const SEV_RANK: Record<Severity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/** Checklist findings: `- [ ] SEVERITY — issue; action`. CRITICAL counts as HIGH. */
export function extractFindings(md: string): Array<{ severity: Severity; text: string }> {
  const out: Array<{ severity: Severity; text: string }> = [];
  for (const line of md.split("\n")) {
    const m = /^\s*[-*]\s*\[[ xX]?\]\s*\**\s*\[?(CRITICAL|HIGH|MEDIUM|LOW)\]?\s*\**\s*[—–:\-]+\s*(.+)$/.exec(line);
    if (m) out.push({ severity: (m[1] === "CRITICAL" ? "HIGH" : m[1]) as Severity, text: plain(m[2]) });
  }
  return out;
}

/** Coaching blocks: each bullet or paragraph of the given text. */
export function extractBlocks(md: string, minLength = 40): string[] {
  const out: string[] = [];
  let cur = "";
  const flush = () => { const t = cur.trim(); if (t.length >= minLength) out.push(t); cur = ""; };
  for (const raw of md.split("\n")) {
    if (/^\s*#/.test(raw)) { flush(); continue; }
    if (!raw.trim()) { flush(); continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(raw)) flush();
    cur += plain(raw) + " ";
  }
  flush();
  return out;
}

/** Ways a report may name a source document: its file name, its stem, and its first heading. */
function docNames(d: Doc): string[] {
  const base = path.basename(d.name);
  const stem = base.replace(/\.[^.]+$/, "");
  const names = [base, stem, stem.replace(/[-_]+/g, " ")];
  const h = /^#{1,6}\s+(.+)$/m.exec(d.text);
  // A title is only a usable name when it is long enough to be specific ("Email" would match everything).
  const title = h?.[1].replace(/[*_`]/g, "").trim();
  return [...names.filter((n) => n.length >= 4), ...(title && title.length >= 12 ? [title] : [])];
}
/**
 * Lines of a section grouped by the sub-label they sit under. A report often splits one section into
 * labelled lists ("Withheld:", "**Deduplicated:**"); a line's own words count too.
 */
export function mentionedUnder(section: string, d: Doc, label: RegExp): { mentioned: boolean; underLabel: boolean; outsideLabel: boolean } {
  let state = false, mentioned = false, underLabel = false, outsideLabel = false;
  for (const line of section.split("\n")) {
    const bare = line.replace(/[*_`]/g, "").trim();
    // A label: a heading, a short line ending in ":", or a bullet that is bold and nothing else.
    const boldBullet = /^[-*+]\s+\*\*[^*]+\*\*\s*:?\s*$/.test(line.trim());
    const isLabel = boldBullet || (/^(#{1,6}\s+.*|[^-*+\d|].{0,80}:|.{0,80}:\s*$)$/.test(bare) && !/^[-*+]\s/.test(line.trim()));
    if (isLabel) state = label.test(bare);
    if (!mentions(line, d)) continue;
    mentioned = true;
    if (state || label.test(bare)) underLabel = true;
    else outsideLabel = true;
  }
  return { mentioned, underLabel, outsideLabel };
}

export function mentions(text: string, d: Doc): boolean {
  const hay = text.toLowerCase().replace(/[-_]+/g, " ");
  return docNames(d).some((n) => hay.includes(n.toLowerCase().replace(/[-_]+/g, " ")));
}


const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MON = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const pad = (n: number) => String(n).padStart(2, "0");
const mon = (m: string) => pad(MONTHS.indexOf(m.slice(0, 3).toLowerCase()) + 1);

/**
 * Calendar dates in a text, normalised: "2024-03-03" for a full date, "2024-03" for a month and year.
 * Bare years are left out: "two 2025 sub-processors" is not a date claim.
 */
export function datesIn(text: string): Set<string> {
  const out = new Set<string>();
  const t = text.replace(/ /g, " ");
  let m: RegExpExecArray | null;
  const mdy = new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+((?:19|20)\\d\\d)\\b`, "gi");
  while ((m = mdy.exec(t))) out.add(`${m[3]}-${mon(m[1])}-${pad(+m[2])}`);
  const dmy = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON},?\\s+((?:19|20)\\d\\d)\\b`, "gi");
  while ((m = dmy.exec(t))) out.add(`${m[3]}-${mon(m[2])}-${pad(+m[1])}`);
  const iso = /\b((?:19|20)\d\d)-(\d\d)-(\d\d)\b/g;
  while ((m = iso.exec(t))) out.add(`${m[1]}-${m[2]}-${m[3]}`);
  // A range ("February – March 2026", "Feb-June 2026") states its first month too.
  const range = new RegExp(`\\b${MON}\\s*(?:[–—-]|to|through)\\s*${MON},?\\s+((?:19|20)\\d\\d)\\b`, "gi");
  while ((m = range.exec(t))) { out.add(`${m[3]}-${mon(m[1])}`); out.add(`${m[3]}-${mon(m[2])}`); }
  const my = new RegExp(`\\b${MON},?\\s+((?:19|20)\\d\\d)\\b`, "gi");
  while ((m = my.exec(t))) out.add(`${m[2]}-${mon(m[1])}`);
  return out;
}

/** Dates the claim states that the record never does. A month-and-year is found by any date in that month. */
export function missingDates(claim: string, record: string): string[] {
  const have = datesIn(record);
  const months = new Set([...have].map((d) => d.slice(0, 7)));
  const stated = [...datesIn(claim)];
  const fullMonths = new Set(stated.filter((d) => d.length === 10).map((d) => d.slice(0, 7)));
  return stated.filter((d) => (d.length === 10 ? !have.has(d) : !fullMonths.has(d) && !months.has(d)));
}

/**
 * One statement against the record: the citation-in-record rubric, plus a code check for
 * calendar dates. Clef reliably catches an invented date against a short record but, given a
 * whole diligence record full of other dates, rated the deal memo's invented review date as
 * supported. A date that appears nowhere in the record is a fact the code can check exactly.
 */
export async function checkClaim(client: DecisionClient, rubric: Rubric, claim: string, record: string, fullRecord = record): Promise<{ decision: Decision; reason: string; result: RubricResult }> {
  const result = await runRubric(client, rubric, { claim, record });
  const fact = result.answers.asserts_fact;
  const isFact = !fact || fact.type !== "noul" || fact.noul >= 0.5;
  // Dates are checked against the whole record, not the excerpt the model was shown.
  const missing = isFact ? missingDates(claim, fullRecord) : [];
  if (missing.length && result.decision !== "block") {
    return { decision: "block", reason: `states a date the record does not (${missing.join(", ")})`, result: { ...result, decision: "block" } };
  }
  return { decision: result.decision, reason: result.reason, result };
}

// ------------------------------------------------------------------ guards

const clip = (s: string, n = 140) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const quoteList = (items: ItemResult[], n = 5) =>
  items.slice(0, n).map((i) => `"${clip(i.item)}"`).join("; ") + (items.length > n ? `; and ${items.length - n} more` : "");

export interface GuardContext {
  client: DecisionClient;
  rubrics: Map<string, Rubric>;
  /** Called after each item, e.g. to record the evaluation in the store. */
  onItem?: (rubric: Rubric, item: ItemResult, preview: string) => void;
}

/**
 * One rubric call. `record` false when the guard maps the rubric's answer to its own decision
 * first (severity, privilege, signals): the store must show the guard's decision, not the raw
 * one, or a HIGH finding that is correctly graded HIGH shows up as a red "block".
 */
async function ask(ctx: GuardContext, rubric: Rubric, item: string, inputs: string | Record<string, unknown>, record = true): Promise<ItemResult> {
  let r: ItemResult;
  try {
    const result = await runRubric(ctx.client, rubric, inputs);
    r = { item, decision: result.decision, reason: result.reason, result };
  } catch (e) {
    // Fail closed, but to a person rather than to a block: an unreachable model is not evidence about the text.
    r = { item, decision: "review", reason: "decision model unavailable", error: (e as Error).message };
  }
  if (record || r.error) ctx.onItem?.(rubric, r, item);
  return r;
}

function need(ctx: GuardContext, name: string): Rubric {
  const r = ctx.rubrics.get(name);
  if (!r) throw new Error(`rubric '${name}' is not installed`);
  return r;
}

const unavailable = (items: ItemResult[]) => items.filter((i) => i.error).length;
const outage = (items: ItemResult[]) => {
  const n = unavailable(items);
  return n ? ` The decision model could not be reached for ${n} item${n === 1 ? "" : "s"}, so a person must check ${n === 1 ? "it" : "them"}.` : "";
};

export interface CitationOptions {
  include?: string[];
  skip?: string[];
  maxClaims?: number;
  budget?: number;
  /**
   * "review" where the record is not expected to hold everything the report may say (legal research
   * draws on general law, the knowledge folder is only what the firm has): a statement missing from the
   * record is unverified, not invented. Statements in `strict` sections (where the report itself claims
   * they are verified) still block.
   */
  unsupported?: "block" | "review";
  strict?: string[];
}

/** citation-in-record over each checkable statement in the report. */
export async function citationGuard(ctx: GuardContext, report: string, record: Doc[], opts: CitationOptions = {}): Promise<GuardResult> {
  const rubric = need(ctx, "citation-in-record");
  const strict = opts.strict?.length ? extractClaims(selectSections(report, opts.strict), opts.maxClaims ?? 10) : [];
  const rest = extractClaims(selectSections(report, opts.include, [...(opts.skip ?? []), ...(opts.strict ?? [])]), opts.maxClaims ?? 10);
  // Strict statements first: they are the ones the report vouches for.
  const claims = [...strict, ...rest.filter((c) => !strict.includes(c))].slice(0, Math.max(opts.maxClaims ?? 10, strict.length));
  const lenient = opts.unsupported === "review";
  if (!record.length) return { guard: "citations", rubric: rubric.name, decision: "review", reason: "No record was found to check the report against.", items: [] };
  if (!claims.length) return { guard: "citations", rubric: rubric.name, decision: "pass", reason: "The report makes no dated, numbered or quoted statements to check.", items: [] };
  const fullText = record.map((d) => d.text).join("\n");
  const items: ItemResult[] = [];
  for (const claim of claims) {
    const rec = pickRecord(claim, record, opts.budget);
    let item: ItemResult;
    try {
      const r = await checkClaim(ctx.client, rubric, claim, rec, fullText);
      item = { item: claim, decision: r.decision, reason: r.reason, result: r.result };
      // A calendar date missing from the record stays a block even here: a specific date stated from
      // memory is how invented authorities show up, and it is cheap to verify before relying on it.
      if (lenient && item.decision === "block" && !strict.includes(claim) && !r.reason.startsWith("states a date")) {
        item = { ...item, decision: "review", reason: `unverified: ${r.reason}` };
      }
    } catch (e) {
      item = { item: claim, decision: "review", reason: "decision model unavailable", error: (e as Error).message };
    }
    ctx.onItem?.(rubric, item, claim);
    items.push(item);
  }
  const blocked = items.filter((i) => i.decision === "block" && !i.error);
  const unverified = items.filter((i) => i.reason.startsWith("unverified:"));
  const reviewed = items.filter((i) => i.decision === "review" && !i.error && !i.reason.startsWith("unverified:"));
  const decision = worst(items.map((i) => i.decision));
  const head = `${items.length} statement${items.length === 1 ? "" : "s"} checked against ${record.length} record file${record.length === 1 ? "" : "s"}`;
  const reason =
    decision === "pass" ? `${head}; all are supported by the record.`
    : `${head}: ${blocked.length} not in the record${lenient ? `, ${unverified.length} not found in it (unverified)` : ""}, ${reviewed.length} need a look.` +
      (blocked.length ? ` Not in the record${strict.length ? " (including statements the report calls verified)" : ""}: ${quoteList(blocked)}.` : "") +
      (unverified.length ? ` Verify before relying on: ${quoteList(unverified, 3)}.` : "") +
      (reviewed.length ? ` Check: ${quoteList(reviewed, 3)}.` : "") +
      outage(items);
  return { guard: "citations", rubric: rubric.name, decision, reason, items };
}

const SEV_OF: Record<Decision, Severity> = { block: "HIGH", review: "MEDIUM", pass: "LOW" };

/** severity-normalize over each checklist finding; flags findings graded two levels away from the rubric. */
export async function severityGuard(ctx: GuardContext, report: string): Promise<GuardResult> {
  const rubric = need(ctx, "severity-normalize");
  const findings = extractFindings(report);
  if (!findings.length) return { guard: "severity", rubric: rubric.name, decision: "review", reason: "The report has no `- [ ] SEVERITY — issue` checklist to re-grade.", items: [] };
  const items: ItemResult[] = [];
  const far: Array<{ f: { severity: Severity; text: string }; got: Severity }> = [];
  let agree = 0, near = 0;
  for (const f of findings) {
    const r = await ask(ctx, rubric, f.text, { finding: f.text }, false);
    // A finding's own decision is about the *disagreement*, not its severity: a HIGH finding is not a problem.
    if (r.error) { items.push(r); continue; }
    const got = SEV_OF[r.decision];
    const gap = Math.abs(SEV_RANK[got] - SEV_RANK[f.severity]);
    if (gap === 0) agree++; else if (gap === 1) near++; else far.push({ f, got });
    const mapped: ItemResult = { ...r, decision: gap >= 2 ? "review" : "pass", reason: `stated ${f.severity}, rubric ${got}` };
    ctx.onItem?.(rubric, mapped, f.text);
    items.push(mapped);
  }
  const decision = worst(items.map((i) => i.decision));
  const reason =
    `${findings.length} findings re-graded: ${agree} agree, ${near} one level apart, ${far.length} two levels apart.` +
    (far.length ? ` Re-check the severity of: ${far.slice(0, 5).map(({ f, got }) => `"${clip(f.text, 110)}" (stated ${f.severity}, rubric says ${got})`).join("; ")}.` : "") +
    outage(items);
  return { guard: "severity", rubric: rubric.name, decision, reason, items };
}

/**
 * privilege-coding over each corpus document, a second coder independent of the workflow's.
 * The guard fails a report that puts a document the rubric would withhold into the production set.
 */
export async function privilegeGuard(ctx: GuardContext, report: string, corpus: Doc[], holders: string, matter?: string): Promise<GuardResult> {
  const rubric = need(ctx, "privilege-coding");
  if (!corpus.length) return { guard: "privilege", rubric: rubric.name, decision: "review", reason: "No corpus documents were found to code.", items: [] };
  const production = selectSections(report, ["Production set"]);
  const items: ItemResult[] = [];
  const leaked: ItemResult[] = [], unsure: ItemResult[] = [];
  let withheld = 0, toReview = 0;
  for (const d of corpus) {
    const r = await ask(ctx, rubric, d.name, { document: d.text, privilege_holders: holders, ...(matter ? { matter } : {}) }, false);
    if (r.error) { items.push(r); continue; }
    if (r.decision === "block") withheld++;
    if (r.decision === "review") toReview++;
    const where = mentionedUnder(production, d, /\b(withh[oe]ld|not produced|excluded|privilege[- ]logged|logged)\b/i);
    // Listed as produced anywhere counts as produced, even if it is also listed as withheld.
    const produced = where.outsideLabel;
    let decision: Decision = "pass";
    if (produced && r.decision === "block") { decision = "block"; leaked.push(r); }
    else if (produced && r.decision === "review") { decision = "review"; unsure.push(r); }
    const mapped: ItemResult = { ...r, decision, reason: `rubric: ${r.reason}${produced ? "; listed in the production set" : "; not produced"}` };
    ctx.onItem?.(rubric, mapped, d.name);
    items.push(mapped);
  }
  if (!production.trim()) items.push({ item: "production set", decision: "review", reason: "the report has no ## Production set section" });
  const decision = worst(items.map((i) => i.decision));
  const reason =
    `${corpus.length} documents coded by the rubric: ${withheld} withhold, ${toReview} individual review, ${corpus.length - withheld - toReview - unavailable(items)} producible.` +
    (!production.trim() ? " The report has no Production set section, so it cannot be checked." : "") +
    (leaked.length ? ` In the production set but privileged by the rubric: ${leaked.map((i) => i.item).join(", ")}.` : "") +
    (unsure.length ? ` In the production set but needing individual privilege review: ${unsure.map((i) => i.item).join(", ")}.` : "") +
    (decision === "pass" ? " No withheld or review document is in the production set." : "") +
    outage(items);
  return { guard: "privilege", rubric: rubric.name, decision, reason, items };
}

/** signal-classify over each signal; fails a digest that dismisses or omits a signal the rubric would alert on. */
export async function signalGuard(ctx: GuardContext, report: string, signals: Doc[], portfolio: string): Promise<GuardResult> {
  const rubric = need(ctx, "signal-classify");
  if (!signals.length) return { guard: "signals", rubric: rubric.name, decision: "review", reason: "No signal files were found to classify.", items: [] };
  const alerts = selectSections(report, ["Alert queue", "Alerts"]);
  const dismissed = selectSections(report, ["Dismissed"]);
  const items: ItemResult[] = [];
  const missed: ItemResult[] = [], omitted: ItemResult[] = [], duplicates: ItemResult[] = [];
  let alertN = 0, possibleN = 0;
  for (const d of signals) {
    const r = await ask(ctx, rubric, d.name, { signal: d.text, portfolio }, false);
    if (r.error) { items.push(r); continue; }
    let decision: Decision = "pass";
    if (r.decision === "block") {
      alertN++;
      const inAlerts = mentions(alerts, d);
      const gone = mentionedUnder(dismissed, d, /\b(dedup\w*|duplicat\w*|derivative|same (underlying )?development|already (alerted|covered))\b/i);
      if (inAlerts) { /* alerted */ }
      else if (gone.mentioned && !gone.outsideLabel) { duplicates.push(r); r.reason = "dismissed as a duplicate of an alerted signal"; }
      else if (gone.mentioned) { decision = "block"; missed.push(r); }
      else { decision = "review"; omitted.push(r); }
    } else if (r.decision === "review") possibleN++;
    const mapped: ItemResult = { ...r, decision, reason: `rubric: ${r.reason}${decision === "block" ? "; dismissed by the digest" : decision === "review" ? "; not in the alert queue" : ""}` };
    ctx.onItem?.(rubric, mapped, d.name);
    items.push(mapped);
  }
  const decision = worst(items.map((i) => i.decision));
  const reason =
    `${signals.length} signals classified by the rubric: ${alertN} need an alert, ${possibleN} possibly relevant.` +
    (missed.length ? ` Dismissed by the digest but alert-worthy: ${missed.map((i) => i.item).join(", ")}.` : "") +
    (omitted.length ? ` Alert-worthy but not found in the alert queue: ${omitted.map((i) => i.item).join(", ")}.` : "") +
    (duplicates.length ? ` Dismissed as duplicates of an alerted development: ${duplicates.map((i) => i.item).join(", ")}.` : "") +
    (decision === "pass" ? " Every alert-worthy signal is in the alert queue or dismissed as a duplicate." : "") +
    outage(items);
  return { guard: "signals", rubric: rubric.name, decision, reason, items };
}

/** witness-coaching over each block of coaching text in the given sections. */
export async function coachingGuard(ctx: GuardContext, report: string, include: string[]): Promise<GuardResult> {
  const rubric = need(ctx, "witness-coaching");
  const blocks = extractBlocks(selectSections(report, include));
  if (!blocks.length) return { guard: "coaching", rubric: rubric.name, decision: "pass", reason: "No coaching text to check.", items: [] };
  const items: ItemResult[] = [];
  for (const b of blocks.slice(0, 20)) items.push(await ask(ctx, rubric, b, b));
  const blocked = items.filter((i) => i.decision === "block" && !i.error);
  const reviewed = items.filter((i) => i.decision === "review" && !i.error);
  const decision = worst(items.map((i) => i.decision));
  const reason =
    decision === "pass" ? `${items.length} coaching notes checked; none scripts or re-frames testimony.`
    : `${items.length} coaching notes checked: ${blocked.length} script or re-frame testimony, ${reviewed.length} need a look.` +
      (blocked.length ? ` Scripting: ${quoteList(blocked, 3)}.` : "") +
      (reviewed.length ? ` Check: ${quoteList(reviewed, 3)}.` : "") +
      outage(items);
  return { guard: "coaching", rubric: rubric.name, decision, reason, items };
}

// ------------------------------------------------------------------ workflow guard specs

/**
 * A workflow declares its guards in a fenced ```orchestrator-guards block inside its
 * `doc:`, beside the launch block. `{params.x}` is filled from the run's params.
 *
 *   step: report                      # the step whose output is checked
 *   checks:
 *     - { guard: citations, record: ["{params.target}"], skip: [Limitations] }
 *     - { guard: severity }
 */
export interface GuardCheck {
  guard: GuardName;
  record?: string[];
  record_text?: string;
  /** Step outputs (by label) added to the record, e.g. a transcript the report summarises. */
  record_steps?: string[];
  portfolio?: string;
  privilege_holders?: string;
  matter?: string;
  include?: string[];
  skip?: string[];
  max_claims?: number;
  unsupported?: "block" | "review";
  strict?: string[];
}
export interface GuardSpec { step: string; checks: GuardCheck[] }

export const GUARD_TITLES: Record<GuardName, string> = {
  citations: "Statements in the record (citation-in-record)",
  severity: "Checklist severity (severity-normalize)",
  privilege: "Privilege in the production set (privilege-coding)",
  signals: "Missed alerts (signal-classify)",
  coaching: "Witness coaching (witness-coaching)",
};

/** The raw YAML text of the orchestrator-guards block in a workflow file, if any. */
export function guardBlock(workflowYaml: string): string | undefined {
  const m = /```orchestrator-guards\s*\n([\s\S]*?)\n\s*```/.exec(workflowYaml);
  if (!m) return undefined;
  // The block sits inside an indented `doc: |-` scalar; strip the common indent.
  const lines = m[1].split("\n");
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
  return lines.map((l) => l.slice(indent)).join("\n");
}

export function validateSpec(raw: unknown): GuardSpec {
  const o = (raw ?? {}) as Record<string, unknown>;
  const checks = o.checks;
  if (!Array.isArray(checks) || !checks.length) throw new Error("orchestrator-guards: checks must be a non-empty list");
  for (const c of checks) {
    if (!GUARDS.includes((c as GuardCheck).guard)) throw new Error(`orchestrator-guards: unknown guard '${(c as GuardCheck).guard}'`);
  }
  return { step: typeof o.step === "string" && o.step ? o.step : "report", checks: checks as GuardCheck[] };
}

/** Fill `{params.x}` from the run's params; an unknown or empty param becomes "". */
export function fill<T>(value: T, params: Record<string, unknown>): T {
  if (typeof value === "string") return value.replace(/\{params\.([\w-]+)\}/g, (_, k) => String(params[k] ?? "")) as T;
  if (Array.isArray(value)) return value.map((v) => fill(v, params)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, params)])) as T;
  return value;
}

export interface GuardRun { decision: Decision; markdown: string; results: GuardResult[] }

const LABEL: Record<Decision, string> = { pass: "Pass", review: "Review", block: "Block" };

/** Run every check in a spec over one report and render the "## Quality guards" section. */
export async function runGuards(
  ctx: GuardContext,
  spec: GuardSpec,
  input: { report: string; params: Record<string, unknown>; projectDir: string; stepOutput?: (label: string) => string | undefined },
): Promise<GuardRun> {
  const results: GuardResult[] = [];
  for (const raw of spec.checks) {
    const c = fill(raw, input.params);
    const paths = (c.record ?? []).filter((p) => p && p.trim());
    let r: GuardResult;
    try {
      switch (c.guard) {
        case "citations": {
          const docs = loadDocs(paths, input.projectDir);
          for (const label of c.record_steps ?? []) {
            const t = input.stepOutput?.(label);
            if (t) docs.unshift({ name: `step ${label}`, text: t });
          }
          if (c.record_text?.trim()) docs.unshift({ name: "supplied facts", text: c.record_text });
          r = await citationGuard(ctx, input.report, docs, { include: c.include, skip: c.skip, maxClaims: c.max_claims, unsupported: c.unsupported, strict: c.strict });
          break;
        }
        case "severity": r = await severityGuard(ctx, selectSections(input.report, c.include, c.skip)); break;
        case "privilege": r = await privilegeGuard(ctx, input.report, loadDocs(paths, input.projectDir), c.privilege_holders || "counsel and the legal department", c.matter || undefined); break;
        case "signals": {
          const portfolio = c.portfolio ? loadDocs([c.portfolio], input.projectDir).map((d) => d.text).join("\n") : "";
          r = await signalGuard(ctx, input.report, loadDocs(paths, input.projectDir), portfolio);
          break;
        }
        case "coaching": r = await coachingGuard(ctx, input.report, c.include ?? []); break;
      }
    } catch (e) {
      r = { guard: c.guard, rubric: c.guard, decision: "review", reason: `The guard could not run (${(e as Error).message}); a person must check this.`, items: [] };
    }
    results.push(r);
  }
  const decision = worst(results.map((r) => r.decision));
  const model = results.flatMap((r) => r.items).find((i) => i.result?.model)?.result?.model ?? "clef";
  const markdown = [
    "## Quality guards",
    "",
    `Checked on this Mac by the decision model (${model}), not by the model that wrote this report. ` +
      "Pass: nothing found. Review: a person should look. Block: do not rely on the flagged text until it is verified.",
    "",
    ...results.map((r) => `- **${GUARD_TITLES[r.guard]}: ${LABEL[r.decision]}.** ${r.reason}`),
  ].join("\n");
  return { decision, markdown, results };
}
