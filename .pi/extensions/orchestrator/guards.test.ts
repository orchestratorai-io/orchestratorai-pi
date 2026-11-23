// Unit tests for the report guards' deterministic parts, with a stub decision model.
// Run: npm test (from .pi/extensions/orchestrator). No network, no Clef.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";
import { route, type Rubric, type DecisionClient } from "./decisions/index.ts";
import { loadRubricDir } from "./decisions/node.ts";
import {
  datesIn, missingDates, splitSentences, extractClaims, extractFindings, selectSections, pickRecord, loadDocs,
  mentions, mentionedUnder, guardBlock, validateSpec, fill, citationGuard, severityGuard, privilegeGuard, signalGuard,
  coachingGuard, runGuards, type Doc,
} from "./guards.ts";

const projectDir = path.resolve(import.meta.dirname, "..", "..", "..");
const rubrics = loadRubricDir(path.join(projectDir, ".pi", "rubrics"));

/** A stub decision model: `answer(state, rubricName)` returns noul/score values by question id. */
function stub(answer: (state: any, questions: string[]) => Record<string, number>): DecisionClient {
  return {
    async ask(state: any, questions: Record<string, any>) {
      const vals = answer(state, Object.keys(questions));
      const answers: Record<string, any> = {};
      for (const [id, q] of Object.entries(questions)) {
        const v = vals[id] ?? 0;
        if (q.type === "noul") answers[id] = { type: "noul", noul: v };
        else if (q.type === "score") answers[id] = { type: "score", score: v, probabilities: { "0": 0, "1": 0, "2": v >= 1.5 ? 1 : 0 }, confidence: 0.9, legend: {} };
        else answers[id] = { type: "choice", choice: String(v), probabilities: {}, confidence: 0.9 };
      }
      return { model: "stub", answers, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  } as unknown as DecisionClient;
}

test("dates are normalised and bare years ignored", () => {
  const found = datesIn("on October 26, 2023, 14 May 2024 and 2024-05-14; March 2026; two 2025 items");
  for (const d of ["2023-10-26", "2024-05-14", "2026-03"]) assert.ok(found.has(d), d);
  assert.ok(![...found].includes("2025"), "a bare year is not a date");
  assert.deepEqual(missingDates("the Feb 2026 sessions", "sessions ran February – March 2026"), []);
  assert.deepEqual(missingDates("design work in April 2026", "between Feb-June 2026"), ["2026-04"], "only the named ends of a range");
  const rec = "Minutes, 14 May 2024. Options granted March 2026 on a November 2024 409A.";
  assert.deepEqual(missingDates("reviewed as of October 26, 2023", rec), ["2023-10-26"]);
  assert.deepEqual(missingDates("approved on May 14, 2024", rec), []);
  assert.deepEqual(missingDates("granted in March 2026", rec), []);
  assert.deepEqual(missingDates("granted on March 3, 2026", rec), ["2026-03-03"]);
});

test("sentences split without breaking on Inc., s. or v.", () => {
  assert.deepEqual(splitSentences('Cedar Analytics, Inc. ("Target") is the seller. MSA s. 11 applies. Smith v. Jones held so.'),
    ['Cedar Analytics, Inc. ("Target") is the seller.', "MSA s. 11 applies.", "Smith v. Jones held so."]);
});

test("claims: specific statements only, no headings, labels, process notes or severity tags", () => {
  const md = [
    "# Deal memo - Cedar", "", "Northwind represents approximately 41% of recurring revenue.",
    "Commercial blockade (R-1 + R-2):", "Both gates approved during the click-through on 2026-09-28.",
    "The buyer should negotiate firmly.", "", "## Attorney review focus",
    "- [ ] HIGH — Obtain Northwind consent under MSA s.11 before closing.", "", "## Limitations", "Covers 5 documents dated 2026.",
  ].join("\n");
  const claims = extractClaims(selectSections(md, [], ["Limitations"]));
  assert.deepEqual(claims, ["Northwind represents approximately 41% of recurring revenue.", "Obtain Northwind consent under MSA s.11 before closing."]);
});

test("claims are capped, most specific kept, document order preserved", () => {
  const lines = Array.from({ length: 30 }, (_, i) => (i === 7 ? "The review closed on March 3, 2024 at the office." : `Item number ${i} has a figure in it here.`));
  const claims = extractClaims(lines.join("\n"), 5);
  assert.equal(claims.length, 5);
  assert.ok(claims.includes("The review closed on March 3, 2024 at the office."));
});

test("checklist findings parse every severity spelling", () => {
  const f = extractFindings("- [ ] HIGH — a; b\n- [ ] **MEDIUM** - c\n* [x] CRITICAL: d\n- [ ] [LOW] – e\n- [ ] MEDIUM Verify the term\n- not a finding\n- [ ] HIGHLY unusual note");
  assert.deepEqual(f.map((x) => x.severity), ["HIGH", "MEDIUM", "HIGH", "LOW", "MEDIUM"]);
  assert.equal(f[0].text, "a; b");
});

test("selectSections includes and skips whole subtrees", () => {
  const md = "# T\nintro\n## Keep\nk1\n### Sub\nk2\n## Drop\nd1\n### DropSub\nd2\n## Keep too\nk3";
  assert.equal(selectSections(md, [], ["Drop"]).includes("d2"), false);
  assert.ok(selectSections(md, [], ["Drop"]).includes("k3"));
  assert.equal(selectSections("## Unverified authorities\nUNV-1\n## Verified authorities\nVER-1", ["Verified authorities"]).includes("UNV-1"), false);
  const only = selectSections(md, ["Keep"]);
  assert.ok(only.includes("k1") && only.includes("k2") && only.includes("k3") && !only.includes("intro") && !only.includes("d1"));
});

test("a sub-label inside a section is honoured (Withheld:, Deduplicated:)", () => {
  const d: Doc = { name: "fixtures/discovery/002-email-counsel-advice.md", text: "# Email" };
  const produced = "Production set:\n- 001-email-pipeline-thread.md (ready)\n\nWithheld:\n- 002-email-counsel-advice.md (logged)";
  assert.deepEqual(mentionedUnder(produced, d, /withh[oe]ld/i), { mentioned: true, underLabel: true, outsideLabel: false });
  const batches = "*   **Batch 1: Privileged (Withheld & Disclosed via Log)**\n    `002-email-counsel-advice.md` (full redaction)\n*   **Batch 3: Non-Privileged & Responsive**\n    `005-invoice.md` produced";
  assert.deepEqual(mentionedUnder(batches, d, /withh[oe]ld/i), { mentioned: true, underLabel: true, outsideLabel: false }, "a bold bullet is a label");
  assert.deepEqual(mentionedUnder("- 002-email-counsel-advice.md (ready)", d, /withh[oe]ld/i), { mentioned: true, underLabel: false, outsideLabel: true });
});

test("a digest that names a signal by its title still counts as naming it", () => {
  const d: Doc = { name: "fixtures/sentinel/signals/01-ruling-residuals.md", text: "**Synthetic**\n\n# Ruling - Meridian Analytics v. Corvid Labs (9th Cir., Sept 8 2026)\n\nBody." };
  const other: Doc = { name: "06-ruling-maritime.md", text: "# Ruling - Port of Calder Authority v. Sundance Shipping (Sept 7 2026)" };
  const queue = "1. **Meridian Analytics v. Corvid Labs (Ninth Circuit)**\n   - Action: assess the residuals defence.\n\n2. **DPA Enforcement Action (EU Privacy)**";
  assert.equal(mentions(queue, d), true);
  assert.equal(mentions(queue, other), false);
});

test("record: small records whole, large records by relevance", () => {
  const docs: Doc[] = [{ name: "a.md", text: "Northwind consent clause." }, { name: "b.md", text: "x".repeat(5000) + " lender covenant leverage" }];
  assert.ok(pickRecord("anything", docs).includes("a.md"));
  const picked = pickRecord("the lender leverage covenant", docs, 3000);
  assert.ok(picked.includes("lender covenant leverage"), "the relevant chunk is kept");
  assert.ok(picked.length <= 3200);
});

test("folders load recursively and skip READMEs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guards-"));
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "README.md"), "about");
  fs.writeFileSync(path.join(dir, "one.md"), "1");
  fs.writeFileSync(path.join(dir, "sub", "two.txt"), "2");
  fs.writeFileSync(path.join(dir, "image.png"), "");
  assert.deepEqual(loadDocs([dir], dir).map((d) => d.name), ["one.md", "sub/two.txt"]);
  assert.throws(() => loadDocs(["missing.md"], dir), /not found/);
});

