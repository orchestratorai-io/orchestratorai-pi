import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerRequiredSource } from "../require-source.ts";

test("a source-bound child sees small inputs inline and must read larger inputs before submitting", async (t) => {
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  registerRequiredSource({ on: (name: string, handler: (event: any, ctx?: any) => any) =>
    handlers.set(name, handler) } as any);
  const start = handlers.get("before_agent_start")!;
  const read = handlers.get("tool_result")!;
  const submit = handlers.get("tool_call")!;
  const result = { toolName: "pi_agents_submit_result", input: { result: "findings" } };
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-required-source-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.mkdir(path.join(cwd, "records"));
  await fs.writeFile(path.join(cwd, "records", "contract.md"), "x".repeat(8 * 1024 + 1));
  const source = { toolName: "read", input: { path: "records/contract.md" } };

  assert.equal(submit(result), undefined, "unmarked tasks keep their normal submission behavior");
  assert.equal(await start({ prompt: "Required source: records/contract.md\nAnalyse the agreement." }, { cwd }), undefined);
  assert.equal(submit(result).block, true);
  read({ ...source, isError: true }, { cwd });
  read({ ...source, input: { path: "records/summary.md" } }, { cwd });
  await start({ prompt: "Your previous turn did not submit a result." }, { cwd });
  assert.equal(submit(result).block, true, "a recovery prompt cannot bypass the requirement");
  assert.equal(submit({ ...result, input: { error: { reason: "unreadable" } } }), undefined);
  read({ ...source, input: { path: path.join(cwd, "records", "contract.md") } }, { cwd });
  assert.equal(submit(result), undefined);

  await fs.writeFile(path.join(cwd, "records", "amendment.md"), "Clause 2 applies only after notice.\n");
  const inline = await start({ prompt: "Required source: records/amendment.md" }, { cwd });
  assert.equal(inline.message.customType, "orchestrator:source");
  assert.match(inline.message.content, /Clause 2 applies only after notice/);
  assert.equal(submit(result), undefined);
});
