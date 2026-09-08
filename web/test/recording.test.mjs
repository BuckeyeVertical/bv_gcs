import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function setup() {
  const writes = [];
  let closed = false;
  let socket;
  const source = fs.readFileSync(new URL('../src/net/recording.ts', import.meta.url), 'utf8')
    .replace("import { create } from 'zustand';", '')
    .replaceAll('export ', '');
  const context = vm.createContext({
    create: initializer => { let state = initializer(); return { getState: () => state, setState: patch => { state = { ...state, ...patch }; } }; },
    window: { addEventListener() {}, showSaveFilePicker: async () => ({ createWritable: async () => ({ write: async data => writes.push(data), close: async () => { closed = true; } }) }) },
    location: { protocol: 'http:', host: 'localhost' },
    WebSocket: class { constructor() { socket = this; } close() {} },
    Uint8Array, ArrayBuffer, DataView, DOMException, setTimeout, clearTimeout,
  });
  vm.runInContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022 }) + '\nglobalThis.api = { startRecording, stopRecording, useRecording };', context);
  return { api: context.api, writes, get closed() { return closed; }, send: data => socket.onmessage({ data }), disconnect: () => socket.onclose() };
}
function box(type, payload = []) {
  const result = new Uint8Array(8 + payload.length);
  new DataView(result.buffer).setUint32(0, result.length);
  result.set([...type].map(c => c.charCodeAt(0)), 4);
  result.set(payload, 8);
  return result;
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('writes incoming MP4 boxes intact across arbitrary websocket chunks and closes on stop', async () => {
  const session = setup();
  await session.api.startRecording();
  const init = box('ftyp');
  const media = box('mdat', [1, 2, 3]);
  session.send(init.buffer);
  session.send(media.slice(0, 5).buffer);
  session.send(media.slice(5).buffer);
  session.api.stopRecording();
  await settle();
  assert.equal(session.closed, true);
  assert.deepEqual(session.writes.map(b => [...new Uint8Array(b)]), [[...init], [...media]]);
  assert.equal(session.api.useRecording.getState().state, 'idle');
  assert.match(session.api.useRecording.getState().message, /^Saved/);
});

test('disconnect finalizes complete boxes and discards incomplete trailing data', async () => {
  const session = setup();
  await session.api.startRecording();
  session.send(box('mdat', [1]).buffer);
  session.send(box('mdat', [2, 3]).slice(0, 9).buffer);
  session.disconnect();
  await settle();
  assert.equal(session.writes.length, 1);
  assert.equal(session.closed, true);
  assert.match(session.api.useRecording.getState().message, /Feed disconnected/);
});
