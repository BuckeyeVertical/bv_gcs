import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './ui/Button';

/** Poll interval while no mosaic exists yet. Stops as soon as one appears, so
 *  this costs nothing for the rest of the flight. */
const POLL_MS = 15_000;

/** Gap between download clicks. Firing them together makes Chrome treat the
 *  second as an unsolicited popup and drop it silently. */
const DOWNLOAD_GAP_MS = 700;

interface MosaicInfo {
  name: string;
  bytes: number;
  kind: 'feature' | 'naive';
}

/**
 * The newest stitch run's mosaics, feature-matched one first.
 *
 * A run writes up to two files — the feature mosaic and the dead-reckoned
 * `naive_mosaic_` fallback — and the server pairs them by the timestamp they
 * share. Usually two, but one alone when the naive fallback was disabled or the
 * feature stitch failed, so nothing here assumes a count.
 */
async function fetchLatestRun(): Promise<MosaicInfo[]> {
  try {
    const response = await fetch('/mosaic/list', { cache: 'no-store' });
    if (!response.ok) return [];
    const body = (await response.json()) as {
      mosaics?: MosaicInfo[];
      latest_run?: string[];
    };
    const names = body.latest_run ?? [];
    const byName = new Map((body.mosaics ?? []).map((m) => [m.name, m]));
    return names
      .map((name) => byName.get(name))
      .filter((m): m is MosaicInfo => m !== undefined);
  } catch {
    return [];
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
  const [run, setRun] = useState<MosaicInfo[]>([]);
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
      const found = await fetchLatestRun();
      if (cancelled) return;
      if (found.length) {
        setRun(found);
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
    // since the last poll, and the operator wants the current run.
    const current = await fetchLatestRun();
    const files = current.length ? current : run;
    if (!files.length) {
      setStatus('No mosaic yet — nothing has finished stitching.');
      return;
    }
    setRun(files);

    const link = linkRef.current;
    if (!link) return;

    const total = files.reduce((sum, file) => sum + file.bytes, 0);
    setStatus(
      `Downloading ${files.length} file${files.length > 1 ? 's' : ''} `
      + `(${formatSize(total)})`);

    // Fetched by name, not via /mosaic/latest: that endpoint resolves to the
    // feature mosaic only, and each file keeps its own stitch-stamped name.
    for (const [index, file] of files.entries()) {
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_GAP_MS));
      }
      link.href = `/mosaic/file/${encodeURIComponent(file.name)}`;
      link.download = file.name;
      link.click();
    }
  }, [run]);

  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(''), 6000);
    return () => window.clearTimeout(timer);
  }, [status]);

  // One line per file so an interrupted pull resumes per file, which a single
  // archive download could not do.
  const commands = base && run.length
    ? run.map((file) =>
        `curl -C - -O ${base}/mosaic/file/${encodeURIComponent(file.name)}`)
    : [];

  return (
    <section className="border border-bg-border bg-bg-panel p-4 space-y-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-dim">
        Stitched map
      </div>

      <Button variant="ghost" className="w-full" disabled={!run.length}
              onClick={() => void download()}>
        {run.length > 1 ? `Download ${run.length} maps`
          : run.length ? 'Download map' : 'No map yet'}
      </Button>
      {/* Click target for the download; never rendered visibly. */}
      <a ref={linkRef} className="hidden" aria-hidden="true" />

      <div role="status" className="whitespace-pre-line font-mono text-[10px] text-ink-dim">
        {status || (run.length
          ? run.map((file) => `${file.name} · ${formatSize(file.bytes)}`).join('\n')
          : 'Waiting for a scan to finish stitching')}
      </div>

      {commands.length > 0 && (
        <details className="font-mono text-[10px] text-ink-dim">
          <summary className="cursor-pointer select-none">
            Resumable pull
          </summary>
          <code className="mt-1 block whitespace-pre-line select-all break-all leading-relaxed text-ink-muted">
            {commands.join('\n')}
          </code>
        </details>
      )}
    </section>
  );
}
