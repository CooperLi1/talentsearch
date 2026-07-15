export function nullableSearchFilter<T>(values: T[] | undefined): T[] | null {
  return values?.length ? values : null;
}
