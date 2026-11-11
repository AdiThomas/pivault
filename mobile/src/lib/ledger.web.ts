/** Web version of ledger.ts. Browsers have no camera roll, so this only keeps the API shape. */

const known = new Set<string>();

export async function filterKnown(ids: string[]): Promise<Set<string>> {
  return new Set(ids.filter((id) => known.has(id)));
}

export async function markUploaded(ids: string[]): Promise<void> {
  for (const id of ids) known.add(id);
}

export async function forget(ids: string[]): Promise<void> {
  for (const id of ids) known.delete(id);
}

export async function clearLedger(): Promise<void> {
  known.clear();
}
