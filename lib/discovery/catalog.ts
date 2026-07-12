import type { ConnectorSettings, EventType, SourceKind } from "./types";

export type SourceCatalogEntry = {
  key: string;
  name: string;
  category:
    | "code"
    | "research"
    | "competition"
    | "science"
    | "hackathon"
    | "community"
    | "writing"
    | "project"
    | "social";
  connector: SourceKind;
  access: "official-api" | "public-feed" | "robots-aware-page" | "manual-approved";
  defaultEnabled: boolean;
  description: string;
  officialHome?: string;
  configTemplate?: ConnectorSettings;
};

function structuredTemplate(eventType: EventType): ConnectorSettings {
  return {
    enabled: false,
    maxItems: 100,
    options: {
      eventType,
      pages: [],
    },
  };
}

export const SOURCE_CATALOG: SourceCatalogEntry[] = [
  {
    key: "github",
    name: "GitHub repositories and collaborator graph",
    category: "code",
    connector: "github",
    access: "official-api",
    defaultEnabled: true,
    description: "Repository search, profile enrichment, public graph edges, and technical-depth analysis.",
    officialHome: "https://docs.github.com/en/rest",
  },
  {
    key: "gitlab",
    name: "GitLab projects",
    category: "code",
    connector: "gitlab",
    access: "official-api",
    defaultEnabled: true,
    description: "Public project discovery and technical-depth enrichment through GitLab's API.",
    officialHome: "https://docs.gitlab.com/api/",
  },
  {
    key: "openalex",
    name: "OpenAlex works and coauthor graph",
    category: "research",
    connector: "openalex",
    access: "official-api",
    defaultEnabled: true,
    description: "Recent works, durable author IDs, ORCID links, affiliations, and coauthors.",
    officialHome: "https://docs.openalex.org/",
  },
  {
    key: "crossref",
    name: "Crossref publications",
    category: "research",
    connector: "crossref",
    access: "official-api",
    defaultEnabled: true,
    description: "DOI-backed publication events with ORCID when supplied by publishers.",
    officialHome: "https://www.crossref.org/documentation/retrieve-metadata/rest-api/",
  },
  {
    key: "arxiv",
    name: "arXiv preprints",
    category: "research",
    connector: "arxiv",
    access: "official-api",
    defaultEnabled: true,
    description: "Recent preprints by subject category; name-only identities remain unmerged pending review.",
    officialHome: "https://info.arxiv.org/help/api/",
  },
  {
    key: "semantic-scholar",
    name: "Semantic Scholar",
    category: "research",
    connector: "semantic-scholar",
    access: "official-api",
    defaultEnabled: true,
    description: "Author-ID-backed papers and citation context through the Graph API.",
    officialHome: "https://api.semanticscholar.org/api-docs/graph",
  },
  {
    key: "olympiads",
    name: "Official olympiad results",
    category: "competition",
    connector: "competition-results",
    access: "robots-aware-page",
    defaultEnabled: false,
    description: "Configurable selectors for official IMO, IOI, USACO, ICPC, and similar result tables.",
    officialHome: "https://www.imo-official.org/results.aspx",
    configTemplate: structuredTemplate("competition_result"),
  },
  {
    key: "science-fairs",
    name: "Science fairs and research competitions",
    category: "science",
    connector: "science-fairs",
    access: "robots-aware-page",
    defaultEnabled: false,
    description: "Configurable official result pages for ISEF, iGEM, and comparable showcases.",
    officialHome: "https://www.societyforscience.org/isef/",
    configTemplate: structuredTemplate("competition_result"),
  },
  {
    key: "hackathon-showcases",
    name: "Hackathon and builder showcases",
    category: "hackathon",
    connector: "hackathons",
    access: "robots-aware-page",
    defaultEnabled: false,
    description: "Site-specific public result/showcase pages such as Devpost, MLH, Hack Club, and university events, enabled only after terms and robots review.",
    officialHome: "https://devpost.com/hackathons",
    configTemplate: structuredTemplate("hackathon_result"),
  },
  {
    key: "codeforces",
    name: "Codeforces contests",
    category: "competition",
    connector: "codeforces",
    access: "official-api",
    defaultEnabled: true,
    description: "Recent contest standings, profiles, and rating trajectory.",
    officialHome: "https://codeforces.com/apiHelp",
  },
  {
    key: "technical-blogs",
    name: "Technical blogs",
    category: "writing",
    connector: "technical-blogs",
    access: "public-feed",
    defaultEnabled: false,
    description: "Explicit RSS/Atom feeds for technical writing and research notes.",
    configTemplate: { enabled: false, urls: [], maxItems: 60 },
  },
  {
    key: "personal-sites",
    name: "Personal sites and project pages",
    category: "writing",
    connector: "web-presence",
    access: "robots-aware-page",
    defaultEnabled: true,
    description: "Known candidate sites, same-site feeds, sitemap pages, and inert JSON-LD parsing.",
    configTemplate: { enabled: true, urls: [], maxItems: 60 },
  },
  {
    key: "project-launches",
    name: "Project launch feeds",
    category: "project",
    connector: "project-launches",
    access: "public-feed",
    defaultEnabled: false,
    description: "Configured RSS/Atom launch feeds and repository release feeds; Show HN is covered by the official HN API connector.",
    configTemplate: { enabled: false, urls: [], maxItems: 60 },
  },
  {
    key: "hacker-news",
    name: "Hacker News and Show HN",
    category: "community",
    connector: "hacker-news",
    access: "official-api",
    defaultEnabled: true,
    description: "Builder launches and community recognition through the official Firebase API.",
    officialHome: "https://github.com/HackerNews/API",
  },
  {
    key: "x",
    name: "X public graph and posts",
    category: "social",
    connector: "x",
    access: "official-api",
    defaultEnabled: false,
    description: "Recent search, profile enrichment, and following edges only through X's official API.",
    officialHome: "https://docs.x.com/x-api",
  },
  {
    key: "brave-enrichment",
    name: "Public web enrichment",
    category: "community",
    connector: "brave-enrichment",
    access: "official-api",
    defaultEnabled: false,
    description: "Uses Brave only to locate public pages after a candidate exists, then verifies evidence on the publisher page before storing it.",
    officialHome: "https://api-dashboard.search.brave.com/app/documentation/web-search/get-started",
    configTemplate: { enabled: false, maxItems: 8, options: { maxQueries: 2, maxResults: 5 } },
  },
  {
    key: "linkedin",
    name: "LinkedIn approved import",
    category: "social",
    connector: "linkedin-manual",
    access: "manual-approved",
    defaultEnabled: false,
    description: "Manual reviewer input or a separately approved integration; no unauthorized scraper exists.",
    officialHome: "https://learn.microsoft.com/en-us/linkedin/",
  },
];
