export async function parseAllenApiResponse(res: Response): Promise<unknown> {
  if (res.ok) return res.json();

  const text = await res.text().catch(() => 'unknown');
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object') {
      return { ok: false, httpStatus: res.status, ...(parsed as Record<string, unknown>) };
    }
  } catch {
    // Fall through to the text response below.
  }
  return { ok: false, error: `API ${res.status}: ${text}` };
}
