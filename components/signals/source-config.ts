export type StructuredResultPageView = {
  affiliationSelector?: string;
  dateSelector?: string;
  descriptionSelector?: string;
  eventName?: string;
  itemSelector: string;
  linkSelector?: string;
  nameSelector: string;
  occurredAt?: string;
  rankSelector?: string;
  titleSelector?: string;
  url: string;
  [key: string]: unknown;
};

export type LinkedInProfileView = {
  affiliations: string[];
  biography?: string;
  headline?: string;
  location?: string;
  name: string;
  note?: string;
  observedAt?: string;
  profileUrl: string;
  provenanceUrl?: string;
  reviewed: boolean;
  websiteUrl?: string;
  [key: string]: unknown;
};

export type SourceConfigurationView = {
  lookbackDays: number | null;
  maxItems: number | null;
  options: Record<string, unknown> & {
    pages?: StructuredResultPageView[];
    profiles?: LinkedInProfileView[];
  };
  queries: string[];
  urls: string[];
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function resultPages(value: unknown): StructuredResultPageView[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const page = item as Record<string, unknown>;
      return {
        ...page,
        affiliationSelector: optionalString(page.affiliationSelector),
        dateSelector: optionalString(page.dateSelector),
        descriptionSelector: optionalString(page.descriptionSelector),
        eventName: optionalString(page.eventName),
        itemSelector: optionalString(page.itemSelector) ?? "",
        linkSelector: optionalString(page.linkSelector),
        nameSelector: optionalString(page.nameSelector) ?? "",
        occurredAt: optionalString(page.occurredAt),
        rankSelector: optionalString(page.rankSelector),
        titleSelector: optionalString(page.titleSelector),
        url: optionalString(page.url) ?? "",
      };
    });
}

function linkedinProfiles(value: unknown): LinkedInProfileView[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const profile = item as Record<string, unknown>;
      return {
        ...profile,
        affiliations: strings(profile.affiliations),
        biography: optionalString(profile.biography),
        headline: optionalString(profile.headline),
        location: optionalString(profile.location),
        name: optionalString(profile.name) ?? "",
        note: optionalString(profile.note),
        observedAt: optionalString(profile.observedAt),
        profileUrl: optionalString(profile.profileUrl) ?? "",
        provenanceUrl: optionalString(profile.provenanceUrl),
        reviewed: profile.reviewed === true,
        websiteUrl: optionalString(profile.websiteUrl),
      };
    });
}

export function normalizeSourceConfiguration(value: unknown): SourceConfigurationView {
  const configuration = record(value);
  const options = record(configuration.options);
  return {
    lookbackDays: positiveInteger(configuration.lookbackDays),
    maxItems: positiveInteger(configuration.maxItems),
    options: {
      ...options,
      pages: resultPages(options.pages),
      profiles: linkedinProfiles(options.profiles),
    },
    queries: strings(configuration.queries),
    urls: strings(configuration.urls),
  };
}
