import { describe, expect, it } from 'vitest';
import type { TerminalEntry } from '../../../shared/types';
import { chatItems, chatMessage, messageImages, pendingArrived, presence, splitPhotos, toolLabel, workText } from './chat-model';

describe('chat-model', () => {
  it('monta a mensagem com as fotos e separa de volta', () => {
    const msg = chatMessage('olha esse produto', ['anexos/2026-11-15/a.png', 'anexos/2026-11-15/b.jpg']);
    expect(msg).toBe('olha esse produto\n📎 Foto anexada: anexos/2026-11-15/a.png\n📎 Foto anexada: anexos/2026-11-15/b.jpg');
    expect(splitPhotos(msg)).toEqual({ text: 'olha esse produto', photos: ['anexos/2026-11-15/a.png', 'anexos/2026-11-15/b.jpg'] });
    expect(chatMessage('', ['anexos/x/a.png'])).toContain('Analise as fotos');
  });

  it('agrupa ferramentas seguidas e ignora raciocínio e resultados', () => {
    const e: TerminalEntry[] = [
      { kind: 'user', id: 'u1', at: 1, text: 'oi' },
      { kind: 'thinking', id: 't', at: 2 },
      { kind: 'tool', id: 'a', at: 3, tool: 'Read', title: 'Read(x.md)' },
      { kind: 'result', id: 'r', at: 4, toolUseId: 'a', text: '...' },
      { kind: 'tool', id: 'b', at: 5, tool: 'WebSearch', title: 'WebSearch(x)' },
      { kind: 'tool', id: 'c', at: 6, tool: 'Read', title: 'Read(y.md)' },
      { kind: 'assistant', id: 'm', at: 7, text: 'Pronto!' },
    ];
    const items = chatItems(e);
    expect(items.map((i) => i.type)).toEqual(['me', 'work', 'agent']);
    const work = items[1] as Extract<(typeof items)[number], { type: 'work' }>;
    expect(workText(work)).toBe('lendo, pesquisando na web · 3 ações');
  });

  it('nomes das ferramentas', () => {
    expect(toolLabel('mcp__claude-in-chrome__navigate(x)')).toBe('usando o navegador');
    expect(toolLabel('Agent(analista)')).toBe('chamando um especialista');
  });

  it('reconhece a mensagem pendente quando ela chega na conversa', () => {
    const items = chatItems([{ kind: 'user', id: 'u', at: 1000, text: 'olha\n📎 Foto anexada: anexos/d/a.png' }]);
    expect(pendingArrived('olha\n📎 Foto anexada: anexos/d/a.png', 900, items)).toBe(true);
    expect(pendingArrived('outra coisa', 900, items)).toBe(false);
  });

  it('reconhece mensagens que esperaram na fila e entraram juntas (bug do Tiago, 18/11)', () => {
    const foto = 'pode mudar isso\n📎 Foto anexada: anexos/d/a.png\n📎 Foto anexada: anexos/d/b.png';
    const junto = `<pasted_content id="8a46">\n${foto}\n</pasted_content id="8a46">\n\nentendeu?`;
    const items = chatItems([{ kind: 'user', id: 'u', at: 5000, text: junto }]);
    expect(pendingArrived(foto, 4000, items)).toBe(true);
    expect(pendingArrived('entendeu?', 4500, items)).toBe(true);
    // Uma mensagem antiga que só contém o texto não conta.
    expect(pendingArrived('entendeu?', 9000, items)).toBe(false);
    expect(pendingArrived('pode mudar isso\n📎 Foto anexada: anexos/d/c.png', 4000, items)).toBe(false);
  });

  it('acha as imagens que o agente cita, só dentro da sala', () => {
    const room = 'C:\\Users\\davis\\Documents\\escritorio\\trafego-pago';
    expect(messageImages('O print está em `campanhas/2026-11-18-cortina-erro-publicacao.jpeg`. Quem resolve', room)).toEqual(['campanhas/2026-11-18-cortina-erro-publicacao.jpeg']);
    expect(messageImages('veja ![erro](./prints/a.png) e C:\\Users\\davis\\Documents\\escritorio\\trafego-pago\\.playwright-mcp\\shot-1.png.', room)).toEqual(['prints/a.png', '.playwright-mcp/shot-1.png']);
    expect(messageImages('fora: `../criativos/x.png` e C:\\outra\\y.jpg e `C:/Users/davis/Documents/escritorio/trafego-pago/a b.png`', room)).toEqual(['a b.png']);
    expect(messageImages('nenhuma imagem aqui, só arquivo.md', room)).toEqual([]);
  });

  it('presença estilo WhatsApp', () => {
    expect(presence(undefined).text).toBe('conversa encerrada');
    expect(presence({ status: 'working', activity: { text: 'Lendo criterios.md' } } as never).text).toBe('lendo criterios.md…');
    expect(presence({ status: 'idle' } as never).tone).toBe('online');
  });
});

