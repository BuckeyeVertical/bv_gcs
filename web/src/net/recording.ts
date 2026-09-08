import { create } from 'zustand';

interface WritableFile {
  write(data: ArrayBuffer): Promise<void>;
  close(): Promise<void>;
}
type SavePicker = (options: unknown) => Promise<{ createWritable(): Promise<WritableFile> }>;
export const useRecording = create<{ state: 'idle' | 'choosing' | 'recording' | 'saving'; message: string }>(() => ({ state: 'idle', message: '' }));
let stop: (() => void) | null = null;
export function stopRecording() { stop?.(); }

/** A separate subscriber gets the relay's cached init and fragment alignment.
 * Save complete MP4 boxes only, without decoding or buffering the whole feed.
 */
export async function startRecording() {
  if (useRecording.getState().state !== 'idle') return;
  useRecording.setState({ state: 'choosing', message: '' });
  const filename = `bv-camera-${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`;
  let file: WritableFile | undefined;
  try {
    const picker = (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    if (picker) {
      const handle = await picker.call(window, { suggestedName: filename, types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }] });
      file = await handle.createWritable();
    }
  } catch (error) {
    useRecording.setState({ state: 'idle', message: error instanceof DOMException && error.name === 'AbortError' ? '' : `Could not open recording: ${String(error)}` });
    return;
  }

  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/video`);
  ws.binaryType = 'arraybuffer';
  let buffer = new Uint8Array(0);
  let chain = Promise.resolve();
  let queued = 0;
  let total = 0;
  let media = false;
  let finished = false;
  let writeError = '';
  const chunks: ArrayBuffer[] = [];
  let timer: ReturnType<typeof setTimeout>;
  const finish = (reason = '') => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    ws.close();
    stop = null;
    useRecording.setState({ state: 'saving', message: 'Saving…' });
    void chain.then(async () => {
      if (file) await file.close();
      else if (media) {
        const url = URL.createObjectURL(new Blob(chunks, { type: 'video/mp4' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      useRecording.setState({ state: 'idle', message: writeError ? `Recording incomplete: ${writeError}` : media ? `${file ? 'Saved' : 'Downloaded'} ${filename}${reason ? ` (${reason})` : ''}` : `No camera frames received. ${reason}` });
    }).catch(error => useRecording.setState({ state: 'idle', message: `Save failed: ${String(error)}` }));
  };
  stop = () => finish();
  const armTimeout = () => { clearTimeout(timer); timer = setTimeout(() => finish('Feed timed out'), 15_000); };
  armTimeout();
  useRecording.setState({ state: 'recording', message: file ? `Recording to ${filename}` : 'Recording locally; downloads on stop (256 MB limit).' });
  ws.onmessage = event => {
    if (finished || !(event.data instanceof ArrayBuffer)) return;
    armTimeout();
    const incoming = new Uint8Array(event.data);
    if (buffer.length + incoming.length > 32 * 1024 * 1024) { finish('Invalid or oversized MP4 box'); return; }
    const joined = new Uint8Array(buffer.length + incoming.length);
    joined.set(buffer); joined.set(incoming, buffer.length); buffer = joined;
    while (buffer.length >= 8) {
      const size = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0);
      if (size < 8 || size > 32 * 1024 * 1024) { finish('Unsupported MP4 box'); return; }
      if (buffer.length < size) break;
      const data = buffer.slice(0, size).buffer;
      const type = String.fromCharCode(...buffer.subarray(4, 8));
      buffer = buffer.slice(size);
      if ((!file && total + size > 256 * 1024 * 1024) || (file && queued + size > 64 * 1024 * 1024)) { finish('Recording size/buffer limit reached'); return; }
      total += size;
      if (type === 'mdat') media = true;
      if (file) {
        queued += size;
        chain = chain.then(async () => {
          if (!writeError) await file!.write(data);
        }).catch(error => { writeError = String(error); finish('Disk write failed'); }).finally(() => { queued -= size; });
      } else chunks.push(data);
    }
  };
  ws.onclose = () => finish('Feed disconnected');
  ws.onerror = () => finish('Video connection failed');
}

window.addEventListener('beforeunload', event => {
  if (useRecording.getState().state !== 'idle') { event.preventDefault(); event.returnValue = ''; }
});
