import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { diligenceFindings, registerDiligenceEvidence, withDiligenceFindings } from "../diligence-evidence.ts";
import { extractClaims, loadDocs } from "../guards.ts";

const root = path.resolve(import.meta.dirname, "../../../..");

test("the SLA comparison uses the lower termination threshold and a complete period", () => {
  const make = (values: string, period = "three") => diligenceFindings([{
    name: "agreement.md",
    text: `Monthly availability target is 99.9%. Three consecutive months below 99.5% permits termination. The dashboard shows availability of ${values} for the most recent ${period} months.`,
  }])[0];

  assert.match(make("99.41%, 99.38% and 99.62%").comparison!, /Only 2 of the 3.*do not establish/);
  assert.match(make("99.41%, 99.38% and 99.50%").comparison!, /Only 2 of the 3/, "equal is not below");
  assert.match(make("99.41%, 99.38% and 99.49%").comparison!, /All 3.*numerical condition/);
  assert.equal(make("99.41% and 99.38%").comparison, undefined, "an incomplete period cannot establish the trigger");
  assert.equal(make("99.41%, 99.38% and 99.49%", "four").comparison, undefined);
});

test("source-owned SLA and 409A findings replace draft claims and remain eligible for citation sampling", () => {
  const findings = diligenceFindings(loadDocs(["fixtures/dealroom"], root));
  const draft = [
    "# Due diligence - Cedar",
    "",
    "Revenue is concentrated. Cedar breached the 99.5% SLA threshold three consecutive months.",
    "",
    "## Attorney review focus",
    "- [ ] HIGH — Check the loan waiver.",
    "- [ ] HIGH — Obtain an SLA waiver for all three breaches.",
    "",
    "## Missing materials",
    "- Updated 409A valuation report for options granted in March 2026.",
    "- The employment memo references an unattached Schedule A.",
  ].join("\n");
  const report = withDiligenceFindings(draft, findings);

  assert.doesNotMatch(report, /breached the 99\.5%|all three breaches|Updated 409A valuation report/);
  assert.match(report, /Revenue is concentrated\.|Check the loan waiver\./);
  assert.match(report, /unattached Schedule A/);
  assert.match(report, /fixtures\/dealroom\/01-msa-northwind\.md/);
  assert.match(report, /99\.41%, 99\.38% and 99\.62%/);
  assert.match(report, /Only 2 of the 3 reported months were below 99\.5%/);
  assert.match(report, /fixtures\/dealroom\/03-cap-table-summary\.md/);
  assert.match(report, /March 2026.*409A valuation dated November 2024/);
  assert.match(report, /No refreshed 409A is in the data room\./);
  assert.doesNotMatch(report, /120,000 shares/, "unrelated statements in the same paragraph are not 409A evidence");
  const claims = extractClaims(report);
  assert.ok(claims.some((claim) => claim.includes("99.62%")));
  assert.ok(claims.some((claim) => claim.includes("dated November 2024")));
  assert.equal(withDiligenceFindings(draft, []), draft);
});

test("the delegated result hook keeps source evidence through Pi's result recovery", () => {
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  registerDiligenceEvidence({ on: (name: string, handler: (event: any, ctx?: any) => any) =>
    handlers.set(name, handler) } as any);
  const start = handlers.get("before_agent_start")!;
  const submit = handlers.get("tool_call")!;
  const result = { toolName: "pi_agents_submit_result", input: { result: "# Due diligence" } };

  submit(result);
  assert.equal(result.input.result, "# Due diligence");
  start({ prompt: "Required source: fixtures/dealroom/01-msa-northwind.md\nDiligence evidence: fixtures/dealroom/01-msa-northwind.md" }, { cwd: root });
  start({ prompt: "Your previous turn did not submit a result." }, { cwd: root });
  submit(result);
  assert.match(result.input.result, /Only 2 of the 3/);
  assert.doesNotMatch(result.input.result, /409A/);
});
