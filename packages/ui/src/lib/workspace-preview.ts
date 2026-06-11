export type WorkspacePreviewService = {
  name: string;
  port: number;
};

// Pick a preview URL the browser can actually load.
// Localhost / IP / dev: hit the service port directly. Production uses the
// workspace subdomain proxy handled by the server.
export function previewUrlFor(svc: WorkspacePreviewService | undefined, workspaceId: string): string {
  if (!svc) return '';
  const { hostname, protocol } = window.location;
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  if (isLocal) return `http://${hostname}:${svc.port}`;
  return `${protocol}//${svc.name}-${workspaceId}.${hostname}`;
}

export async function openExternalUrl(url: string): Promise<boolean> {
  if (!url) return false;

  if (window.allenDesktop?.openExternal) {
    try {
      const opened = await window.allenDesktop.openExternal(url);
      if (opened) return true;
    } catch {
      // Fall back to the browser path below.
    }
  }

  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  return Boolean(opened);
}
