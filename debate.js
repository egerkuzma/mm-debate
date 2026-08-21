const WebSocket = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const URL = process.env.MM_URL || 'http://localhost:8065';
const PERSONAS_DIR = path.resolve(process.env.PERSONAS_DIR || './personas');
const SESSIONS = path.join(__dirname, 'debate-sessions.json');

const ALLOWED = (process.env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);

const PAUSE = Number(process.env.PAUSE_MS || 60000);
const HARD_LIMIT = Number(process.env.HARD_LIMIT || 200);
const CHECKPOINT = Number(process.env.CHECKPOINT || 30);
const MAX_TURNS = Number(process.env.MAX_TURNS || 6);
const TOOLS = process.env.ALLOWED_TOOLS || 'WebSearch,WebFetch';

const BOTS = {};

let sessions = fs.existsSync(SESSIONS) ? JSON.parse(fs.readFileSync(SESSIONS)) : {};
const active = new Map();

const api = (token, p, opts = {}) => fetch(URL + '/api/v4' + p, {
  ...opts,
  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...opts.headers }
}).then(r => r.json());

const say = (key, channel_id, message, root_id) =>
  api(BOTS[key].token, '/posts', { method: 'POST', body: JSON.stringify({ channel_id, message, root_id }) });

function think(key, prompt, sessionKey) {
  return new Promise(resolve => {
    const args = ['-p', '--output-format', 'json', '--allowedTools', TOOLS, '--max-turns', String(MAX_TURNS)];
    if (sessions[sessionKey]) args.push('--resume', sessions[sessionKey]);
    const p = spawn('claude', args, { cwd: BOTS[key].dir });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.stdin.write(prompt); p.stdin.end();
    p.on('close', () => {
      try {
        const j = JSON.parse(out);
        if (j.session_id) { sessions[sessionKey] = j.session_id; fs.writeFileSync(SESSIONS, JSON.stringify(sessions)); }
        resolve({ text: j.result, cost: j.total_cost_usd || 0 });
      } catch { resolve({ text: null }); }
    });
  });
}

async function debate(thread, channel, topic, first) {
  const st = { stop: false, turns: 0, spent: 0, paused: false, injected: [] };
  active.set(thread, st);
  const keys = Object.keys(BOTS);
  let speaker = first;
  let last = null;

  while (!st.stop && st.turns < HARD_LIMIT) {
    const other = keys.find(k => k !== speaker);
    let prompt = last
      ? `Тема: ${topic}\n\n${BOTS[other].name} только что сказал:\n"${last}"\n\nОтветь ему.`
      : `Тема: ${topic}\n\nТы начинаешь. Дай первую реплику.`;
    if (st.injected.length) {
      prompt += `\n\nВедущий разговора вмешался:\n"${st.injected.join('\n')}"\nУчти это.`;
      st.injected = [];
    }

    const r = await think(speaker, prompt, speaker + ':' + thread);
    if (st.stop) break;
    if (r.text) { await say(speaker, channel, r.text, thread); last = r.text; }
    else { await say(speaker, channel, '_(сбой, пропускаю ход)_', thread); }

    st.turns++; st.spent += r.cost || 0;
    console.log(`[${thread.slice(0, 6)}] ход ${st.turns} (${speaker}), потрачено ${st.spent.toFixed(2)}`);

    if (st.turns % CHECKPOINT === 0) {
      await say(speaker, channel, `_Пауза после ${st.turns} реплик. Напиши «дальше» или «стоп»._`, thread);
      st.paused = true;
      while (st.paused && !st.stop) await new Promise(r => setTimeout(r, 1000));
      if (st.stop) break;
    }

    speaker = other;
    for (let i = 0; i < PAUSE / 500 && !st.stop; i++) await new Promise(r => setTimeout(r, 500));
  }

  active.delete(thread);
  console.log(`[${thread.slice(0, 6)}] окончено: ходов ${st.turns}, потрачено ${st.spent.toFixed(2)}`);
}

function handle(p) {
  const thread = p.root_id || p.id;
  const text = p.message.trim();
  const low = text.toLowerCase();

  const st = active.get(thread);
  if (st) {
    if (/^(стоп|хватит|stop)/.test(low)) { st.stop = true; st.paused = false; }
    else if (/^(дальше|продолж|go)/.test(low)) { st.paused = false; }
    else st.injected.push(text);
    return;
  }

  const keys = Object.keys(BOTS);
  const mentioned = keys.filter(k => text.includes('@' + BOTS[k].username));
  if (mentioned.length < 2) return;

  let first = mentioned[0];
  for (const k of keys) {
    const re = new RegExp(`(${BOTS[k].username}|${BOTS[k].name})[^.]*?(перв|начин)`, 'i');
    if (re.test(text)) { first = k; break; }
  }

  const topic = text.replace(/@\w+/g, '').trim();
  console.log('новая дискуссия:', topic.slice(0, 60), '| первым', first);
  debate(thread, p.channel_id, topic, first).catch(e => console.error(e));
}

function connect(key) {
  const ws = new WebSocket(URL.replace(/^http/, 'ws') + '/api/v4/websocket');
  let alive;
  ws.on('open', () => {
    ws.send(JSON.stringify({ seq: 1, action: 'authentication_challenge', data: { token: BOTS[key].token } }));
    alive = setInterval(() => { if (ws.readyState === 1) ws.ping(); }, 20000);
    console.log('слушаю от имени', BOTS[key].username);
  });
  ws.on('error', e => console.error('ws:', e.message));
  ws.on('message', raw => {
    const ev = JSON.parse(raw);
    if (ev.event !== 'posted') return;
    const p = JSON.parse(ev.data.post);
    if (Object.values(BOTS).some(b => b.id === p.user_id)) return;
    if (ALLOWED.length && !ALLOWED.includes(p.user_id)) return;
    handle(p);
  });
  ws.on('close', () => { clearInterval(alive); setTimeout(() => connect(key), 3000); });
}

(async () => {
  const tokens = { a: process.env.MM_TOKEN_A, b: process.env.MM_TOKEN_B };
  const dirs = fs.readdirSync(PERSONAS_DIR).filter(d =>
    fs.statSync(path.join(PERSONAS_DIR, d)).isDirectory()).sort();

  if (dirs.length < 2) { console.error('нужно два каталога в', PERSONAS_DIR); process.exit(1); }
  if (!tokens.a || !tokens.b) { console.error('задай MM_TOKEN_A и MM_TOKEN_B в .env'); process.exit(1); }

  const pairs = [['a', dirs[0]], ['b', dirs[1]]];
  for (const [slot, dir] of pairs) {
    const me = await api(tokens[slot], '/users/me');
    if (!me.id) { console.error('токен', slot, 'не работает:', me.message); process.exit(1); }
    BOTS[dir] = { token: tokens[slot], id: me.id, username: me.username,
                  name: me.first_name || me.username, dir: path.join(PERSONAS_DIR, dir) };
    console.log(`${dir} → @${me.username} (${me.id})`);
  }
  connect(Object.keys(BOTS)[0]);
})();
