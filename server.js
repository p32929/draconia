// Tiny YouTube "watched" tracker. No npm packages. Run: node server.js  (PORT env var to change the port)
// Serves index.html + data.json. Adds what a static host can't: watched list on disk, and "Refresh stats" via yt-dlp.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 47821;
const DATA = path.join(__dirname, 'data.json');     // { updated, videos: [{ id, title, ..., history: [{ date, views, likes, comments }] }] }
const WATCHED = path.join(__dirname, 'watched.json'); // { "<videoId>": true }

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// ---------- stats via yt-dlp ----------
// proxies.txt (one host:port per line) spreads requests over many IPs so YouTube doesn't block us.
const PROXIES = fs.existsSync(path.join(__dirname, 'proxies.txt'))
  ? fs.readFileSync(path.join(__dirname, 'proxies.txt'), 'utf8').split(/\s+/).filter(Boolean) : [];
function ytdlp(id, proxy) {
  const args = ['-j', '--skip-download', '--no-warnings', '--socket-timeout', '15'];
  args.push(...(proxy ? ['--proxy', `http://${proxy}`] : ['--sleep-requests', '1']));
  return new Promise((resolve) => {
    execFile('yt-dlp', [...args, `https://www.youtube.com/watch?v=${id}`], { maxBuffer: 50 * 1024 * 1024, timeout: 60000 },
      (err, out) => { try { resolve(err ? null : JSON.parse(out)); } catch { resolve(null); } });
  });
}
async function fetchInfo(id) {
  for (let i = 0; i < 4 && PROXIES.length; i++) { // free proxies die often: try a few, then go direct
    const j = await ytdlp(id, PROXIES[Math.floor(Math.random() * PROXIES.length)]);
    if (j) return j;
  }
  return ytdlp(id);
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const data = readJson(DATA, { videos: [] });
    const today = new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD
    const queue = data.videos.filter(v => v.fetched !== today); // pressing again the same day only fills the gaps
    let done = 0;
    const worker = async () => {
      for (let v; (v = queue.shift());) {
        if (++done % 100 === 0) writeJson(DATA, data); // save progress, a full run takes a while
        const j = await fetchInfo(v.id);
        if (!j) { if (!v.title) v.error = 'Could not load (private or deleted?)'; continue; } // keep old data
        delete v.error;
        Object.assign(v, {
          fetched: today,
          title: j.title, channel: j.channel, channelUrl: j.channel_url, handle: j.uploader_id,
          subscribers: j.channel_follower_count, duration: j.duration_string,
          uploaded: j.timestamp ? new Date(j.timestamp * 1000).toISOString() : j.upload_date,
        });
        const snap = { date: today, views: j.view_count, likes: j.like_count, comments: j.comment_count };
        v.history = (v.history || []).filter(h => h.date !== today).concat(snap); // one snapshot per day
      }
    };
    await Promise.all(Array.from({ length: PROXIES.length ? 150 : 3 }, worker)); // without proxies, more than 3 gets us blocked
    data.updated = new Date().toISOString();
    writeJson(DATA, data);
  } finally { refreshing = false; }
}

// ---------- server ----------
http.createServer(async (req, res) => {
  const toggle = req.method === 'POST' && req.url.match(/^\/api\/toggle\/([\w-]{11})$/);
  if (toggle) {
    const id = toggle[1];
    if (!readJson(DATA, { videos: [] }).videos.some(v => v.id === id)) { res.writeHead(404); return res.end(); }
    const w = readJson(WATCHED, {});
    if (w[id]) delete w[id]; else w[id] = true;
    writeJson(WATCHED, w);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ watched: !!w[id] }));
  }
  if (req.method === 'POST' && req.url === '/api/refresh') {
    await refresh();
    res.writeHead(200); return res.end('ok');
  }
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/api/watched') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(readJson(WATCHED, {})));
  }
  const file = { '/': 'index.html', '/index.html': 'index.html', '/data.json': 'data.json' }[url.pathname];
  if (req.method === 'GET' && file) {
    res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/json' });
    return fs.createReadStream(path.join(__dirname, file)).pipe(res);
  }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => console.log(`Open http://localhost:${PORT}`));
