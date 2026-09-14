import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Button } from './ui/Button';

/** Local filename for the pull. `-C -` resumes into whatever this names, so it
 *  has to stay stable between the interrupted attempt and the retry. */
const OUTPUT = 'mosaic.jpg';

/**
 * Where the drone actually is, for a command run outside the browser.
 *
 * Not `location.origin`, and not `frameUrl` from net/client.ts: those are right
 * for fetches the *browser* makes, which under `npm run dev` go through vite's
 * proxy. curl gets no proxy, so an origin of localhost:5173 would aim it at the
 * dev server instead of the aircraft. approval_node reports the address it was
 * reached on in /healthz, and vite proxies /healthz with changeOrigin — so this
 * answers with the drone in dev and with itself in production, no build-time
 * branching either way.
 *
 * Falls back to the origin: served from approval_node that is already correct,
 * and it keeps the command on screen when /healthz is unreachable.
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

/**
 * Copy without assuming a secure context.
 *
 * `navigator.clipboard` is undefined on an insecure origin, and the ground
 * station is exactly that: plain `http://<drone-ip>:8765` over Herelink WiFi,
 * neither HTTPS nor localhost. So the execCommand path below is not a legacy
 * fallback for old browsers — in the field it is the only path that runs.
 * Returns false when both fail, so the caller can tell the operator to select
 * the text instead of silently doing nothing.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or no clipboard — fall through to the textarea.
  }

  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  // Fixed and transparent so the copy does not scroll the dashboard.
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  document.body.removeChild(area);
  return copied;
}

/**
 * Hands the operator the resumable pull for the stitched map.
 *
 * The map is large and the link drops, so the fetch has to survive being cut
 * off. `curl -C -` resumes against `GET /mosaic/latest`, which aiohttp serves
 * with Range support. The command is built from `location.origin` so the drone
 * address is already correct — no IP typed from memory mid-mission.
 */
export function MosaicDownloadPanel() {
  const [status, setStatus] = useState('');
  const [base, setBase] = useState(window.location.origin);
  // Whether the server told us that address, as opposed to us assuming it.
  const [confirmed, setConfirmed] = useState(false);
  const commandRef = useRef<HTMLElement>(null);
  const command = `curl -C - -o ${OUTPUT} ${base}/mosaic/latest`;

  useEffect(() => {
    let cancelled = false;
    void resolveBase().then((resolved) => {
      if (cancelled || !resolved) return;
      setBase(resolved);
      setConfirmed(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(''), 4000);
    return () => window.clearTimeout(timer);
  }, [status]);

  const onCopy = async () => {
    if (await copyText(command)) {
      setStatus('Copied — paste into a terminal');
      return;
    }
    // Last resort: select it so the operator's own Cmd-C still works.
    const node = commandRef.current;
    if (node) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    setStatus('Copy blocked — text selected, press Cmd-C');
  };

  return (
    <section className="border border-bg-border bg-bg-panel p-4 space-y-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-dim">
        Stitched map
      </div>
      <Button variant="ghost" className="w-full" onClick={() => void onCopy()}>
        Copy curl
      </Button>
      <code
        ref={commandRef}
        className="block select-all break-all font-mono text-[10px] leading-relaxed text-ink-muted"
      >
        {command}
      </code>
      <div
        role="status"
        className={clsx(
          'font-mono text-[10px]',
          !status && !confirmed ? 'text-accent-amber' : 'text-ink-dim',
        )}
      >
        {status || (confirmed
          ? 'Resumes if the link drops — rerun the same command.'
          : 'Address unconfirmed — approval_node did not report one. Rebuild it '
            + 'if this is not the drone.')}
      </div>
    </section>
  );
}
