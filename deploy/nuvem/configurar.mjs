// Configurador do primeiro acesso do escritório na nuvem (deploy/nuvem). Roda uma vez, como root, logo depois da
// instalação, ocupando a mesma porta que depois será do escritório (o Caddy já serve o HTTPS na frente).
//
// Só atende quem tem o código de configuração (vai no link que o Davi recebeu junto com o texto da instalação):
//   1. o Davi escolhe usuário e senha: grava SÓ o hash scrypt (mesmo formato de server/remote/password.ts);
//   2. mostra a chave de deploy do servidor; o Davi a cadastra no repositório das salas (com escrita) e clica em
//      "Já adicionei": o servidor clona as salas, marca o escritório como pronto, sai e liga o escritório.
// Sem dependências: só Node.
import { execFile } from 'node:child_process';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname } from 'node:path';

const env = process.env;
const CODE = (env.CONFIG_CODE ?? '').trim();
const PORT = Number(env.CONFIG_PORT ?? 4748);
const HOST = env.CONFIG_HOST ?? '127.0.0.1';
const ETC = env.CONFIG_ETC ?? '/etc/escritorio';
const LOGIN_ENV = `${ETC}/login.env`;
const READY = `${ETC}/pronto`;
const REPO = env.CONFIG_REPO ?? 'secoondsz/escritorio-agentes';
const ROOMS = env.CONFIG_ROOMS ?? '/home/escritorio/escritorio';
const RUN_AS = env.CONFIG_USER ?? 'escritorio';
const HOME_DIR = env.CONFIG_HOME ?? `/home/${RUN_AS}`;
const PUBKEY = env.CONFIG_PUBKEY ?? '/home/escritorio/.ssh/id_ed25519.pub';
const START_CMD = env.CONFIG_START ?? 'systemctl start escritorio';
const DRY = env.CONFIG_DRY === '1'; // testes: não troca de usuário nem liga serviço
const MIN_PASSWORD = 10;

if (CODE.length < 16) {
  console.error('CONFIG_CODE ausente ou curto demais.');
  process.exit(1);
}

// ---------- senha (scrypt, igual a server/remote/password.ts) ----------
function hashPassword(password) {
  const logN = 15, r = 8, p = 1;
  const salt = randomBytes(16);
  return new Promise((ok, fail) =>
    scrypt(password.normalize('NFC'), salt, 32, { N: 2 ** logN, r, p, maxmem: 256 * 2 ** logN * r }, (err, key) =>
      err ? fail(err) : ok(`scrypt:${logN}:${r}:${p}:${salt.toString('base64url')}:${key.toString('base64url')}`)),
  );
}

