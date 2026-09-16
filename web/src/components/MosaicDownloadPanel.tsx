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

interface FrameArchive {
  count: number;
  bytes: number;
  /** What it saves as — always the same, so the unzip command never changes. */
  name: string;
  /** Where it lives — fingerprinted, so an interrupted resume cannot straddle
   *  a rebuild. Goes stale on purpose; the poll below reissues it. */
  url: string;
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
 * The raw scan frames sitting on the aircraft right now, as one archive.
 *
 * These are the stitcher's *inputs*, which is what re-running a bad stitch on the
 * ground needs. They come and go: stitching_node moves them into backup/ the
 * moment a stitch succeeds, and vision_node clears the directory at each scan. So
 * `null` here is the ordinary post-stitch state, not a failure — the button falls
 * back to maps only rather than reporting an error.
 */
async function fetchFrames(): Promise<FrameArchive | null> {
  try {
    const response = await fetch('/raw_frames/list', { cache: 'no-store' });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      count?: number;
      bytes?: number;
      archive_name?: string;
      archive_url?: string;
    };
    if (!body.count || !body.archive_url) return null;
    return {
      count: body.count,
      bytes: body.bytes ?? 0,
      name: body.archive_name ?? 'images.zip',
      url: body.archive_url,
    };
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
 * Pulls the stitched map — and the frames it was built from — off the aircraft.
 *
 * The button hands each URL to the browser's download manager rather than
 * buffering it here: the mosaic is large, and a fetch-to-Blob would hold the
 * whole thing in the tab's memory before writing a byte. The download manager
 * streams to disk and, because approval_node serves every one of these with Range
 * support, an interrupted download can be resumed from the browser's own download
 * list.
 *
 * One click takes both. The map alone is the wrong thing to ship when the stitch
 * came out wrong, because re-running it on the ground needs the raw frames, and an
 * operator who has to remember a second button is an operator who lands without
 * them. The frames ride as one archive rather than one download per frame: a scan
 * is 24-36 files, and that many sequential clicks costs more than the per-file
 * resume it would buy.
 *
 * The curl commands stay on screen underneath because they are still the more
 * dependable option on a link that drops repeatedly — `curl -C -` resumes from a
 * terminal without depending on the browser having kept the partial file.
 */
export function MosaicDownloadPanel() {
  const [run, setRun] = useState<MosaicInfo[]>([]);
  const [frames, setFrames] = useState<FrameArchive | null>(null);
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
      const [found, archive] = await Promise.all([
        fetchLatestRun(), fetchFrames()]);
      if (cancelled) return;
      // Frames refresh on every tick, not just the last: they accumulate while the
      // scan is still flying, so the count on the button tracks the flight.
      setFrames(archive);
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
    // Re-check immediately before downloading: a stitch may have completed since
    // the last poll, and it moves the frames out from under us as it lands. Both
    // sides have to be read at the moment of the click, not remembered.
    const [current, archive] = await Promise.all([
      fetchLatestRun(), fetchFrames()]);
    const files = current.length ? current : run;
    if (!files.length && !archive) {
      setStatus('Nothing to download yet — no map, no frames on the aircraft.');
      return;
    }
    setRun(files);
    setFrames(archive);

    const link = linkRef.current;
    if (!link) return;

    // Every URL goes through one hidden anchor, DOWNLOAD_GAP_MS apart. Firing two
    // together makes Chrome treat the second as an unsolicited popup and drop it
    // silently, and that applies to the archive exactly as it does to a mosaic.
    const targets: { href: string; name: string; bytes: number }[] = [
      // Fetched by name, not via /mosaic/latest: that endpoint resolves to the
      // feature mosaic only, and each file keeps its own stitch-stamped name.
      ...files.map((file) => ({
        href: `/mosaic/file/${encodeURIComponent(file.name)}`,
        name: file.name,
        bytes: file.bytes,
      })),
      ...(archive ? [{
        href: archive.url,
        name: archive.name,
        bytes: archive.bytes,
      }] : []),
    ];

    const total = targets.reduce((sum, target) => sum + target.bytes, 0);
    setStatus(
      `Downloading ${targets.length} file${targets.length > 1 ? 's' : ''} `
      + `(${formatSize(total)})`);

    for (const [index, target] of targets.entries()) {
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_GAP_MS));
      }
      link.href = target.href;
      link.download = target.name;
      link.click();
    }
  }, [run]);

  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(''), 6000);
    return () => window.clearTimeout(timer);
  }, [status]);

  // One line per file so an interrupted pull resumes per file, which a single
  // archive download could not do. The archive gets `-o <name>`, not `-O`: its
  // URL ends in a fingerprint, so -O would write a file named after the hash.
  // That URL is only good while the frames behind it are unchanged — once a scan
  // or a stitch replaces them the line 404s rather than resuming onto different
  // bytes, and the panel shows the new one on its next poll.
  const commands = base
    ? [
        ...run.map((file) =>
          `curl -C - -O ${base}/mosaic/file/${encodeURIComponent(file.name)}`),
        ...(frames
          ? [`curl -C - -o ${frames.name} ${base}${frames.url}`]
          : []),
      ]
    : [];

  // Enabled when there is either a map or a frame: mid-scan the frames exist
  // before any mosaic does, and after a successful stitch the map outlives them.
  const label = (() => {
    const maps = run.length > 1 ? `${run.length} maps` : run.length ? 'map' : '';
    const tiles = frames ? `${frames.count} frames` : '';
    if (maps && tiles) return `Download ${maps} + ${tiles}`;
    if (maps) return `Download ${maps}`;
    if (tiles) return `Download ${tiles}`;
    return 'No map yet';
  })();

  const idle = [
    ...run.map((file) => `${file.name} · ${formatSize(file.bytes)}`),
    ...(frames
      ? [`${frames.name} · ${frames.count} frames · ${formatSize(frames.bytes)}`]
      : []),
  ];

  return (
    <section className="border border-bg-border bg-bg-panel p-4 space-y-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-dim">
        Stitched map
      </div>

      <Button variant="ghost" className="w-full"
              disabled={!run.length && !frames}
              onClick={() => void download()}>
        {label}
      </Button>
      {/* Click target for the download; never rendered visibly. */}
      <a ref={linkRef} className="hidden" aria-hidden="true" />

      <div role="status" className="whitespace-pre-line font-mono text-[10px] text-ink-dim">
        {status || (idle.length
          ? idle.join('\n')
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
