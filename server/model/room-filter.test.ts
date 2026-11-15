import { describe, expect, it } from 'vitest';
import { createOperationNames, createPinnedRooms, makeRoomFilter, operationNameFromText, parseRoomFolders } from './room-filter';

describe('parseRoomFolders', () => {
  it('vazio = sem filtro', () => {
    expect(parseRoomFolders(undefined, 'C:\\Users\\davis')).toEqual([]);
    expect(parseRoomFolders('  ', 'C:\\Users\\davis')).toEqual([]);
  });

  it('separa por ";" e expande ~ e %USERPROFILE%', () => {
    expect(parseRoomFolders('~/Documents/escritorio; %USERPROFILE%\\Projetos ;"D:\\Lojas"', 'C:\\Users\\davis')).toEqual([
      'C:\\Users\\davis/Documents/escritorio',
      'C:\\Users\\davis\\Projetos',
      'D:\\Lojas',
    ]);
  });
});

describe('makeRoomFilter', () => {
  it('sem pastas, tudo entra', () => {
    const f = makeRoomFilter([]);
    expect(f('C:\\WINDOWS\\system32')).toBe(true);
  });

  it('só entra o que está na pasta ou dentro dela (Windows, sem diferença de maiúsculas)', () => {
    const f = makeRoomFilter(['C:\\Users\\davis/Documents/escritorio']);
    expect(f('C:\\Users\\davis\\Documents\\escritorio\\trafego-pago')).toBe(true);
    expect(f('c:\\users\\davis\\documents\\ESCRITORIO')).toBe(true);
    expect(f('C:\\Users\\davis\\Documents\\escritorio-velho')).toBe(false);
    expect(f('C:\\Users\\davis')).toBe(false);
    expect(f('C:\\WINDOWS\\system32')).toBe(false);
  });

  it('funciona com caminhos Unix', () => {
    const f = makeRoomFilter(['/home/davi/escritorio/']);
    expect(f('/home/davi/escritorio/conteudo')).toBe(true);
    expect(f('/home/davi')).toBe(false);
  });
});

describe('nome da operação', () => {
  it('lê "# Operação: X" no começo do CLAUDE.md', () => {
    expect(operationNameFromText('# Operação: Tráfego pago\n\nVocê é o chefe...')).toBe('Tráfego pago');
    expect(operationNameFromText('# Operacao: Atendimento **WhatsApp**')).toBe('Atendimento WhatsApp');
    expect(operationNameFromText('# Projeto qualquer\n\ntexto')).toBeUndefined();
  });

  it('guarda em cache e aguenta pasta sem CLAUDE.md', () => {
    let reads = 0;
    const names = createOperationNames((file) => {
      reads++;
      if (file.includes('vazia')) throw new Error('ENOENT');
      return '# Operação: Conteúdo\n';
    });
    expect(names('C:\\escritorio\\conteudo')).toBe('Conteúdo');
    expect(names('c:\\escritorio\\conteudo')).toBe('Conteúdo');
    expect(names('C:\\escritorio\\vazia')).toBeUndefined();
    expect(reads).toBe(2);
  });
});

describe('createPinnedRooms', () => {
  it('cada subpasta com CLAUDE.md vira sala fixa, relida a cada ttl', () => {
    let t = 0;
    const tree: Record<string, string[]> = { '/esc': ['trafego-pago', 'ofertas-br', 'rascunho'] };
    const files = new Set(['/esc/trafego-pago/CLAUDE.md', '/esc/ofertas-br/CLAUDE.md']);
    const pinned = createPinnedRooms(['/esc', '/nao-existe'], {
      ttlMs: 1000,
      now: () => t,
      fs: {
        subdirs: (d) => {
          if (!tree[d]) throw new Error('ENOENT');
          return [...tree[d]];
        },
        exists: (f) => files.has(f.replace(/\\/g, '/')),
      },
    });
    expect(pinned().map((p) => p.replace(/\\/g, '/'))).toEqual(['/esc/ofertas-br', '/esc/trafego-pago']);
    tree['/esc'].push('pedidos');
    files.add('/esc/pedidos/CLAUDE.md');
    t = 500;
    expect(pinned()).toHaveLength(2);
    t = 1500;
    expect(pinned()).toHaveLength(3);
  });

  it('ordena pelas salas numeradas (<!-- ordem: N -->) e depois pelo nome', () => {
    const texts: Record<string, string> = {
      '/esc/pedidos/CLAUDE.md': '# Operação: Pedidos\n<!-- ordem: 6 -->',
      '/esc/ofertas-br/CLAUDE.md': '# Operação: Ofertas BR\n<!-- ordem: 1 -->',
      '/esc/zeta/CLAUDE.md': '# Operação: Zeta',
      '/esc/alfa/CLAUDE.md': '# Operação: Alfa',
    };
    const pinned = createPinnedRooms(['/esc'], {
      fs: {
        subdirs: () => ['pedidos', 'zeta', 'ofertas-br', 'alfa'],
        exists: (f) => f.replace(/\\/g, '/') in texts,
        read: (f) => texts[f.replace(/\\/g, '/')],
      },
    });
    expect(pinned().map((p) => p.replace(/\\/g, '/').split('/').pop())).toEqual(['ofertas-br', 'pedidos', 'alfa', 'zeta']);
  });

  it('sem pastas configuradas, nenhuma sala fixa', () => {
    expect(createPinnedRooms([])()).toEqual([]);
  });
});

describe('agente fixo da sala', () => {
  it('lê o nome do CLAUDE.md', async () => {
    const { roomAgentFromText } = await import('./room-filter');
    expect(roomAgentFromText('# Operação: X\n<!-- agente: Helena -->')).toEqual({ name: 'Helena', look: 'f' });
    expect(roomAgentFromText('<!-- agente: Léo, m -->')).toEqual({ name: 'Léo', look: 'm' });
    expect(roomAgentFromText('nada')).toBeUndefined();
  });
});
