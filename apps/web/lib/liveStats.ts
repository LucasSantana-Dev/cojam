// Live counter (#307): "N people in rooms right now". Totals only; the server
// aggregates and caches for 10s (GET /api/stats/live), so polling here is cheap.

export type LiveStats = { people: number; rooms: number };

// fetchLiveStats returns null on any failure so the counter just stays hidden.
export async function fetchLiveStats(signal?: AbortSignal): Promise<LiveStats | null> {
  try {
    const res = await fetch('/api/stats/live', { signal });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<LiveStats>;
    if (typeof data.people !== 'number' || typeof data.rooms !== 'number') return null;
    return { people: data.people, rooms: data.rooms };
  } catch {
    return null;
  }
}
