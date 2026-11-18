import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readChatFile, saveChatFile } from './files';

describe('fotos do chat', () => {
  it('grava em anexos/<dia>/ sem sobrescrever e lê de volta', () => {
    const room = mkdtempSync(join(tmpdir(), 'sala-'));
    const a = { name: 'print.png', type: 'image/png', data: Buffer.from('x') };
    const day = new Date(2026, 10, 15);
    expect(saveChatFile(room, a, day)).toBe('anexos/2026-11-15/print.png');
    expect(saveChatFile(room, a, day)).toBe('anexos/2026-11-15/print-2.png');
    expect(readFileSync(join(room, 'anexos', '2026-11-15', 'print-2.png'), 'utf8')).toBe('x');
    expect(readChatFile(room, 'anexos/2026-11-15/print.png')?.type).toBe('image/png');
  });

  it('lê imagens de qualquer pasta da sala (print citado pelo agente)', () => {
    const room = mkdtempSync(join(tmpdir(), 'sala-'));
    mkdirSync(join(room, 'campanhas'));
    writeFileSync(join(room, 'campanhas', 'erro.jpeg'), 'x');
    expect(readChatFile(room, 'campanhas/erro.jpeg')?.type).toBe('image/jpeg');
    expect(readChatFile(room, 'campanhas\\erro.jpeg')?.type).toBe('image/jpeg');
  });

  it('não lê fora da sala nem arquivos que não são imagem', () => {
    const room = mkdtempSync(join(tmpdir(), 'sala-'));
    saveChatFile(room, { name: 'a.png', type: 'image/png', data: Buffer.from('x') });
    expect(readChatFile(room, '../CLAUDE.md')).toBeNull();
    expect(readChatFile(room, 'anexos/../../etc/passwd')).toBeNull();
    expect(readChatFile(room, 'CLAUDE.md')).toBeNull();
    expect(readChatFile(room, '/etc/passwd')).toBeNull();
  });
});
