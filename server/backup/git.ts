// Backup automático da pasta do escritório num repositório privado do GitHub (fork secoondsz).
// Com HABBLAUD_BACKUP_REPO=<url do repositório>, a pasta das salas (HABBLAUD_SALAS) vira um repositório git (se ainda
// não for), ganha um .gitignore que deixa de fora os dados de clientes (sala Pedidos) e segredos, e a cada poucos
// minutos o que mudou vira um commit e sobe para o GitHub. O git guarda todas as versões: mesmo um arquivo apagado
// continua no histórico. O login no GitHub é o do Git para Windows (Git Credential Manager): na primeira vez ele abre a
// janela de login sozinho.
import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { errMsg, log } from '../log';

export const GITIGNORE = `# Escritório de agentes — o que NÃO vai para a nuvem
# Dados de clientes (nomes, endereços, telefones): ficam só neste computador (LGPD)
pedidos/
# Segredos e configurações locais
*.env
.env*
**/.claude/settings.local.json
**/credenciais*
**/*senha*
# Arquivos temporários
.obsidian/workspace*.json
.trash/
~$*
*.tmp
`;

export interface BackupStatus {
  state: 'off' | 'starting' | 'ok' | 'pending' | 'error';
  /** Último envio para o GitHub que deu certo (epoch ms). */
  lastPushAt?: number;
  /** Último commit local (epoch ms). */
  lastCommitAt?: number;
  error?: string;
  repo?: string;
}

export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export const runGit: GitRunner = (args, cwd) =>
  new Promise((ok, fail) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) fail(new Error((stderr || err.message).toString().trim().split('\n').slice(-2).join(' ')));
      else ok(stdout.toString());
    });
  });

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface BackupOptions {
  root: string;
  repo: string;
  git?: GitRunner;
  intervalMs?: number;
  now?: () => number;
}

export class GitBackup {
  private st: BackupStatus;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private ready = false;
  private git: GitRunner;

  constructor(private o: BackupOptions) {
    this.git = o.git ?? runGit;
    this.st = { state: 'starting', repo: o.repo.replace(/\.git$/, '') };
  }

  status(): BackupStatus {
    return { ...this.st };
  }

  start(): void {
    if (this.timer) return;
    void this.run();
    this.timer = setInterval(() => void this.run(), this.o.intervalMs ?? 3 * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** Prepara a pasta: repositório, .gitignore, autor e o endereço do GitHub. */
  async setup(): Promise<void> {
    const { root, repo } = this.o;
    if (!existsSync(join(root, '.git'))) {
      await this.git(['init'], root);
      await this.git(['checkout', '-B', 'main'], root);
    }
    if (!existsSync(join(root, '.gitignore'))) writeFileSync(join(root, '.gitignore'), GITIGNORE);
    await this.git(['config', 'user.name', 'Escritório de Agentes'], root);
    await this.git(['config', 'user.email', 'escritorio@users.noreply.github.com'], root);
    await this.git(['config', 'core.quotepath', 'false'], root);
    const remotes = (await this.git(['remote'], root)).split(/\s+/).filter(Boolean);
    await this.git(remotes.includes('origin') ? ['remote', 'set-url', 'origin', repo] : ['remote', 'add', 'origin', repo], root);
    this.ready = true;
  }

  /** Uma rodada: commit do que mudou e envio para o GitHub. */
  async run(): Promise<BackupStatus> {
    if (this.running) return this.status();
    this.running = true;
    const root = this.o.root;
    try {
      if (!this.ready) await this.setup();
      await this.git(['add', '-A'], root);
      const changed = (await this.git(['status', '--porcelain'], root)).trim();
      if (changed) {
        await this.git(['commit', '-m', `backup automático ${stamp(new Date(this.now()))}`], root);
        this.st.lastCommitAt = this.now();
      }
      // Sobe se há algo que o GitHub ainda não tem (ou se nunca subiu).
      let ahead = true;
      try {
        ahead = Number((await this.git(['rev-list', '--count', 'origin/main..main'], root)).trim()) > 0;
      } catch {
        ahead = true;
      }
      if (ahead) {
        this.st = { ...this.st, state: 'pending' };
        await this.git(['push', '-u', 'origin', 'main'], root);
      }
      this.st = { ...this.st, state: 'ok', lastPushAt: this.now(), error: undefined };
    } catch (err) {
      const msg = errMsg(err);
      if (/nothing to commit|does not have any commits/i.test(msg)) this.st = { ...this.st, state: 'ok', error: undefined };
      else {
        this.st = { ...this.st, state: 'error', error: msg.slice(0, 300) };
        log.warnOnce(`backup:${msg.slice(0, 60)}`, `Backup no GitHub: ${msg}`);
      }
    } finally {
      this.running = false;
    }
    return this.status();
  }
}
