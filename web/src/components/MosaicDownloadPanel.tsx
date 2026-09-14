import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './ui/Button';

/** Poll interval while no mosaic exists yet. Stops as soon as one appears, so
 *  this costs nothing for the rest of the flight. */
const POLL_MS = 15_000;

interface MosaicInfo {
  name: string;
  bytes: number;
}

/** Newest complete mosaic, or null when the scan has not produced one yet. */
async function fetchLatest(): Promise<MosaicInfo | null> {
  try {
    const response = await fetch('/mosaic/list', { cache: 'no-store' });
    if (!response.ok) return null;
    const body = (await response.json()) as { mosaics?: MosaicInfo[] };
    return body.mosaics?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Where the drone actually is, for the terminal command below the button.
 *
 * Not `location.origin`: under `npm run dev` that is the vite dev server, and
 * curl gets none of the proxying that makes the browser's own request work.
 * approval_node reports the address it was reached on, and vite proxies
 * /healthz with changeOrigin, so this answers with the drone either way.
 */
async function resolveBase(): Promise<string | null> {
  try {
    const response = await fetch('/healthz', { cache: 'no-store' });
    if (!response.ok) return null;
    const health = (await response.json()) as { base_url?: string };
    return health.base_url ?? null;
  } catch {
    return null;
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Pulls the stitched map off the aircraft.
 *
 * The button hands `/mosaic/latest` to the browser's download manager rather
 * than buffering it here: the mosaic is large, and a fetch-to-Blob would hold
 * the whole thing in the tab's memory before writing a byte. The download
 * manager streams to disk and, because approval_node serves the file with Range
 * support, an interrupted download can be resumed from the browser's own
 * download list.
 *
 * The curl command stays on screen underneath because it is still the more
 * dependable option on a link that drops repeatedly — `curl -C -` resumes from
 * a terminal without depending on the browser having kept the partial file.
 */
export function MosaicDownloadPanel() {
  const [latest, setLatest] = useState<MosaicInfo | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const linkRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    void resolveBase().then(setBase);
  }, []);

  // Poll only until the first mosaic shows up. A scan can finish long after the
  // dashboard was opened, and the operator should not have to reload to notice.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const check = async () => {
      const found = await fetchLatest();
      if (cancelled) return;
      if (found) {
        setLatest(found);
        return;
      }
      timer = window.setTimeout(() => void check(), POLL_MS);
    };
    void check();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  const download = useCallback(async () => {
    // Re-check immediately before downloading: a stitch may have completed
    // since the last poll, and the operator wants the current map.
    const current = (await fetchLatest()) ?? latest;
    if (!current) {
      setStatus('No mosaic yet — nothing has finished stitching.');
      return;
    }
    setLatest(current);

    const link = linkRef.current;
    if (!link) return;
    // Same-origin, so the download attribute is honored and the file keeps its
    // stitch timestamp instead of arriving as "latest".
    link.href = '/mosaic/latest';
    link.download = current.name;
    link.click();
    setStatus(`Downloading ${current.name} (${formatSize(current.bytes)})`);
  }, [latest]);

  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(''), 6000);
    return () => window.clearTimeout(timer);
  }, [status]);

  const command = base
    ? `curl -C - -o ${latest?.name ?? 'mosaic.jpg'} ${base}/mosaic/latest`
    : null;

  return (
    <section className="border border-bg-border bg-bg-panel p-4 space-y-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-dim">
        Stitched map
      </div>

      <Button variant="ghost" className="w-full" disabled={!latest}
              onClick={() => void download()}>
        {latest ? 'Download map' : 'No map yet'}
      </Button>
      {/* Click target for the download; never rendered visibly. */}
      <a ref={linkRef} className="hidden" aria-hidden="true" />

      <div role="status" className="font-mono text-[10px] text-ink-dim">
        {status || (latest
          ? `${latest.name} · ${formatSize(latest.bytes)}`
          : 'Waiting for a scan to finish stitching')}
      </div>

      {command && (
        <details className="font-mono text-[10px] text-ink-dim">
          <summary className="cursor-pointer select-none">
            Resumable pull
          </summary>
          <code className="mt-1 block select-all break-all leading-relaxed text-ink-muted">
            {command}
          </code>
        </details>
      )}
    </section>
  );
}
