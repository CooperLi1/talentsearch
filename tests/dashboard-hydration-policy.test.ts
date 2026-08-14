import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../lib/data/talent-radar.ts", import.meta.url),
  "utf8",
);

test("candidate hydration scopes related-row queries to the workspace index", () => {
  const hydrate = source.slice(
    source.indexOf("async function hydrate("),
    source.indexOf("export async function listCandidates"),
  );

  assert.match(
    hydrate,
    /from\("events"\)[\s\S]*?eq\("workspace_id", rows\[0\]\.workspace_id\)[\s\S]*?in\("candidate_id", ids\)/,
  );
  assert.match(
    hydrate,
    /from\("identities"\)[\s\S]*?eq\("workspace_id", rows\[0\]\.workspace_id\)[\s\S]*?in\("candidate_id", ids\)/,
  );
});
