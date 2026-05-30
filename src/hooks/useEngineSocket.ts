// Backend base URL. Vite proxies during dev would also work, but for a
// hackathon demo a hard-coded localhost is fine. Live engine traffic flows
// over the WebSocket in useCanopySocket; these helpers are the REST controls
// for the scenario replay bar.
const API_URL =
  import.meta.env.VITE_CANOPY_API_URL ?? "http://localhost:8000";

/** Trigger a server-side scenario replay. Resolves when the request returns. */
export async function triggerReplay(
  name: string,
  speed = 5,
): Promise<void> {
  await fetch(
    `${API_URL}/scenarios/${encodeURIComponent(name)}/replay?speed=${speed}`,
    { method: "POST" },
  );
}

/** GET /scenarios — lists the available beats for the controls bar. */
export async function listScenarios(): Promise<string[]> {
  try {
    const response = await fetch(`${API_URL}/scenarios`);
    if (!response.ok) return [];
    return (await response.json()) as string[];
  } catch {
    return [];
  }
}
