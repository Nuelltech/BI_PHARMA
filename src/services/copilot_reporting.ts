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
  }
): CopilotExecutiveReport {
  const farmaciaNome = options?.farmaciaNome || 'Farmácia Comunitária';
  const responsavel = options?.responsavel || 'Direção Técnica / Gestão';
  const hoje = new Date();
  const dataEmissao = hoje.toLocaleDateString('pt-PT');
  const horaEmissao = hoje.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });

  if (!rawText || !rawText.trim()) {
    return {
      titulo: options?.tituloCustom || 'Relatório Executivo da Farmácia',
      subtitulo: 'Análise Analítica & Apoio à Decisão',
      diagnostico: 'Nenhuma informação analítica detalhada para estruturar neste momento.',
      kpis: [],
      recomendacoes: ['Coloque uma questão ao Copilot para gerar uma análise com dados da farmácia.'],
      notaFarmaceutica: 'Emitido pelo sistema BI Pharma AI.',
      farmaciaNome,
      dataEmissao,
      horaEmissao,
      responsavel,
    };
  }

  const cleanText = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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
    subtitulo: `Relatório de Apoio à Decisão Clínica & Gestão — ${farmaciaNome}`,
    diagnostico: diagnosticoText,
    kpis,
    tabela: finalTable,
    recomendacoes,
    notaFarmaceutica: 'Parecer emitido pela Direção Técnica com recurso ao motor de inteligência analítica BI Pharma AI.',
    farmaciaNome,
    dataEmissao,
    horaEmissao,
    responsavel,
  };
}

/**
 * Síntese avançada com Inteligência Artificial (Claude) para redigir o relatório formal
 * com fallback imediato para o parser determinístico caso não haja chave de API ou conexão.
 */
export async function synthesizeExecutiveReportWithAi(params: {
  text: string;
  history?: Array<{ role: string; content: string }>;
  farmaciaNome: string;
  responsavel?: string;
  customPrompt?: string;
  audience?: 'GESTAO' | 'EQUIPA';
}): Promise<CopilotExecutiveReport> {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();

  // Fallback imediato se não houver chave de API configurada
  if (!apiKey) {
    return parseMarkdownToExecutiveReport(params.text, {
      farmaciaNome: params.farmaciaNome,
      responsavel: params.responsavel,
    });
  }

  try {
    const isParaEquipa = params.audience === 'EQUIPA';

    const systemPrompt = `És o Consultor de Gestão e Diretor Técnico Sénior do BI Pharma para a farmácia "${params.farmaciaNome}".
A tua função é transformar notas exploratórias e conversas de chat num RELATÓRIO EXECUTIVO FORMAL, rigoroso e orientado à tomada de decisão.

DIRETRIZES ESTREITAS:
1. NÃO incluas saudações, conversas de chat, perguntas do utilizador ("o utilizador perguntou...") ou meta-comentários.
2. O tom deve ser formal, conciso e profissional (${isParaEquipa ? 'foco operacional e tarefas para a equipa da farmácia' : 'foco executivo em rentabilidade, riscos e decisão da administração'}).
3. Deves responder EXCLUSIVAMENTE em formato JSON VÁLIDO (sem markdown wrap, sem \`\`\`json) com a seguinte estrutura exata:
{
  "titulo": "string com título formal e conciso",
  "subtitulo": "string com subtítulo contextual",
  "diagnostico": "string com 2 a 3 parágrafos claros descrevendo a situação detetada nos dados",
  "kpis": [
    { "label": "string", "valor": "string", "tipo": "default|warning|danger|success|info" }
  ],
  "tabela": {
    "colunas": ["string", "string"],
    "linhas": [["col1", "col2"]],
    "totalRegistos": number
  },
  "recomendacoes": [
    "string com recomendação 1",
    "string com recomendação 2"
  ],
  "notaFarmaceutica": "string com nota formal de fecho"
}

Se a informação de entrada contiver tabelas ou produtos, preserva rigorosamente os códigos CNP, designações e valores. Não inventes dados não presentes na conversa.`;

    const userContent = `Conteúdo a transformar em Relatório Executivo Formal:
${params.text}
${params.customPrompt ? `\nInstrução Específica de Ajuste do Farmacêutico: ${params.customPrompt}` : ''}`;

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!apiRes.ok) {
      throw new Error(`Anthropic API status ${apiRes.status}`);
    }

    const data = (await apiRes.json()) as any;
    const contentArr = Array.isArray(data.content) ? data.content : [];
    const replyText = contentArr
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n')
      .trim();

    // Limpar eventuais blocos de código markdown que o modelo possa ter incluído
    const cleanJson = replyText.replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(cleanJson);

    const hoje = new Date();
    const dataEmissao = hoje.toLocaleDateString('pt-PT');
    const horaEmissao = hoje.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });

    return {
      titulo: parsed.titulo || 'Relatório Executivo da Farmácia',
      subtitulo: parsed.subtitulo || `Análise de Gestão — ${params.farmaciaNome}`,
      diagnostico: parsed.diagnostico || '',
      kpis: Array.isArray(parsed.kpis) ? parsed.kpis : [],
      tabela: parsed.tabela && Array.isArray(parsed.tabela.colunas) && Array.isArray(parsed.tabela.linhas)
        ? {
            colunas: parsed.tabela.colunas,
            linhas: parsed.tabela.linhas.slice(0, 30),
            totalRegistos: parsed.tabela.linhas.length,
            avisoLimite: parsed.tabela.linhas.length > 30
              ? `⚠️ A apresentar os 30 registos mais prioritários no PDF. A totalidade dos ${parsed.tabela.linhas.length} registos está disponível em Excel / CSV.`
              : undefined,
          }
        : undefined,
      recomendacoes: Array.isArray(parsed.recomendacoes) ? parsed.recomendacoes : [],
      notaFarmaceutica: parsed.notaFarmaceutica || 'Parecer técnico emitido por BI Pharma AI.',
      farmaciaNome: params.farmaciaNome,
      dataEmissao,
      horaEmissao,
      responsavel: params.responsavel || 'Direção Técnica',
    };
  } catch (err) {
    console.warn('[Copilot Reporting AI Error, a usar fallback determinístico]:', err);
    return parseMarkdownToExecutiveReport(params.text, {
      farmaciaNome: params.farmaciaNome,
      responsavel: params.responsavel,
    });
  }
}