test("citations: an invented date blocks even when the model calls it supported", async () => {
  const rubric = rubrics.get("citation-in-record")!;
  const client = stub(() => ({ asserts_fact: 0.95, supported: 0.9, invented_detail: 0.1, fidelity: 2 }));
  const report = "# Memo\n\nThe review was completed on October 26, 2023 by counsel.\n\nNorthwind holds 41% of recurring revenue today.";
  const r = await citationGuard({ client, rubrics }, report, [{ name: "rec.md", text: "Northwind holds 41% of recurring revenue." }]);
  assert.equal(rubric.version >= 5, true);
  assert.equal(r.decision, "block");
  assert.match(r.reason, /October 26, 2023/);
  assert.equal(r.items.filter((i) => i.decision === "pass").length, 1);
});

test("citations: dates are checked against the whole record, not the excerpt", async () => {
  const client = stub(() => ({ asserts_fact: 0.95, supported: 0.9, invented_detail: 0.1, fidelity: 2 }));
  const big: Doc[] = [{ name: "a.md", text: "The sessions ran in February 2026.\n\n" + "filler words here. ".repeat(800) }, { name: "b.md", text: "Scheduler v4 shipped in June 2026 after the memo." }];
  const r = await citationGuard({ client, rubrics }, "Scheduler v4 shipped in June 2026, months after the February 2026 sessions.", big, { budget: 600 });
  assert.equal(r.decision, "pass");
});

