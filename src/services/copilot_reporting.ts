/**
 * BI PHARMA — Motor de Síntese e Geração de Relatórios Executivos do Copilot
 * 
 * Transforma conversas exploratórias do Copilot em documentos corporativos
 * orientados à decisão da Direção Técnica e Gestão da Farmácia:
 *  - Remoção de ruído conversacional de chat (saudações, perguntas prévias).
 *  - Estruturação em Diagnóstico, KPIs-Chave, Tabela de Artigos e Plano de Ação.
 *  - Suporte a grandes volumes (Top N prioritário em PDF + Exportação CSV/Excel completa).
 *  - Edição direta (WYSIWYG) no Preview antes da impressão formal em PDF A4.
 */

export interface CopilotReportKpi {
  label: string;
  valor: string;
  tipo?: 'default' | 'warning' | 'danger' | 'success' | 'info';
}

export interface CopilotReportTable {
  colunas: string[];
  linhas: string[][];
  totalRegistos: number;
  avisoLimite?: string;
}

export interface CopilotExecutiveReport {
  titulo: string;
  subtitulo: string;
  diagnostico: string;
  kpis: CopilotReportKpi[];
  tabela?: CopilotReportTable;
  topTabela?: CopilotReportTable;
  acoesPorClasse?: Array<{
    classe: string;
    n_produtos: number;
    resumo: string;
    produtos: string[];
  }>;
  recomendacoes: string[];
  notaFarmaceutica: string;
  farmaciaNome: string;
  dataEmissao: string;
  horaEmissao: string;
  responsavel: string;
}

export function markdownInlineToHtml(text: string): string {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br/>');
}

/**
 * Analisador determinístico que converte texto/markdown do Copilot numa estrutura executiva
 * sem necessidade de chamada externa (0ms / 0 tokens / 100% tolerante a falhas).
 */
