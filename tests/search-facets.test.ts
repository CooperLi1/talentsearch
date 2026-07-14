import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSearchFacetOptions,
  candidateMatchesFacet,
} from "../lib/search/facets";

test("buildSearchFacetOptions derives filters from evidence when profile fields are empty", () => {
  const facets = buildSearchFacetOptions([
    {
      domains: [],
      eventTypes: ["competition_result"],
      location: "",
      sourceLabels: ["International Mathematical Olympiad 2025"],
      stage: "",
      status: "new",
    },
    {
      domains: [],
      eventTypes: ["competition_result", "paper_published"],
      location: "",
      sourceLabels: ["International Mathematical Olympiad 2025", "OpenAlex"],
      stage: "",
      status: "new",
    },
  ]);

  assert.deepEqual(facets.domains, []);
  assert.deepEqual(facets.stages, []);
  assert.deepEqual(facets.eventTypes[0], {
    count: 2,
    label: "Competition result",
    value: "competition_result",
  });
  assert.deepEqual(facets.sources[0], {
    count: 2,
    label: "International Mathematical Olympiad 2025",
    value: "International Mathematical Olympiad 2025",
  });
  assert.deepEqual(facets.statuses[0], { count: 2, label: "New", value: "new" });
});

test("candidateMatchesFacet is case-insensitive and uses OR within a facet", () => {
  assert.equal(candidateMatchesFacet(["OpenAlex"], ["openalex", "GitHub"]), true);
  assert.equal(candidateMatchesFacet(["OpenAlex"], ["GitHub"]), false);
  assert.equal(candidateMatchesFacet([], []), true);
});