test("citations: proposals pass, an unsupported fact blocks, an outage goes to review", async () => {
  const report = "Buyer should hold back 10% of the price for 18 months.\n\nNorthwind represents over 60% of revenue in 2026.";
  const client = stub((state) => (String(state.claim ?? state).includes("hold back") ? { asserts_fact: 0.1, supported: 0 } : { asserts_fact: 0.9, supported: 0.05 }));
  const r = await citationGuard({ client, rubrics }, report, [{ name: "rec.md", text: "Northwind represents 41% of revenue." }]);
  assert.equal(r.decision, "block");
  assert.deepEqual(r.items.map((i) => i.decision), ["pass", "block"]);
  const down = { ask: async () => { throw new Error("connection refused"); } } as unknown as DecisionClient;
  const r2 = await citationGuard({ client: down, rubrics }, report, [{ name: "rec.md", text: "x" }]);
  assert.equal(r2.decision, "review");
  assert.match(r2.reason, /could not be reached/);
});

test("severity: only a two-level disagreement asks for review", async () => {
  const sev = (s: string) => (s.includes("consent") ? { severity: 2 } : s.includes("typo") ? { severity: 0 } : { severity: 1 });
  const client = stub((state) => sev(String(state)));
  const ok = await severityGuard({ client, rubrics }, "- [ ] HIGH — obtain consent\n- [ ] MEDIUM — fix the typo\n- [ ] LOW — cap is 12 months");
  assert.equal(ok.decision, "pass");
  const bad = await severityGuard({ client, rubrics }, "- [ ] LOW — obtain consent before closing");
  assert.equal(bad.decision, "review");
  assert.match(bad.reason, /stated LOW, rubric says HIGH/);
  assert.equal((await severityGuard({ client, rubrics }, "# no checklist")).decision, "review");
  // The store records the guard's decision: an agreeing HIGH finding is a pass, not a red block.
  const recorded: string[] = [];
  await severityGuard({ client, rubrics, onItem: (_r, i) => recorded.push(i.decision) }, "- [ ] HIGH — obtain consent\n- [ ] LOW — obtain consent");
  assert.deepEqual(recorded, ["pass", "review"]);
});