export function parseMarkdownToExecutiveReport(
  rawText: string,
  options?: {
    farmaciaNome?: string;
    responsavel?: string;
    tituloCustom?: string;
    verFaturacao?: boolean;
  }
): CopilotExecutiveReport {
  const farmaciaNome = options?.farmaciaNome || 'Farmácia Comunitária';
  const responsavel = options?.responsavel || 'Utilizador da Sessão';
  const allowEur = options?.verFaturacao !== false;
  const hoje = new Date();
  const dataEmissao = hoje.toLocaleDateString('pt-PT');
  const horaEmissao = hoje.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });

  if (!rawText || !rawText.trim()) {
    return {
      titulo: options?.tituloCustom || 'Relatório Executivo da Farmácia',
      subtitulo: 'Proposta de Análise & Apoio à Decisão',
      diagnostico: 'Nenhuma informação analítica detalhada para estruturar neste momento.',
      kpis: [],
      recomendacoes: ['Coloque uma questão ao Copilot para gerar uma análise com dados da farmácia.'],
      notaFarmaceutica: 'Proposta para validação da Direção Técnica | Nome: __________________ | Data: ___/___/_____ | Assinatura: __________________',
      farmaciaNome,
      dataEmissao,
      horaEmissao,
      responsavel,
    };
  }

  // D5: Se não tiver permissão ver_faturacao, oculta valores monetários em € no texto
  const effectiveRawText = allowEur
    ? rawText
    : rawText.replace(/\b\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?\s*€/g, '[valor oculto]');

  const cleanText = effectiveRawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = cleanText.split('\n');

  let extractedTitle = options?.tituloCustom || '';
  let diagnosticoParas: string[] = [];
  let tableHeaders: string[] = [];
  let tableRows: string[][] = [];
  let inTable = false;
  let recomendacoes: string[] = [];
  let inRecsSection = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    // 1. Deteção de Título
    if (!extractedTitle && (line.startsWith('# ') || line.startsWith('## ') || line.startsWith('### '))) {
      extractedTitle = line.replace(/^#+\s*/, '').replace(/[*_#]/g, '').trim();
      continue;
    }

    // 2. Deteção de Tabela Markdown
    if (line.startsWith('|') && line.endsWith('|')) {
      const cells = line.slice(1, -1).split('|').map((c) => c.trim().replace(/[*_]/g, ''));
      const isDivider = line.replace(/[\s|:-]/g, '').length === 0;

      if (isDivider) {
        continue;
      }

      if (!inTable) {
        tableHeaders = cells;
        inTable = true;
      } else {
        if (cells.length > 0 && cells.some((c) => c.length > 0)) {
          tableRows.push(cells);
        }
      }
      continue;
    } else if (inTable) {
      inTable = false;
    }

    // 3. Deteção de Recomendações ou Ações
    const isRecHeader = /^(###?\s*)?(ações|recomendações|plano de ação|próximos passos|o que fazer)/i.test(line);
    if (isRecHeader) {
      inRecsSection = true;
      continue;
    }

    const isBullet = /^[-*•]\s+/.test(line);
    const isNumbered = /^\d+[\.\)]\s+/.test(line);

    if (inRecsSection && (isBullet || isNumbered)) {
      const recText = line.replace(/^[-*•\d\.\)]\s*/, '').replace(/[*_]/g, '').trim();
      if (recText) recomendacoes.push(recText);
      continue;
    }

    // Se saiu da secção de recomendações
    if (inRecsSection && line.startsWith('#')) {
      inRecsSection = false;
    }

    // 4. Parágrafos de Diagnóstico
    if (line.length > 0 && !line.startsWith('|') && !line.startsWith('#')) {
      // Ignora tags de badges ou botões do frontend
      if (line.includes('[BOTAO_') || line.includes('chat-feedback')) continue;

      const cleanP = line.replace(/[*_]/g, '').trim();
      if (cleanP && !inRecsSection) {
        diagnosticoParas.push(cleanP);
      }
    }
  }

  // Título padrão inteligente se não encontrado
  if (!extractedTitle) {
    if (cleanText.toLowerCase().includes('validade') || cleanText.toLowerCase().includes('lote')) {
      extractedTitle = 'Relatório de Risco de Validades & Escoamento de Stock';
    } else if (cleanText.toLowerCase().includes('encomenda') || cleanText.toLowerCase().includes('compras')) {
      extractedTitle = 'Proposta Estratégica de Encomenda & Reposição';
    } else if (cleanText.toLowerCase().includes('margem') || cleanText.toLowerCase().includes('faturaç')) {
      extractedTitle = 'Relatório de Otimização Financeira e Margens de Venda';
    } else {
      extractedTitle = 'Relatório Executivo de Diagnóstico Farmacêutico';
    }
  }

  // Se não encontrou recomendações explícitas, extrai balas soltas ou cria recomendações orientadas
  if (recomendacoes.length === 0) {
    for (const p of diagnosticoParas) {
      if (/^(separar|contactar|devolver|promover|reduzir|aumentar|auditar|encomendar)/i.test(p)) {
        recomendacoes.push(p);
      }
    }
  }
  if (recomendacoes.length === 0) {
    recomendacoes = [
      'Proceder à validação física imediata dos artigos destacados nas prateleiras e gavetas.',
      'Articular com os fornecedores e armazenistas os prazos limite de devolução e crédito.',
      'Acompanhar a evolução das rotações na reunião semanal com a equipa de balcão.',
    ];
  }

  // Diagnóstico Consolidado
  let diagnosticoText = diagnosticoParas.slice(0, 4).join('\n\n');
  if (!diagnosticoText) {
    diagnosticoText = 'Análise analítica elaborada com base no estado do inventário, histórico de vendas e condições comerciais registadas na farmácia.';
  }

  // Extração ou Cálculo de KPIs
  const kpis: CopilotReportKpi[] = [];
  const totalRows = tableRows.length;

  if (totalRows > 0) {
    kpis.push({
      label: 'Artigos Identificados',
      valor: `${totalRows} ${totalRows === 1 ? 'produto' : 'produtos'}`,
      tipo: totalRows > 15 ? 'warning' : 'info',
    });

    // Tentar somar valores monetários ou quantidades se colunas adequadas existirem
    let totalEuros = 0;
    let totalUnidades = 0;
    let foundEurCol = false;
    let foundQtyCol = false;

    for (let c = 0; c < tableHeaders.length; c++) {
      const h = tableHeaders[c].toLowerCase();
      if (h.includes('custo') || h.includes('impacto') || h.includes('valor') || h.includes('total') || h.includes('€')) {
        foundEurCol = true;
        for (const row of tableRows) {
          if (row[c]) {
            const val = parseFloat(row[c].replace(/[^\d,.-]/g, '').replace(',', '.'));
            if (!isNaN(val)) totalEuros += val;
          }
        }
      }
      if (h.includes('qtd') || h.includes('quant') || h.includes('un')) {
        foundQtyCol = true;
        for (const row of tableRows) {
          if (row[c]) {
            const val = parseInt(row[c].replace(/[^\d]/g, ''), 10);
            if (!isNaN(val)) totalUnidades += val;
          }
        }
      }
    }

    if (foundEurCol && totalEuros > 0) {
      kpis.push({
        label: 'Capital Envolvido',
        valor: `${totalEuros.toFixed(2).replace('.', ',')} €`,
        tipo: 'danger',
      });
    }
    if (foundQtyCol && totalUnidades > 0) {
      kpis.push({
        label: 'Volume Físico',
        valor: `${totalUnidades} un`,
        tipo: 'default',
      });
    }
  }

  kpis.push({
    label: 'Âmbito de Análise',
    valor: farmaciaNome,
    tipo: 'success',
  });

  // Gestão de Grandes Volumes em PDF: se houver > 25 registos, exibe os 25 primeiros no PDF e alerta
  let finalTable: CopilotReportTable | undefined = undefined;
  if (tableHeaders.length > 0 && tableRows.length > 0) {
    const MAX_PDF_ROWS = 25;
    const isTruncated = tableRows.length > MAX_PDF_ROWS;
    const displayedRows = isTruncated ? tableRows.slice(0, MAX_PDF_ROWS) : tableRows;

    finalTable = {
      colunas: tableHeaders,
      linhas: displayedRows,
      totalRegistos: tableRows.length,
      avisoLimite: isTruncated
        ? `⚠️ A apresentar os ${MAX_PDF_ROWS} produtos mais críticos neste relatório PDF. A listagem completa com todos os ${tableRows.length} registos pode ser descarregada integralmente em Excel / CSV.`
        : undefined,
    };
  }

  return {
    titulo: extractedTitle,
    subtitulo: `Relatório de apoio à gestão — ${farmaciaNome}`,
    diagnostico: diagnosticoText,
    kpis,
    tabela: finalTable,
    recomendacoes,
    notaFarmaceutica:
      'Proposta para validação da Direção Técnica — Nome: ________________________ | Data: ___/___/_____ | Assinatura: ________________________',
    farmaciaNome,
    dataEmissao,
    horaEmissao,
    responsavel,
  };
}

