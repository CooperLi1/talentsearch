import assert from "node:assert/strict";
import test from "node:test";

import { digestCandidateSnapshotCopy } from "../lib/digest/candidate-snapshot";

test("digest snapshots use grounded brief copy when profile copy is blank", () => {
  assert.deepEqual(
    digestCandidateSnapshotCopy({
      name: "Ada Example",
      headline: "   ",
      summary: "",
      facts: [
        { text: "  Built a working robotics control system.  " },
        { text: "Published the test results." },
      ],
    }),
    {
      headline: "Built a working robotics control system.",
      summary: "Built a working robotics control system.\nPublished the test results.",
    },
  );
});

test("digest snapshots retain existing profile copy", () => {
  assert.deepEqual(
    digestCandidateSnapshotCopy({
      name: "Ada Example",
      headline: " Robotics researcher ",
      summary: " Builds practical systems. ",
      facts: [{ text: "Built a working robotics control system." }],
    }),
    {
      headline: "Robotics researcher",
      summary: "Builds practical systems.",
    },
  );
});
