// Relais WebSocket -> RTMP (YouTube) pour Studio Vidéo
// Marche en local (node relay.js) ET en ligne (Docker / Render).
//
// Si le navigateur envoie déjà du H.264 + AAC (Chrome / Edge récents), le relais
// ne fait que recopier le flux : presque aucun calcul, donc OK sur un serveur gratuit.
//
// Variables d'environnement (toutes facultatives) :
//   PORT             port d'écoute (défaut 8787 ; Render le fournit)
//   HOST             adresse d'écoute (défaut 127.0.0.1 = ce PC seulement ; en ligne : 0.0.0.0)
//   ALLOWED_ORIGINS  sites autorisés, séparés par des virgules (ex : https://mon-studio.vercel.app)
//   MAX_STREAMS      directs en même temps (défaut 2)
//   MAX_MINUTES      durée max d'un direct (défaut 300)

const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');

const PORT = +process.env.PORT || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
const MAX_STREAMS = +process.env.MAX_STREAMS || 2;
const MAX_MS = (+process.env.MAX_MINUTES || 300) * 60 * 1000;

// Seules les adresses YouTube sont acceptées.
const OK_URL = /^rtmps?:\/\/[a-z0-9.-]*\.youtube\.com(:\d+)?\/[A-Za-z0-9_\-\/.]+$/i;

let active = 0;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Relais Studio Vidéo : en ligne\n');
});

const wss = new WebSocketServer({
  server,
  verifyClient: (info) => {
    if (!ALLOWED.length) return true;
    const o = (info.origin || '').replace(/\/$/, '');
    if (ALLOWED.includes(o)) return true;
    console.log('Refusé (origine non autorisée) :', o || 'aucune');
    return false;
  }
});

wss.on('connection', (ws) => {
  let ff = null;
  let counted = false;
  let timer = null;

  const end = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (counted) { active--; counted = false; }
    if (ff) {
      const p = ff; ff = null;
      try { p.stdin.end(); } catch (e) {}
      setTimeout(() => { try { p.kill('SIGINT'); } catch (e) {} }, 1500);
    }
  };

  ws.on('message', (data) => {
    // 1er message (texte) : l'adresse RTMP complète avec la clé
    if (!ff) {
      let cfg;
      try { cfg = JSON.parse(data.toString()); } catch (e) { return ws.close(); }
      if (typeof cfg.url !== 'string' || !OK_URL.test(cfg.url)) {
        console.log('Refusé : adresse de sortie invalide');
        return ws.close();
      }
      if (active >= MAX_STREAMS) {
        console.log('Refusé : trop de directs en même temps');
        return ws.close();
      }
      active++; counted = true;
      console.log('Direct démarré vers', cfg.url.replace(/\/[^/]+$/, '/****'),
        cfg.copy ? '(copie directe H.264)' : '(transcodage)', '- en cours :', active);

      const args = cfg.copy
        ? [
            '-loglevel', 'info',
            '-fflags', '+genpts+nobuffer',
            '-i', 'pipe:0',
            '-c:v', 'copy',
            '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
            '-f', 'flv', cfg.url
          ]
        : [
            '-loglevel', 'info',
            '-i', 'pipe:0',
            '-vf', "scale=-2:'min(720,ih)'",
            '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
            '-pix_fmt', 'yuv420p',
            '-b:v', '2800k', '-maxrate', '2800k', '-bufsize', '5600k',
            '-g', '60', '-r', '30',
            '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
            '-f', 'flv', cfg.url
          ];
      ff = spawn('ffmpeg', args);
      let said = false;
      ff.stderr.on('data', (d) => {
        process.stdout.write(d);
        const txt = d.toString();
        if (!said && /Output #0/.test(txt)) { said = true; try { ws.send(JSON.stringify({ t: 'ready' })); } catch (e) {} }
        const m = txt.match(/(Connection (refused|reset|timed out)|Input\/output error|Server returned [^\n]*|Failed to [^\n]*|Invalid data[^\n]*|Error[^\n]*)/i);
        if (m) { try { ws.send(JSON.stringify({ t: 'err', msg: m[0].slice(0, 160) })); } catch (e) {} }
      });
      ff.on('close', (code) => {
        console.log('ffmpeg terminé (code ' + code + ')');
        ff = null;
        end();
        try { ws.close(); } catch (e) {}
      });
      ff.stdin.on('error', () => {});
      timer = setTimeout(() => { console.log('Durée max atteinte'); try { ws.close(); } catch (e) {} }, MAX_MS);
      return;
    }
    // messages suivants (binaires) : le flux vidéo
    if (ff.stdin.writable) ff.stdin.write(data);
  });

  ws.on('close', () => { end(); console.log('Direct arrêté'); });
  ws.on('error', () => { end(); });
});

server.listen(PORT, HOST, () => {
  console.log('Relais prêt sur le port ' + PORT + ' (' + HOST + ')');
  if (ALLOWED.length) console.log('Sites autorisés :', ALLOWED.join(', '));
});
