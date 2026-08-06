import { useEffect, useState } from 'react';
import { frameUrl } from '../net/client';
import { useGcsStore } from '../store/useGcsStore';

/**
 * The annotated crop — this is what the operator actually judges the detection from,
 * so it gets the largest region of the screen.
 *
 * The image is fetched over plain HTTP, separately from the WebSocket, so it can fail
 * or retry on its own without disturbing the decision path. That also means it needs
 * its own visible loading and error states: a blank panel would be indistinguishable
 * from "the detector found nothing", which is exactly the wrong impression.
 */
export function DetectionImage() {
  const active = useGcsStore((s) => s.activePending);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);

  const path = active?.image_url ?? null;

  useEffect(() => {
    setStatus('loading');
    setAttempt(0);
  }, [path]);

  if (!active) {
    return (
      <Frame>
        <div className="text-center space-y-2">
          <div className="font-mono text-xs uppercase tracking-[0.25em] text-ink-dim">
            No detection awaiting approval
          </div>
          <div className="font-mono text-[10px] text-ink-dim/70">
            The drone is flying autonomously.
          </div>
        </div>
      </Frame>
    );
  }

  if (!path) {
    return (
      <Frame>
        <div className="text-center space-y-2">
          <div className="font-mono text-xs uppercase tracking-[0.2em] text-accent-red">
            No image received
          </div>
          <div className="font-mono text-[10px] text-ink-muted max-w-xs">
            The detection arrived without an annotated crop. Judge with caution — or
            reject and let the drone keep scanning.
          </div>
        </div>
      </Frame>
    );
  }

  return (
    <Frame>
      {status === 'loading' && (
        <div className="absolute font-mono text-[10px] uppercase tracking-[0.2em] text-ink-dim">
          Loading crop…
        </div>
      )}
      {status === 'error' && (
        <div className="absolute text-center space-y-3">
          <div className="font-mono text-xs uppercase tracking-[0.2em] text-accent-red">
            Image failed to load
          </div>
          <button
            className="font-mono text-[10px] uppercase tracking-wider text-accent-blue underline"
            onClick={() => {
              setStatus('loading');
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}
      <img
        // attempt is part of the key so Retry actually refetches rather than
        // reusing the browser's cached failure.
        key={`${path}#${attempt}`}
        src={attempt === 0 ? frameUrl(path) : `${frameUrl(path)}?r=${attempt}`}
        alt={`Annotated detection: ${active.class_name}`}
        onLoad={() => setStatus('ready')}
        onError={() => setStatus('error')}
        className={
          'max-h-full max-w-full object-contain transition-opacity duration-150 ' +
          (status === 'ready' ? 'opacity-100' : 'opacity-0')
        }
      />
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden border border-bg-border bg-black/40">
      {children}
    </div>
  );
}