test("privilege: a privileged document in the production set blocks; withheld is fine", async () => {
  const corpus: Doc[] = [{ name: "002-email-counsel-advice.md", text: "From the general counsel: legal advice" }, { name: "005-invoice.md", text: "Invoice" }];
  const client = stub((state) => (String(state.document).includes("counsel") ? { status: 0, involves_counsel: 0.99 } : { involves_counsel: 0.01 }));
  // status is a choice: the stub's choice is the string of the number, so map it through the real rubric routing.
  const priv = rubrics.get("privilege-coding")!;
  const real: DecisionClient = {
    ask: async (state: any, qs: any) => {
      const r = await client.ask(state, qs);
      const isCounsel = String(state.document).includes("counsel");
      r.answers.status = { type: "choice", choice: isCounsel ? "privileged" : "not_privileged", probabilities: { privileged: isCounsel ? 0.9 : 0, potentially_privileged: 0, not_privileged: isCounsel ? 0.1 : 0.95 }, confidence: 0.9 } as any;
      return r;
    },
  } as unknown as DecisionClient;
  assert.ok(route(priv, (await real.ask({ document: "counsel" }, priv.questions as any)).answers).decision === "block");
  const leaked = await privilegeGuard({ client: real, rubrics }, "## Production set\n- 002-email-counsel-advice.md\n- 005-invoice.md", corpus, "counsel");
  assert.equal(leaked.decision, "block");
  const both = await privilegeGuard({ client: real, rubrics }, "## Production set\n- 002-email-counsel-advice.md\n\nWithheld:\n- 002-email-counsel-advice.md", corpus, "counsel");
  assert.equal(both.decision, "block", "listed as produced anywhere is produced");
  const fine = await privilegeGuard({ client: real, rubrics }, "## Production set\n- 005-invoice.md\n\nWithheld:\n- 002-email-counsel-advice.md", corpus, "counsel");
  assert.equal(fine.decision, "pass");
  const missing = await privilegeGuard({ client: real, rubrics }, "# no sections", corpus, "counsel");
  assert.equal(missing.decision, "review");
});