function codeOk(value) {
  const a = Buffer.from(String(value ?? ''));
  const b = Buffer.from(CODE);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- tentativas ----------
let fails = 0;
let lockedUntil = 0;
function blocked() { return Date.now() < lockedUntil; }
function failed() { if (++fails >= 10) { lockedUntil = Date.now() + 15 * 60_000; fails = 0; } }

// ---------- páginas ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function page(title, body) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font-family:system-ui,sans-serif;background:#1d2230;color:#eef;margin:0;display:flex;justify-content:center;padding:24px}
main{max-width:520px;width:100%;background:#2a3142;border-radius:14px;padding:24px;box-shadow:0 8px 30px #0006}
h1{font-size:22px;margin:0 0 6px}p,li{line-height:1.5;color:#cfd6e6}label{display:block;margin:14px 0 4px;font-weight:600}
input{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #556;background:#1d2230;color:#fff;font-size:16px}
button{margin-top:18px;width:100%;padding:13px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-size:16px;font-weight:700;cursor:pointer}
code,textarea{font-family:ui-monospace,monospace}textarea{width:100%;box-sizing:border-box;height:90px;border-radius:8px;background:#111522;color:#9fe;border:1px solid #556;padding:10px;font-size:13px}
.erro{background:#5b1f2a;color:#ffd6dc;padding:10px 12px;border-radius:8px;margin-top:12px}.passo{color:#8fb3ff;font-size:13px;font-weight:700;text-transform:uppercase}
a{color:#8fb3ff}</style></head><body><main>${body}</main></body></html>`;
}
function send(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
  res.end(html);
}
const hasLogin = () => existsSync(LOGIN_ENV);

function stepPassword(code, error = '') {
  return page('Escritório: primeiro acesso', `<div class="passo">Passo 1 de 2</div><h1>Crie o seu login</h1>
<p>É com ele que você entra no escritório pelo celular ou por qualquer computador.</p>
<form method="post" action="/senha"><input type="hidden" name="codigo" value="${esc(code)}">
<label for="u">Usuário</label><input id="u" name="usuario" value="davi" autocomplete="username" required>
<label for="s">Senha (mínimo ${MIN_PASSWORD} caracteres)</label><input id="s" name="senha" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD}">
<label for="s2">Repita a senha</label><input id="s2" name="senha2" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD}">
${error ? `<div class="erro">${esc(error)}</div>` : ''}<button>Salvar e continuar</button></form>`);
}

function stepGithub(code, error = '') {
  let key = '';
  try { key = readFileSync(PUBKEY, 'utf8').trim(); } catch { key = '(chave não encontrada)'; }
  return page('Escritório: ligar as salas', `<div class="passo">Passo 2 de 2</div><h1>Ligar as salas ao GitHub</h1>
<p>O servidor precisa de permissão para baixar e guardar as salas no seu repositório <b>${esc(REPO)}</b>.</p>
<ol><li>Copie a chave abaixo.</li>
<li>Abra <a href="https://github.com/${esc(REPO)}/settings/keys/new" target="_blank" rel="noopener">esta página do GitHub</a>.</li>
<li>Em <b>Title</b> escreva <code>servidor</code>, cole a chave em <b>Key</b> e marque <b>Allow write access</b>.</li>
<li>Clique em <b>Add key</b> e volte aqui.</li></ol>
<textarea readonly onclick="this.select()">${esc(key)}</textarea>
<form method="post" action="/github"><input type="hidden" name="codigo" value="${esc(code)}">
${error ? `<div class="erro">${esc(error)}</div>` : ''}<button>Já adicionei, ligar o escritório</button></form>`);
}

function stepDone() {
  return page('Escritório: ligando', `<h1>Pronto! Ligando o escritório…</h1>
<p>Em alguns segundos esta página vira a tela de login. Entre com o usuário e a senha que você acabou de criar.</p>
<p>Depois, abra uma sala, clique em <b>Conversar</b> e faça o login do Claude (só na primeira vez).</p>
<script>setTimeout(function w(){fetch('/',{cache:'no-store'}).then(function(r){if(r.ok&&r.headers.get('x-config')!=='1')location.href='/';else setTimeout(w,3000)}).catch(function(){setTimeout(w,3000)})},6000)</script>`);
}

function readForm(req) {
  return new Promise((ok, fail) => {
    let size = 0; const parts = [];
    req.on('data', (c) => { size += c.length; if (size > 16 * 1024) { req.destroy(); fail(new Error('grande demais')); } else parts.push(c); });
    req.on('end', () => ok(new URLSearchParams(Buffer.concat(parts).toString('utf8'))));
    req.on('error', fail);
  });
}

function run(cmd, args, opts = {}) {
  return new Promise((ok) => execFile(cmd, args, { timeout: 180_000, ...opts }, (err, stdout, stderr) => ok({ ok: !err, out: `${stdout}${stderr}`.trim() })));
}
function asUser(cmd, args) {
  // runuser -u não troca o HOME: o git e o ssh precisam da casa do usuário do escritório.
  return DRY ? run(cmd, args) : run('runuser', ['-u', RUN_AS, '--', 'env', `HOME=${HOME_DIR}`, cmd, ...args], { cwd: HOME_DIR });
}

async function cloneRooms() {
  const url = env.CONFIG_REPO_URL ?? `git@github.com:${REPO}.git`;
  const probe = await asUser('git', ['ls-remote', url]);
  if (!probe.ok) {
    return /denied|publickey|not found|Could not read/i.test(probe.out)
      ? 'O GitHub ainda não aceitou a chave. Confira se colou a chave inteira e marcou "Allow write access", espere uns segundos e tente de novo.'
      : `Não consegui falar com o GitHub: ${probe.out.slice(0, 200)}`;
  }
  if (!existsSync(`${ROOMS}/.git`)) {
    const clone = await asUser('git', ['clone', url, ROOMS]);
    if (!clone.ok) return `Não consegui baixar as salas: ${clone.out.slice(0, 200)}`;
  }
  return '';
}

let finishing = false;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  res.setHeader('x-config', '1');
  try {
    if (finishing) return send(res, 200, stepDone());
    if (blocked()) return send(res, 429, page('Espere', '<h1>Muitas tentativas</h1><p>Tente de novo em 15 minutos.</p>'));
    if (req.method === 'GET') {
      const code = url.searchParams.get('codigo');
      if (!codeOk(code)) { if (code) failed(); return send(res, 403, page('Escritório', '<h1>Escritório em configuração</h1><p>Abra pelo link de configuração que veio junto com a instalação.</p>')); }
      return send(res, 200, hasLogin() ? stepGithub(code) : stepPassword(code));
    }
    if (req.method !== 'POST') return send(res, 405, page('Erro', '<h1>Método não permitido</h1>'));
    const form = await readForm(req);
    const code = form.get('codigo');
    if (!codeOk(code)) { failed(); return send(res, 403, page('Escritório', '<h1>Código inválido</h1>')); }
    if (url.pathname === '/senha') {
      const user = (form.get('usuario') ?? '').trim();
      const a = form.get('senha') ?? '', b = form.get('senha2') ?? '';
      if (!/^[A-Za-z0-9._-]{2,32}$/.test(user)) return send(res, 400, stepPassword(code, 'Usuário: só letras, números, ponto, hífen e sublinhado (2 a 32).'));
      if (a.length < MIN_PASSWORD) return send(res, 400, stepPassword(code, `A senha precisa de pelo menos ${MIN_PASSWORD} caracteres.`));
      if (a !== b) return send(res, 400, stepPassword(code, 'As duas senhas não são iguais.'));
      const hash = await hashPassword(a);
      mkdirSync(dirname(LOGIN_ENV), { recursive: true });
      writeFileSync(LOGIN_ENV, `HABBLAUD_REMOTE_USER=${user}\nHABBLAUD_REMOTE_PASSWORD_HASH=${hash}\n`, { mode: 0o600 });
      return send(res, 200, stepGithub(code));
    }
    if (url.pathname === '/github') {
      if (!hasLogin()) return send(res, 200, stepPassword(code));
      const problem = await cloneRooms();
      if (problem) return send(res, 200, stepGithub(code, problem));
      writeFileSync(READY, `${new Date().toISOString()}\n`);
      finishing = true;
      send(res, 200, stepDone());
      setTimeout(() => {
        server.close();
        server.closeAllConnections?.();
        const [cmd, ...args] = START_CMD.split(' ');
        execFile(cmd, args, () => process.exit(0));
      }, 1500);
      return;
    }
    send(res, 404, page('Erro', '<h1>Página não encontrada</h1>'));
  } catch (err) {
    send(res, 500, page('Erro', `<h1>Erro</h1><p>${esc(err?.message ?? err)}</p>`));
  }
});

if (existsSync(READY)) {
  console.log('Escritório já configurado: nada a fazer.');
  process.exit(0);
}
server.listen(PORT, HOST, () => console.log(`Configurador em http://${HOST}:${PORT}`));
