import type { DiscoveryConnector, SourceKind } from "../types";
import { ArxivConnector } from "./arxiv";
import { CodeforcesConnector } from "./codeforces";
import { CrossrefConnector } from "./crossref";
import { ExaPeopleConnector } from "./exa-people";
import { FeedConnector } from "./feed";
import { GitHubConnector } from "./github";
import { GitLabConnector } from "./gitlab";
import { HackerNewsConnector } from "./hacker-news";
import { HuggingFaceConnector } from "./hugging-face";
import { LinkedInManualConnector } from "./linkedin-manual";
import { OpenAlexConnector } from "./openalex";
import { PeopleDataLabsConnector } from "./people-data-labs";
import { RosterPageConnector } from "./roster-page";
import { SemanticScholarConnector } from "./semantic-scholar";
import { StructuredResultsConnector } from "./structured-results";
import { XConnector } from "./x";
import { WebPresenceConnector } from "./web-presence";
import { BraveEnrichmentConnector } from "./brave-enrichment";

export function createConnectorRegistry(): Map<SourceKind, DiscoveryConnector> {
  const connectors: DiscoveryConnector[] = [
    new GitHubConnector(),
    new GitLabConnector(),
    new OpenAlexConnector(),
    new CrossrefConnector(),
    new ExaPeopleConnector(),
    new ArxivConnector(),
    new SemanticScholarConnector(),
    new CodeforcesConnector(),
    new HackerNewsConnector(),
    new HuggingFaceConnector(),
    new FeedConnector(),
    new FeedConnector("technical-blogs", "Technical blog feeds"),
    new FeedConnector("project-launches", "Project launch feeds", "project_momentum"),
    new RosterPageConnector(),
    new StructuredResultsConnector(),
    new StructuredResultsConnector(
      "competition-results",
      "Olympiad and competition results",
      "competition_result",
    ),
    new StructuredResultsConnector(
      "science-fairs",
      "Science fair and research competition results",
      "competition_result",
    ),
    new StructuredResultsConnector("hackathons", "Hackathon showcases", "hackathon_result"),
    new WebPresenceConnector(),
    new XConnector(),
    new LinkedInManualConnector(),
    new BraveEnrichmentConnector(),
    new PeopleDataLabsConnector(),
  ];
  return new Map(connectors.map((connector) => [connector.kind, connector]));
}

export {
  ArxivConnector,
  CodeforcesConnector,
  CrossrefConnector,
  ExaPeopleConnector,
  FeedConnector,
  GitHubConnector,
  GitLabConnector,
  HackerNewsConnector,
  HuggingFaceConnector,
  LinkedInManualConnector,
  OpenAlexConnector,
  PeopleDataLabsConnector,
  RosterPageConnector,
  SemanticScholarConnector,
  StructuredResultsConnector,
  XConnector,
  WebPresenceConnector,
  BraveEnrichmentConnector,
};