/**
 * Fase 1 (4.5): Constrói o Relatório Executivo / PDF diretamente a partir do objeto
 * estruturado e validado do chat (mesmos números, classes a 100%, Top 10, 3-5 produtos por classe, zero chamadas extra ao LLM).
 */
export function buildExecutiveReportFromStructuredData(
  relatorio: any,
  options: {
    farmaciaNome: string;
    responsavel: string;
    verFaturacao: boolean;
  }
): CopilotExecutiveReport {
  const hoje = new Date();
  const dataEmissao = hoje.toLocaleDateString('pt-PT');
  const horaEmissao = hoje.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
  const showEur = options.verFaturacao && !relatorio?.meta?.faturacao_oculta;
  const fmtEur = (v: number | null | undefined) =>
    v !== null && v !== undefined ? `${Number(v).toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €` : '—';

  const t = relatorio?.totais || {};
  const lab = relatorio?.meta?.laboratorio || 'Laboratório';
  const periodo = relatorio?.meta?.periodo_rotulo || `${relatorio?.meta?.ano || 2026} (jan–out)`;

  const kpis: CopilotReportKpi[] = [
    {
      label: 'Âmbito Analisado',
      valor: `${t.produtos_ambito_total ?? 0} produtos (${t.produtos_vendidos ?? 0} c/ vendas)`,
      tipo: 'info',
    },
    {
      label: 'Volume Vendido',
      valor: `${Number(t.unidades_vendidas ?? 0).toLocaleString('pt-PT')} un`,
      tipo: 'success',
    },
  ];

  if (showEur) {
    kpis.push({
      label: `Faturação ${periodo}`,
      valor: fmtEur(t.faturacao_eur),
      tipo: 'success',
    });
  }

  kpis.push({
    label: 'Stock Atual',
    valor: `${t.produtos_em_stock ?? 0} ref. | ${t.unidades_em_stock ?? 0} un` + (showEur ? ` (${fmtEur(t.valor_stock_custo)})` : ''),
    tipo: 'default',
  });

  kpis.push({
    label: 'Imobilizado Consolidado',
    valor: `${relatorio?.imobilizado_total?.total_produtos_unicos ?? 0} ref.` + (showEur ? ` (${fmtEur(relatorio?.imobilizado_total?.total_valor_custo)})` : ''),
    tipo: 'warning',
  });

  // 1. Tabela unificada de distribuição 100% por classe de ação + total exato
  const classes = Array.isArray(relatorio?.classes_resumo) ? relatorio.classes_resumo : [];
  const tableCols = showEur
    ? ['Ação Recomendada', 'N.º Produtos', 'Unidades Vendidas', 'Vendas (€)', 'Stock Custo (€)']
    : ['Ação Recomendada', 'N.º Produtos', 'Unidades Vendidas'];

  const tableRows: string[][] = classes.map((c: any) =>
    showEur
      ? [
          String(c.classe),
          String(c.n_produtos),
          Number(c.vendas_un || 0).toLocaleString('pt-PT'),
          fmtEur(c.vendas_eur),
          fmtEur(c.stock_custo_eur),
        ]
      : [String(c.classe), String(c.n_produtos), Number(c.vendas_un || 0).toLocaleString('pt-PT')]
  );

  if (classes.length > 0) {
    tableRows.push(
      showEur
        ? [
            'TOTAL (100% DO ÂMBITO)',
            String(t.produtos_ambito_total ?? 0),
            Number(t.unidades_vendidas ?? 0).toLocaleString('pt-PT'),
            fmtEur(t.faturacao_eur),
            fmtEur(t.valor_stock_custo),
          ]
        : [
            'TOTAL (100% DO ÂMBITO)',
            String(t.produtos_ambito_total ?? 0),
            Number(t.unidades_vendidas ?? 0).toLocaleString('pt-PT'),
          ]
    );
  }

  // 2. Top 10 de vendas (mesma tabela do chat)
  const topArr = Array.isArray(relatorio?.top) ? relatorio.top : [];
  let topTabela: CopilotReportTable | undefined = undefined;
  if (topArr.length > 0) {
    const topCols = showEur
      ? ['CNP', 'Designação', 'Vendas (€)', 'Un', 'VMM', 'Stock', 'Margem %', 'Ação']
      : ['CNP', 'Designação', 'Un', 'VMM', 'Stock', 'Ação'];
    const topRows = topArr.map((p: any) =>
      showEur
        ? [
            String(p.cnp),
            String(p.designacao || '').slice(0, 48),
            fmtEur(p.vendas_eur),
            String(p.vendas_un ?? 0),
            Number(p.vmm || 0).toFixed(2),
            String(p.stock ?? 0),
            p.margem_pct !== null && p.margem_pct !== undefined ? `${Number(p.margem_pct).toFixed(1)}%` : '—',
            String(p.classificacao || ''),
          ]
        : [
            String(p.cnp),
            String(p.designacao || '').slice(0, 48),
            String(p.vendas_un ?? 0),
            Number(p.vmm || 0).toFixed(2),
            String(p.stock ?? 0),
            String(p.classificacao || ''),
          ]
    );
    topTabela = {
      colunas: topCols,
      linhas: topRows,
      totalRegistos: topArr.length,
    };
  }

  // 3. Produtos principais (3-5) de cada classe de ação (mesmo conteúdo do chat)
  const acoesPorClasse: Array<{ classe: string; n_produtos: number; resumo: string; produtos: string[] }> = [];
  const recomendacoes: string[] = [];

  if (Array.isArray(relatorio?.acoes_imediatas_por_classe) && relatorio.acoes_imediatas_por_classe.length > 0) {
    for (const ac of relatorio.acoes_imediatas_por_classe) {
      let resumo = `${ac.n_produtos} produtos`;
      if (ac.unidades_a_devolver !== null && ac.unidades_a_devolver !== undefined) {
        resumo += ` — ${ac.unidades_a_devolver} un a devolver` + (showEur ? ` (${fmtEur(ac.valor_a_devolver_eur)} a custo)` : '');
      }
      const produtosFmt = (ac.principais || []).map((p: any) => {
        const extra =
          ac.classe === 'DEVOLVER_EXCESSO' && p.unidades_excesso
            ? `devolver ${p.unidades_excesso} un`
            : ac.classe === 'DEVOLVER_TUDO'
              ? `${p.stock} un`
              : `VMM ${Number(p.vmm || 0).toFixed(2)}`;
        return `${p.designacao} (CNP ${p.cnp} · ${extra})`;
      });
      acoesPorClasse.push({
        classe: ac.classe,
        n_produtos: ac.n_produtos,
        resumo,
        produtos: produtosFmt,
      });
      recomendacoes.push(`[${ac.classe}] ${resumo}: ${produtosFmt.join('; ')}.`);
    }
  }

  // Notas e lacunas (sem duplicar REVER_DADOS / Olfenex se já listado acima!)
  const hasReverInAcoes = acoesPorClasse.some((a) => a.classe === 'REVER_DADOS');
  if (Array.isArray(relatorio?.lacunas)) {
    for (const lac of relatorio.lacunas) {
      if (hasReverInAcoes && /REVER_DADOS/i.test(lac)) continue; // evita duplicar nota do Olfenex
      recomendacoes.push(`[NOTA DE DADOS] ${lac}`);
    }
  }

  return {
    titulo: `Relatório de Gestão — Laboratório ${lab} · ${periodo}`,
    subtitulo: `Relatório de apoio à gestão — ${options.farmaciaNome}`,
    diagnostico:
      relatorio?.leitura_executiva ||
      `Análise consolidada do laboratório ${lab} para o período ${periodo} (vendas registadas até ${relatorio?.meta?.data_referencia || '2026-10-31'}).`,
    kpis,
    tabela: {
      colunas: tableCols,
      linhas: tableRows,
      totalRegistos: t.produtos_ambito_total ?? tableRows.length,
    },
    topTabela,
    acoesPorClasse,
    recomendacoes,
    notaFarmaceutica:
      'Proposta para validação da Direção Técnica — Nome: ________________________ | Data: ___/___/_____ | Assinatura: ________________________',
    farmaciaNome: options.farmaciaNome,
    dataEmissao,
    horaEmissao,
    responsavel: options.responsavel,
  };
}
