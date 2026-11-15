import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitBackup } from './git';

describe('backup no git', () => {
  it('cria o repositório, deixa Pedidos de fora e sobe para o remoto', async () => {
    const base = mkdtempSync(join(tmpdir(), 'bk-'));
    const remote = join(base, 'remoto.git');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    const root = join(base, 'escritorio');
    mkdirSync(join(root, 'ofertas-br'), { recursive: true });
    mkdirSync(join(root, 'pedidos'), { recursive: true });
    writeFileSync(join(root, 'ofertas-br', 'CLAUDE.md'), '# Operação: Ofertas BR');
    writeFileSync(join(root, 'pedidos', 'clientes.md'), 'Maria, Rua X 123');
    const b = new GitBackup({ root, repo: remote });
    const st = await b.run();
    expect(st.state).toBe('ok');
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('pedidos/');
    const files = execFileSync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main']).toString();
    expect(files).toContain('ofertas-br/CLAUDE.md');
    expect(files).not.toContain('pedidos');
    // Apagar não perde: continua no histórico.
    writeFileSync(join(root, 'ofertas-br', 'CLAUDE.md'), 'mudou');
    await b.run();
    const log = execFileSync('git', ['--git-dir', remote, 'log', '--oneline', 'main']).toString().trim().split('\n');
    expect(log.length).toBe(2);
    expect(existsSync(join(root, '.git'))).toBe(true);
  });
});