describe('tabelas no chat', () => {
  it('separa a tabela do texto', async () => {
    const { splitTables } = await import('./chat-model');
    const segs = splitTables('Ranking:\n\n| # | Produto |\n|---|---|\n| 1 | Escova |\n| 2 | Mop |\n\nAprova?');
    expect(segs.map((s) => s.kind)).toEqual(['md', 'table', 'md']);
    expect(segs[1]).toEqual({ kind: 'table', rows: [['#', 'Produto'], ['1', 'Escova'], ['2', 'Mop']] });
  });
});

describe('sessão de verdade', () => {
  it('digita uma linha direto e várias coladas', async () => {
    const { ptyTyping } = await import('./chat-model');
    expect(ptyTyping('oi')).toBe('oi');
    expect(ptyTyping('a\nb')).toBe('\x1b[200~a\nb\x1b[201~');
  });
  it('comandos de barra', async () => {
    const { slashMatches, opensMenu, modeLabel, samePath } = await import('./chat-model');
    expect(slashMatches('/c').map((c) => c.cmd)).toEqual(['/clear', '/compact', '/context', '/config']);
    expect(slashMatches('/model').map((c) => c.cmd)).toEqual(['/model sonnet', '/model opus']);
    expect(slashMatches('oi')).toEqual([]);
    expect(opensMenu('/resume')).toBe(true);
    expect(opensMenu('/model opus')).toBe(false);
    expect(modeLabel('plan')).toBe('modo plano');
    expect(samePath('C:\\Users\\davis\\x', 'c:/users/davis/x/')).toBe(true);
  });
  it('o aviso de trabalho guarda os passos e os resultados', async () => {
    const { chatItems } = await import('./chat-model');
    const items = chatItems([
      { kind: 'tool', id: 'a', at: 1, tool: 'Read', title: 'Read(x.md)' },
      { kind: 'result', id: 'a:r', at: 2, toolUseId: 'a', text: 'linha 1\nlinha 2' },
    ]);
    expect(items[0]).toMatchObject({ type: 'work', steps: [{ title: 'Read(x.md)', result: 'linha 1\nlinha 2' }] });
  });
});

describe('modo lido da tela', () => {
  it('lê o rodapé do Claude Code', async () => {
    const { modeFromScreen } = await import('./chat-model');
    const box = '────────────────────\r\n❯ \r\n────────────────────\r\n';
    expect(modeFromScreen(`texto\r\n${box}  \x1b[36m⏸ plan mode on\x1b[39m (shift+tab to cycle)\r\n`)).toBe('plan');
    expect(modeFromScreen(`${box}  ⏵⏵ accept edits on (shift+tab to cycle)`)).toBe('acceptEdits');
    expect(modeFromScreen(`${box}  ⏵⏵ auto mode on (shift+tab to cycle)`)).toBe('auto');
    expect(modeFromScreen(`${box}  ? for shortcuts`)).toBe('default');
    expect(modeFromScreen('')).toBeUndefined();
    expect(modeFromScreen(`${box}Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel`)).toBeUndefined();
  });
});
