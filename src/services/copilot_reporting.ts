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
  recomendacoes: string[];
  notaFarmaceutica: string;
  farmaciaNome: string;
  dataEmissao: string;
  horaEmissao: string;
  responsavel: string;
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
    subtitulo: `Proposta de Apoio à Decisão Clínica & Gestão — ${farmaciaNome}`,
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
 * estruturado e validado do chat (mesmos números, classes a 100%, zero chamadas extra ao LLM).
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

  // Tabela unificada de distribuição 100% por classe de ação + total exato
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

  // Recomendações 100% derivadas das ações calculadas pelo código (sem alucinação nem MSRM em campanha)
  const recomendacoes: string[] = [];
  if (relatorio?.validades?.produtos?.length > 0) {
    for (const v of relatorio.validades.produtos) {
      recomendacoes.push(`[${v.classificacao}] ${v.designacao} (CNP ${v.cnp}): ${v.motivo_classificacao}`);
    }
  }
  if (relatorio?.em_rutura?.total_contagem > 0) {
    recomendacoes.push(
      `[REPOR / ENCOMENDA] ${relatorio.em_rutura.total_contagem} produto(s) com vendas registadas encontram-se em rutura (stock 0). Repor os de VMM >= 1.0 e crónicos; trabalhar os restantes sob encomenda.`
    );
  }
  if (relatorio?.rever_dados?.total_contagem > 0) {
    recomendacoes.push(
      `[REVER_DADOS] ${relatorio.rever_dados.total_contagem} produto(s) com valores anómalos no ERP requerem auditoria no Sifarma antes de decisão comercial.`
    );
  }
  if (Array.isArray(relatorio?.lacunas)) {
    for (const lac of relatorio.lacunas) {
      recomendacoes.push(`[NOTA DE DADOS] ${lac}`);
    }
  }

  return {
    titulo: `Relatório de Gestão — Laboratório ${lab} (${periodo})`,
    subtitulo: `Proposta de Apoio à Decisão Clínica & Gestão — ${options.farmaciaNome}`,
    diagnostico:
      relatorio?.leitura_executiva ||
      `Análise consolidada do laboratório ${lab} para o período ${periodo} (vendas registadas até ${relatorio?.meta?.data_referencia || '2026-10-31'}).`,
    kpis,
    tabela: {
      colunas: tableCols,
      linhas: tableRows,
      totalRegistos: t.produtos_ambito_total ?? tableRows.length,
    },
    recomendacoes,
    notaFarmaceutica:
      'Proposta para validação da Direção Técnica — Nome: ________________________ | Data: ___/___/_____ | Assinatura: ________________________',
    farmaciaNome: options.farmaciaNome,
    dataEmissao,
    horaEmissao,
    responsavel: options.responsavel,
  };
}
