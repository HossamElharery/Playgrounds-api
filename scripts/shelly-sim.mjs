#!/usr/bin/env node
// Pretend to be one or more Shelly Gen2+ plugs connected to a venue's device link, for demos and
// manual testing without hardware.
//   node scripts/shelly-sim.mjs <ws-link> [count=2] [prefix=shellyplugsg3-sim]
// Type "p <n>" + Enter to press plug n's button, "q" to quit.
import { createInterface } from 'node:readline';
import { WebSocket } from 'ws';

const [url, countArg = '2', prefix = 'shellyplugsg3-sim'] = process.argv.slice(2);
if (!url) {
  console.error('usage: node scripts/shelly-sim.mjs <ws-link> [count] [prefix]');
  process.exit(1);
}

function plug(index) {
  const id = `${prefix}${String(index).padStart(6, '0')}`;
  let output = false;
  let timer;
  let ws;
  const status = (source) => ({ id: 0, source, output, apower: output ? 80 + index * 7.5 : 0, voltage: 229.8 });
  const send = (frame) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(frame));
  const notify = (source) => send({ src: id, dst: 'ws', method: 'NotifyStatus', params: { ts: Date.now() / 1000, 'switch:0': status(source) } });
  const set = (on, source) => {
    output = on;
    console.log(`${id}: ${on ? 'ON ' : 'OFF'} (${source})`);
    notify(source);
  };
  const connect = () => {
    ws = new WebSocket(url);
    ws.on('open', () => {
      console.log(`${id}: connected`);
      send({ src: id, dst: 'ws', method: 'NotifyFullStatus', params: { ts: Date.now() / 1000, 'switch:0': status('init') } });
    });
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw));
      if (req.method === 'Switch.Set') {
        const was = output;
        clearTimeout(timer);
        send({ id: req.id, src: id, dst: req.src, result: { was_on: was } });
        set(req.params.on === true, 'WS_in');
        if (req.params.toggle_after > 0) {
          console.log(`${id}: will flip back in ${req.params.toggle_after}s`);
          timer = setTimeout(() => set(!output, 'timer'), req.params.toggle_after * 1000);
        }
      } else if (req.method === 'Switch.SetConfig') {
        console.log(`${id}: config ${JSON.stringify(req.params.config)}`);
        send({ id: req.id, src: id, dst: req.src, result: { restart_required: false } });
      } else {
        send({ id: req.id, src: id, dst: req.src, error: { code: 404, message: `No handler for ${req.method}` } });
      }
    });
    ws.on('unexpected-response', (_req, res) => console.log(`${id}: refused HTTP ${res.statusCode}`));
    ws.on('close', () => {
      console.log(`${id}: disconnected, retrying in 3s`);
      setTimeout(connect, 3000);
    });
    ws.on('error', () => undefined);
  };
  connect();
  return { press: () => set(!output, 'button') };
}

const plugs = Array.from({ length: Number(countArg) || 1 }, (_, i) => plug(i + 1));
createInterface({ input: process.stdin }).on('line', (line) => {
  const [cmd, n] = line.trim().split(/\s+/);
  if (cmd === 'q') process.exit(0);
  if (cmd === 'p') plugs[(Number(n) || 1) - 1]?.press();
});