test("signals: a dismissed alert-worthy signal blocks; a duplicate does not", async () => {
  const signals: Doc[] = [
    { name: "01-ruling.md", text: "# Ruling - Meridian Analytics v. Corvid Labs\nThe court narrowed residuals clauses; Cedar affected." },
    { name: "02-tradepress.md", text: "# Trade press - Appeals court tightens the residuals clause\nCoverage of Meridian Analytics v. Corvid Labs; Cedar affected." },
    { name: "03-enforcement.md", text: "# Enforcement - Authority fines an analytics processor\nTransfers on a lapsed framework; Cedar exposure; residuals clauses." },
    { name: "06-maritime.md", text: "# Ruling - Port of Calder v. Sundance Shipping\nsalvage" },
  ];
  const client = stub((state) => ({ touches_portfolio: String(state.signal).includes("Cedar") ? 0.95 : 0.02 }));
  const good = "## Alert queue\n- 01-ruling.md\n- 03-enforcement.md\n## Dismissed signals\n**Deduplicated:**\n- 02-tradepress.md\n**Out of scope:**\n- 06-maritime.md";
  assert.equal((await signalGuard({ client, rubrics }, good, signals, "Cedar")).decision, "pass");
  // "Duplicate" is not a free pass: with nothing matching in the alert queue it needs a look.
  const fakeDup = "## Alert queue\n- 01-ruling.md\n## Dismissed signals\n**Duplicates:**\n- 02-tradepress.md\n- 03-enforcement.md\n**Out of scope:**\n- 06-maritime.md";
  const r0 = await signalGuard({ client, rubrics }, fakeDup, signals, "Cedar");
  assert.equal(r0.decision, "review");
  assert.match(r0.reason, /no matching development is in the alert queue: 03-enforcement\.md/);
  // Left out but verifiably the same development as an alert: fine. Left out and unrelated: review.
  const folded = "## Alert queue\n1. **Meridian Analytics v. Corvid Labs**\n2. **Authority fines an analytics processor**\n## Dismissed signals\n- 06-maritime.md";
  assert.equal((await signalGuard({ client, rubrics }, folded, signals, "Cedar")).decision, "pass");
  const lost = "## Alert queue\n1. **Meridian Analytics v. Corvid Labs**\n## Dismissed signals\n- 06-maritime.md";
  assert.equal((await signalGuard({ client, rubrics }, lost, signals, "Cedar")).decision, "review");
  const bad = "## Alert queue\n- 06-maritime.md\n## Dismissed signals\nOut of scope:\n- 01-ruling.md\n- 02-tradepress.md\n- 03-enforcement.md";
  const r = await signalGuard({ client, rubrics }, bad, signals, "Cedar");
  assert.equal(r.decision, "block");
  assert.match(r.reason, /01-ruling\.md/);
});

test("coaching: worst block wins", async () => {
  const client = stub((state) => (String(state).includes("say it was") ? { scripts_testimony: 0.97, level: 2 } : { scripts_testimony: 0.05, level: 0 }));
  const md = "## Coaching recommendations\n- Answer truthfully and say if you do not recall the meeting date.\n- When asked about the email, say it was about scheduling, not the design.";
  const r = await coachingGuard({ client, rubrics }, md, ["Coaching recommendations"]);
  assert.equal(r.decision, "block");
});

test("every catalog workflow declares valid guards, and fill() resolves params", () => {
  const dir = path.join(projectDir, ".pi", "workflows");
  let n = 0;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    if (!text.includes("```orchestrator-launch")) continue;
    const block = guardBlock(text);
    assert.ok(block, `${f} has an orchestrator-guards block`);
    const spec = validateSpec(YAML.parse(block!));
    assert.ok(spec.checks.some((c) => c.guard === "severity"), `${f} re-grades its checklist`);
    // The flow must actually call the guard, and the guarded step must exist in it.
    assert.ok(text.includes("report_guard"), `${f} calls report_guard`);
    assert.ok(new RegExp(`label: ${spec.step}\\b`).test(text), `${f} has a step labelled ${spec.step}`);
    n++;
  }
  assert.equal(n, 14);
  assert.deepEqual(fill({ record: ["{params.target}", "{params.none}"] }, { target: "fixtures/x" }), { record: ["fixtures/x", ""] });
});

test("runGuards renders one line per guard and the worst decision", async () => {
  const client = stub(() => ({ asserts_fact: 0.9, supported: 0.95, invented_detail: 0.05, fidelity: 2, severity: 2 }));
  const out = await runGuards({ client, rubrics }, { step: "report", checks: [{ guard: "citations", record: ["fixtures/dealroom-diligence-record.md"] }, { guard: "severity" }] }, {
    report: "Northwind represents approximately 41% of recurring revenue.\n\n- [ ] HIGH — Obtain Northwind consent.", params: {}, projectDir,
  });
  assert.equal(out.decision, "pass");
  assert.match(out.markdown, /^## Quality guards/);
  assert.equal(out.markdown.split("\n").filter((l) => l.startsWith("- **")).length, 2);
});
