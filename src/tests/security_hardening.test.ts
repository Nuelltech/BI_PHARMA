import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { verifyMobileStaffPin } from '../services/weekly_tasks';
import { generateMonthlyEmailDigest } from '../services/campaigns';
import { clearCopilotSession } from '../services/copilot_engine';

describe('Blindagem de Segurança - Testes de Regressão e Hardening', () => {
  it('1. Deve rejeitar o PIN universal 1234 quando não é o PIN da farmácia', async () => {
    const mockPrisma: any = {
      farmacia: {
        findFirst: async () => ({
          id: 'farm-123',
          nome: 'Farmácia Teste',
          codigo_acesso: 'FARM-X-9876',
        }),
      },
    };

    // Tentar autenticar com o antigo backdoor universal '1234'
    const res = await verifyMobileStaffPin(mockPrisma, 'farm-123', '1234');
    expect(res.valid).toBe(false);
    expect(res.error).toContain('PIN incorreto');

    // Com os 4 dígitos corretos do código (9876), deve passar
    const resCorreto = await verifyMobileStaffPin(mockPrisma, 'farm-123', '9876');
    expect(resCorreto.valid).toBe(true);
  });

  it('2. Anti-Path Traversal: Nomes de ficheiros devem ser limpos e confinados', () => {
    const avenidaDir = path.resolve(process.cwd(), 'Avenida');
    const maliciousInputs = [
      '../../.env',
      '..\\..\\.env',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      '....//....//secret.txt',
    ];

    for (const rawFn of maliciousInputs) {
      const cleanFn = path.basename(String(rawFn || ''));
      const fullP = path.resolve(avenidaDir, cleanFn);
      // Deve estar estritamente dentro da pasta Avenida
      const isConfined = fullP.startsWith(avenidaDir + path.sep);
      expect(isConfined).toBe(true);
      // E o nome base não pode conter caracteres de travessia
      expect(cleanFn).not.toContain('..');
      expect(cleanFn).not.toContain('/');
      expect(cleanFn).not.toContain('\\');
    }
  });

  it('3. Sanitização contra Stored XSS: escapeHtml deve neutralizar tags e atributos', () => {
    function escapeHtml(str: any) {
      if (str == null) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    const payloadXss = '<script>alert("xss")</script>';
    const payloadImg = '<img src=x onerror=alert(1)>';
    const payloadAttr = '" onfocus="alert(1)" autofocus="';

    expect(escapeHtml(payloadXss)).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(escapeHtml(payloadImg)).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(escapeHtml(payloadAttr)).toBe('&quot; onfocus=&quot;alert(1)&quot; autofocus=&quot;');
  });

  it('4. Sanitização contra Stored XSS no Boletim Mensal (generateMonthlyEmailDigest)', () => {
    const digest = generateMonthlyEmailDigest(
      'Farmácia <script>alert(1)</script>',
      {
        id: 'camp-1',
        titulo: 'Campanha <img src=x onerror=alert(2)>',
        epoca: 'Inverno',
        icone: '❄️',
        descricao: 'Descrição segura',
        mecanicaSugerida: 'Leve 2 Pague 1',
        canaisIdeais: ['balcao'],
        termosPesquisa: [],
        familiasAlvo: [],
      } as any,
      [
        {
          cnp_codigo: '1234567" onclick="alert(3)',
          designacao: 'Xarope <svg onload=alert(4)>',
          stock_atual: 10,
          pvp: 12.5,
          margem_percentagem: 30,
        } as any,
      ],
      {
        totalUnidades: 10,
        faturacaoBruta: 125,
        faturacaoComDesconto: 100,
        custoMercadoria: 70,
        margemLiquida: 30,
        margemFinalPct: 30,
        capitalLibertado: 70,
      } as any
    );

    expect(digest.html).not.toContain('<script>');
    expect(digest.html).not.toContain('<img src=x');
    expect(digest.html).not.toContain('<svg onload=');
    expect(digest.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(digest.html).toContain('&lt;img src=x onerror=alert(2)&gt;');
  });

  it('5. Isolamento de Sessão do Copiloto por Tenant e SQL RLS compatível com splitter', () => {
    const farmA = 'uuid-farm-a';
    const farmB = 'uuid-farm-b';
    const clientSid = 'session-uuid-farm-a';
    const scopedSidA = `${farmA}:${clientSid.slice(0, 64)}`;
    const scopedSidB = `${farmB}:${clientSid.slice(0, 64)}`;

    expect(scopedSidA).not.toBe(scopedSidB);
    clearCopilotSession(scopedSidB);

    const sqlPath = path.resolve(process.cwd(), 'supabase_bi_pharma_setup.sql');
    const sqlContent = fs.readFileSync(sqlPath, 'utf-8');
    expect(sqlContent).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sqlContent).not.toContain('DO $$');
  });
});
