import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadDocs, sections, splitSentences, type Doc } from "./guards.ts";

const SERVICE = /\b(?:SLAs?|service[- ]levels?|service credits?|uptime)\b/i;
const AVAILABILITY = /\bavailability\b/i;
const VALUATION = /\b(?:409A|strike price|option grants?|options? (?:were )?granted|(?:updated|refreshed|stale|historical) valuation)\b/i;
const THRESHOLD = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) consecutive months? below (\d+(?:\.\d+)?)\s*%/i;
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

interface Finding {
  topic: "service" | "valuation";
  path: string;
  excerpts: string[];
  comparison?: string;
}

function serviceFinding(paragraph: string, path: string): Finding | undefined {
  if (!SERVICE.test(paragraph) && !AVAILABILITY.test(paragraph)) return;
  const sentences = splitSentences(paragraph);
  const clause = sentences.find((sentence) => THRESHOLD.test(sentence));
  if (!clause) return;
  const finding: Finding = {
    topic: "service",
    path,
    excerpts: sentences.filter((sentence) =>
      sentence === clause || SERVICE.test(sentence) || AVAILABILITY.test(sentence) || /\bcredits?:/i.test(sentence)),
  };
  const observation = sentences.find((sentence) =>
    /\b(?:shows?|observed|recorded|reported|was|were)\b/i.test(sentence) && /\b(?:most recent|last)\b/i.test(sentence) &&
    /\b(?:availability|uptime)\b/i.test(sentence));
  if (!observation) return finding;

  const [, period, threshold] = THRESHOLD.exec(clause)!;
  const months = /^\d+$/.test(period) ? Number(period) : NUMBER_WORDS.indexOf(period.toLowerCase());
  const reportedPeriod = /\b(?:most recent|last)\s+(\d+|[a-z]+)\s+months?\b/i.exec(observation)?.[1];
  const observedMonths = reportedPeriod && (/^\d+$/.test(reportedPeriod)
    ? Number(reportedPeriod) : NUMBER_WORDS.indexOf(reportedPeriod.toLowerCase()));
  const values = [...observation.matchAll(/\b(\d+(?:\.\d+)?)\s*%/g)].map((match) => Number(match[1]));
  if (months !== observedMonths || values.length !== months || months < 1 ||
      Number(threshold) > 100 || values.some((value) => value > 100)) return finding;
  const below = values.filter((value) => value < Number(threshold)).length;
  finding.comparison = below === months
    ? `All ${months} reported months were below ${threshold}%. The reported values meet the numerical condition. Confirm any remaining conditions before relying on a remedy.`
    : `Only ${below} of the ${months} reported months were below ${threshold}%. The reported months do not establish the consecutive-month trigger.`;
  return finding;
}

export function diligenceFindings(docs: Doc[]): Finding[] {
  const findings: Finding[] = [];
  for (const doc of docs) {
    for (const raw of sections(doc.text).flatMap(({ body }) => body.split(/\r?\n\s*\r?\n/))) {
      const paragraph = raw.replace(/\r?\n/g, " ").replace(/\*\*|__/g, "").trim();
      const service = serviceFinding(paragraph, doc.name);
      if (service) findings.push(service);
      const excerpts = raw.split(/\r?\n(?=\s{0,3}(?:[-*+]|\d+[.)])\s+)/)
        .filter((block) => /\b409A\b/i.test(block))
        .flatMap((block) => splitSentences(block.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
          .replace(/\r?\n/g, " ").replace(/\*\*|__/g, "")));
      if (excerpts.length) findings.push({ topic: "valuation", path: doc.name, excerpts });
    }
  }
  return findings;
}

/** The workflow reserves these issues for the source-backed findings. Remove draft copies before
 * publishing so a model cannot override the exact evidence with a paraphrase. */
export function withDiligenceFindings(draft: string, findings: Finding[]): string {
  if (!findings.length) return draft;
  const service = findings.some((finding) => finding.topic === "service");
  const valuation = findings.some((finding) => finding.topic === "valuation");
  const reserved = (line: string) =>
    (service && (SERVICE.test(line) || THRESHOLD.test(line) ||
      (AVAILABILITY.test(line) && /%|\b(?:monthly|termination|threshold)\b/i.test(line)) ||
      /\bconsecutive months?\b.*\bterminat/i.test(line))) || (valuation && VALUATION.test(line));

  const retained = draft.split(/\r?\n/).map((line) => {
    if (!reserved(line)) return line;
    if (/^\s*(?:[-*+|#>]|\d+[.)])/.test(line)) return "";
    return splitSentences(line).filter((sentence) => !reserved(sentence)).join(" ");
  }).join("\n").trimEnd();

  const formatted = findings.map(({ topic, path, excerpts, comparison }) => {
    const output = [`### ${topic === "service" ? "Service level condition" : "409A valuation evidence"}`, "", `Source: \`${path}\``, ""];
    output.push(...excerpts.map((excerpt) => `> ${excerpt}`), "");
    if (topic === "service") {
      output.push(comparison ?? "[VERIFY] Confirm the measurement periods and figures against the stated condition.");
      output.push("Recommendation: Confirm the complete service-level history before relying on a remedy.");
    } else {
      output.push("Recommendation: Confirm whether a refreshed valuation exists and request a copy if available.");
    }
    return output.join("\n");
  });

  return `${retained}\n\n## Source-checked findings\n\n${formatted.join("\n\n")}`;
}

export function registerDiligenceEvidence(pi: ExtensionAPI): void {
  let findings: Finding[] = [];
  pi.on("before_agent_start", ({ prompt }, ctx) => {
    const source = /^(?:Required source: [^\r\n]+\r?\n)?Diligence evidence: ([^\r\n]+)/.exec(prompt)?.[1];
    // A result-recovery turn has no declaration and keeps the facts captured for this task.
    if (source) findings = diligenceFindings(loadDocs([source], ctx.cwd));
    if (!findings.length) return;
    return { message: {
      customType: "orchestrator:diligence-evidence",
      content: "Pi has source-checked findings to attach to your submission. Leave these topics to the attachment: " +
        [...new Set(findings.map(({ topic }) => topic === "service" ? "service-level conditions and observations" : "409A valuation evidence"))].join(", ") +
        ". For the rest of the task, use the supplied record and call the result tool with your deliverable.",
      display: false,
    } };
  });
  pi.on("tool_call", (event) => {
    if (event.toolName === "pi_agents_submit_result" && "result" in event.input && typeof event.input.result === "string") {
      event.input.result = withDiligenceFindings(event.input.result, findings);
    }
  });
}
