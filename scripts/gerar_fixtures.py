"""
Gera um conjunto CITS sintético (CSV, um ficheiro por tabela) com a estrutura do
Manual da Cedência v16. Nomes de marca fictícios; DCI reais.

  python3 scripts/gerar_fixtures.py test/fixtures/cits_sintetico
"""
import csv
import sys
from pathlib import Path

out = Path(sys.argv[1] if len(sys.argv) > 1 else "test/fixtures/cits_sintetico")
out.mkdir(parents=True, exist_ok=True)


def escrever(nome, colunas, linhas):
    with open(out / f"{nome}.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(colunas)
        for l in linhas:
            w.writerow(["" if v is None else v for v in l])


# ---------------- referência ----------------
escrever("REF_DCIPT", ["DCIPT_ID", "DESCR", "ABREV_CHNM", "IND_ATIVO"], [
    (1, "Paracetamol", None, "S"), (2, "Atorvastatina", None, "S"), (3, "Ibuprofeno", None, "S"),
    (4, "Metilfenidato", None, "S"), (5, "Adalimumab", None, "S"), (6, "Omeprazol", None, "S"),
    (7, "Amoxicilina", None, "S"), (8, "Palivizumab", None, "S"), (9, "Diclofenac", None, "S"),
    (10, "Ranitidina", None, "S"),
])
escrever("REF_FORMA_FARM", ["FORMA_FARM_ID", "DESCR", "ABREV", "ABREV_CHNM", "IND_ATIVO"], [
    (1, "Comprimido", "comp", None, "S"), (2, "Comprimido revestido por película", "comp rev", None, "S"),
    (3, "Xarope", "xar", None, "S"), (4, "Solução injetável", "sol inj", None, "S"),
    (5, "Cápsula gastrorresistente", "cáps gastrorr", None, "S"), (6, "Gel", "gel", None, "S"),
    (7, "Pó para suspensão oral", "pó susp oral", None, "S"),
])
escrever("REF_AGRUP_FORMA_FARM", ["AGRUP_FORMA_FARM_ID", "DESCR", "IND_ATIVO"], [
    (1, "Formas orais sólidas", "S"), (2, "Formas orais líquidas", "S"), (3, "Injetáveis", "S"), (4, "Uso cutâneo", "S"),
])
escrever("REF_TITULAR_AIM", ["TITULAR_AIM_ID", "DESCR"], [
    (1, "Laboratório Alfa, S.A."), (2, "Genéricos Beta, Lda."), (3, "Pharma Gama, S.A."), (4, "MedDevice Delta, Lda."),
])
escrever("REF_ESTADO_AIM", ["ESTADO_AIM_ID", "DESCR", "IND_ATIVO"], [
    (1, "Autorizado", "S"), (2, "Suspenso", "S"), (3, "Revogado", "S"),
])
escrever("REF_GRUPO_HOM", ["GRUPO_HOM_COD", "DESCR", "IND_ATIVO"], [
    ("GH0001", "Paracetamol 500 mg Comprimido", "S"), ("GH0002", "Atorvastatina 20 mg Comprimido revestido", "S"),
    ("GH0003", "Omeprazol 20 mg Cápsula gastrorresistente", "S"),
])
escrever("REF_ATC", ["ATC_COD", "DESCR", "IND_ATIVO"], [
    ("N02BE01", "Paracetamol", "S"), ("C10AA05", "Atorvastatina", "S"), ("M01AE01", "Ibuprofeno", "S"),
    ("N06BA04", "Metilfenidato", "S"), ("L04AB04", "Adalimumab", "S"), ("A02BC01", "Omeprazol", "S"),
    ("J01CA04", "Amoxicilina", "S"), ("J06BD01", "Palivizumab", "S"), ("M02AA15", "Diclofenac", "S"),
])
escrever("REF_CFT", ["CFT_COD", "DESCR", "IND_ATIVO"], [
    ("2.10", "Analgésicos e antipiréticos", "S"), ("3.7", "Antidislipidémicos", "S"),
    ("9.1.1", "Anti-inflamatórios não esteroides", "S"), ("2.7", "Psicoestimulantes", "S"),
    ("16.3", "Imunomoduladores", "S"), ("6.2.2", "Inibidores da bomba de protões", "S"),
    ("1.1.1", "Penicilinas", "S"), ("1.4", "Antivíricos", "S"), ("9.1.10", "Anti-inflamatórios de aplicação tópica", "S"),
])
escrever("REF_VIA_ADMIN", ["VIA_ADMIN_ID", "DESCR", "ABREV_CHNM", "IND_ATIVO"], [
    (1, "Via oral", "oral", "S"), (2, "Via subcutânea", "sc", "S"), (3, "Via intramuscular", "im", "S"), (4, "Via cutânea", "cut", "S"),
])
escrever("REF_SUBSTANCIA", ["SUBST_ID", "DESCR", "IND_ATIVO"], [(1, "Paracetamol", "S"), (2, "Atorvastatina cálcica", "S")])
escrever("REF_ESTADO_COMERC", ["EST_COMERC_ID", "DESCR", "IND_ATIVO"], [
    (1, "Comerc. conf. pelo Titular", "S"), (2, "Não comerc. conf. pelo Titular", "S"),
    (4, "Prazo Escoa Revogado", "N"), (5, "Temporariamente indisponível", "S"),
])
escrever("REF_TIPO_REGIME", ["TIPO_REGIME_ID", "DESCR", "IND_ATIVO"], [(1, "Regime Geral", "S"), (2, "Regime Especial", "S")])
escrever("REF_NIVEL_COMPART", ["NIVEL_COMPART_ID", "DESCR", "PERCENT_COMPART", "IND_ATIVO"], [
    (1, "Escalão A", 90, "S"), (2, "Escalão B", 69, "S"), (3, "Escalão C", 37, "S"), (4, "Escalão D", 15, "S"),
])
escrever("REF_TEMPERATURA_ARMAZ", ["TEMPERATURA_ARMAZ_ID", "DESCR", "IND_ATIVO"], [
    (1, "Não conservar acima de 25ºC", "S"), (2, "Conservar no frigorífico (2ºC - 8ºC)", "S"),
])

# ---------------- produtos ----------------
# PROD_ID, NOME, DOSAGEM_CEDENCIA, DOSAGEM, FORMA, AGRUP, DCIPT, TIPO_PRODUTO, TITULAR, ESTADO_AIM, IND_GENERICO, IND_MARGEM_TERAP, IND_MONIT, MARCA
P = [
    (1, "Dorfim", "Paracetamol 500 mg", "500 mg", 1, 1, 1, 1, 1, 1, "N", "N", "N", "Dorfim"),
    (2, "Paracetamol Beta", "Paracetamol 500 mg", "500 mg", 1, 1, 1, 1, 2, 1, "S", "N", "N", None),
    (3, "Lipocor", "Atorvastatina cálcica 20 mg", "20 mg", 2, 1, 2, 1, 1, 1, "N", "N", "N", "Lipocor"),
    (4, "Atorvastatina Beta", "Atorvastatina cálcica 20 mg", "20 mg", 2, 1, 2, 1, 2, 1, "S", "N", "N", None),
    (5, "Ibufex", "Ibuprofeno 400 mg", "400 mg", 1, 1, 3, 1, 3, 1, "N", "N", "N", "Ibufex"),
    (6, "Concentra", "Metilfenidato 10 mg", "10 mg", 1, 1, 4, 1, 3, 1, "N", "N", "N", "Concentra"),
    (7, "Adalimumab Gama", "Adalimumab 40 mg/0,4 ml", "40 mg/0,4 ml", 4, 3, 5, 1, 3, 1, "N", "N", "S", None),
    (8, "Gastroprot", "Omeprazol 20 mg", "20 mg", 5, 1, 6, 1, 1, 1, "N", "N", "N", "Gastroprot"),
    (9, "Amoxil Alfa", "Amoxicilina 250 mg/5 ml", "250 mg/5 ml", 7, 2, 7, 1, 1, 1, "N", "N", "N", None),
    (10, "Respikid", "Palivizumab 100 mg/ml", "100 mg/ml", 4, 3, 8, 1, 3, 1, "N", "N", "S", "Respikid"),
    (11, "Dorfim Pediátrico", "Paracetamol 40 mg/ml", "40 mg/ml", 3, 2, 1, 1, 1, 1, "N", "N", "N", "Dorfim"),
    (12, "Diclogel", "Diclofenac 10 mg/g", "10 mg/g", 6, 4, 9, 1, 3, 1, "N", "N", "N", "Diclogel"),
    (13, "Tiras GlucoCheck", None, None, None, None, None, 2, 4, None, None, None, None, "GlucoCheck"),
    (14, "Creme Hidratante Derma", None, None, None, None, None, 3, 4, None, None, None, None, "Derma"),
    (15, "Leite Infantil Lacto 1", None, None, None, None, None, 5, 4, None, None, None, None, "Lacto"),
    (16, "Produto Sem Classificação", "Ranitidina 150 mg", "150 mg", 1, 1, 10, 1, 1, 1, "N", "N", "N", None),
    (17, "Omeprazol Beta", "Omeprazol 20 mg", "20 mg", 5, 1, 6, 1, 2, 3, "S", "N", "N", None),
    (18, "Ibuprofeno Beta", "Ibuprofeno 400 mg", "400 mg", 1, 1, 3, 1, 2, 1, "S", "N", "N", None),
]
escrever("PRODUTO", ["PROD_ID", "NOME", "DOSAGEM_CEDENCIA", "DOSAGEM", "FORMA_FARM_ID", "AGRUP_FORMA_FARM_ID",
                     "DCIPT_ID", "TIPO_PRODUTO_ID", "TIPO_AUTORIZ_ID", "CLASS_ESTP_PSICTR_ID", "TITULAR_AIM_ID",
                     "DATA_AIM", "ESTADO_AIM_ID", "DATA_EST_AIM", "NR_PROCESSO", "TIPO_PROCEDIMENTO_ID",
                     "IND_GENERICO", "IND_MARGEM_TERAP", "IND_MONIT_ADICIONAL_FV", "IND_FNM", "DATA_ALTERACAO",
                     "MARCA", "MODELO", "PROD_GUID"],
         [(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], None, None, p[8], "2015-01-01", p[9], "2015-01-01",
           f"PROC{p[0]:05d}", None, p[10], p[11], p[12], "N", "2026-11-01", p[13], None, f"guid-{p[0]}") for p in P])

# ---------------- embalagens ----------------
# EMB_ID, PROD_ID, NR_REGISTO, DESCR, GH, CNPEM, PEM_AMB, SUBST_FARM, DATA_PREV_REPOS
E = [
    (101, 1, "5000001", "Blister - 20 unidades", "GH0001", 50000010, "S", "S", None),
    (102, 2, "5000002", "Blister - 20 unidades", "GH0001", 50000010, "S", "S", None),
    (103, 3, "5000003", "Blister - 28 unidades", "GH0002", 50000030, "S", "S", None),
    (104, 3, "5000004", "Blister - 56 unidades", "GH0002", 50000031, "S", "S", None),
    (105, 4, "5000005", "Blister - 28 unidades", "GH0002", 50000030, "S", "S", None),
    (106, 5, "5000006", "Blister - 20 unidades", None, None, "S", "N", None),
    (107, 6, "5000007", "Frasco - 30 unidades", None, 50000070, "S", "N", None),
    (108, 7, "5000008", "Seringa pré-cheia - 2 unidades", None, 50000080, "S", "N", None),
    (109, 8, "5000009", "Frasco - 14 unidades", "GH0003", 50000090, "S", "S", "2026-12-15"),
    (110, 9, "5000010", "Frasco - 100 ml", None, 50000100, "S", "S", None),
    (111, 10, "5000011", "Frasco para injetáveis - 1 unidade", None, 50000110, "N", "N", None),
    (112, 11, "5000012", "Frasco - 85 ml", None, 50000120, "S", "S", None),
    (113, 12, "5000013", "Bisnaga - 100 g", None, None, "S", "N", None),
    (114, 13, "5000014", "Caixa - 50 tiras", None, None, "S", "N", None),
    (115, 14, "5000015", "Frasco - 200 ml", None, None, "N", "N", None),
    (116, 15, "5000016", "Lata - 800 g", None, None, "N", "N", None),
    (117, 16, "5000017", "Blister - 20 unidades", None, None, "S", "N", None),
    (118, 17, "5000018", "Frasco - 28 unidades", "GH0003", 50000090, "S", "S", None),
    (119, 18, "123456", "Blister - 20 unidades", None, None, "S", "S", None),   # 6 dígitos -> 0123456
    (120, 18, None, "Embalagem sem registo", None, None, "S", "S", None),       # ignorada
]
escrever("EMBALAGEM", ["EMB_ID", "PROD_ID", "NR_REGISTO", "DESCR", "GRUPO_HOM_COD", "QUANT_TOT", "UNID_QUANT_TOT_ID",
                       "QUANTIDADE", "UNID_QUANT_ID", "TIPO_EMB_ID", "ACOND_PRIMARIO_ID", "TIPO_TRATAMENTO_ID",
                       "ESTADO_EMB_ID", "IND_EMB_UNITARIA", "IND_EMB_HOSPITALAR", "IND_DISP_SEGURANCA", "PEM_AMB",
                       "PEM_AMB_MS", "PEM_AMB_BIO", "PEM_AMB_BIO_MS", "CNPEM", "CHNM_COD", "CDM", "REFERENCIA",
                       "CARACT_ESPECIFICAS", "SUBSTITUICAO_FARMACIA", "DATA_PREVISTA_REPOSICAO", "LNP", "EXPORT_TEMP_SUSP"],
         [(e[0], e[1], e[2], e[3], e[4], None, None, None, None, None, None, None, 1, "N", "N", "N", e[6], e[6], "N", "N",
           e[5], None, None, None, None, e[7], e[8], "N", "N") for e in E])

# ---------------- ligações ----------------
escrever("LNK_PROD_CLASS_DISP", ["PROD_ID", "CLASS_DISP_PROD_ID"], [
    (1, 1), (2, 1), (3, 6), (4, 6), (5, 8), (6, 4), (7, 11), (8, 7), (9, 6), (10, 5), (10, 10),
    (11, 1), (12, 1), (17, 6), (18, 1), (18, 6),   # 18: duas classificações -> fica a mais restritiva
])
escrever("LNK_PROD_GRUPO_PROD", ["PROD_ID", "GRUPO_PRODUTO_ID"], [
    (2, 1), (4, 1), (7, 12), (7, 14), (10, 13), (17, 1), (18, 1),
])
escrever("LNK_PROD_SUBGRUPO_PROD", ["PROD_ID", "SUBGRUPO_PRODUTO_ID"], [(15, 100)])
escrever("LNK_PROD_ATC", ["PROD_ID", "ATC_COD"], [
    (1, "N02BE01"), (2, "N02BE01"), (3, "C10AA05"), (4, "C10AA05"), (5, "M01AE01"), (6, "N06BA04"), (7, "L04AB04"),
    (8, "A02BC01"), (9, "J01CA04"), (10, "J06BD01"), (11, "N02BE01"), (12, "M02AA15"), (17, "A02BC01"), (18, "M01AE01"),
])
escrever("LNK_PROD_CFT", ["PROD_ID", "CFT_COD", "CFT_CHNM"], [
    (1, "2.10", "S"), (2, "2.10", "S"), (3, "3.7", "S"), (4, "3.7", "S"), (5, "9.1.1", "S"), (6, "2.7", "S"),
    (7, "16.3", "S"), (8, "6.2.2", "S"), (9, "1.1.1", "S"), (10, "1.4", "S"), (11, "2.10", "S"), (12, "9.1.10", "S"),
    (17, "6.2.2", "S"), (18, "9.1.1", "S"),
])
escrever("LNK_PROD_VIA_ADMIN", ["PROD_ID", "VIA_ADMIN_ID"], [
    (1, 1), (2, 1), (3, 1), (4, 1), (5, 1), (6, 1), (7, 2), (8, 1), (9, 1), (10, 3), (11, 1), (12, 4), (17, 1), (18, 1),
])
escrever("LNK_PROD_SUBST", ["PROD_ID", "SUBST_ID", "QUANTIDADE", "UNID_QUANT_ID"], [(1, 1, "500", 1), (3, 2, "20", 1)])

# ---------------- preços ----------------
# PRECO_ID, EMB_ID, TIPO, PRECO, INICIO, FIM, ATIVO, ATIVO_MS
PR = [
    (1, 101, 1, 2.50, "2025-01-01", "2026-03-31", 0, 0),   # PVP antigo
    (2, 101, 1, 2.65, "2026-04-01", None, 1, 1),           # PVP em vigor
    (3, 102, 1, 1.79, "2025-01-01", None, 1, 1),
    (4, 103, 1, 9.80, "2025-01-01", None, 1, 1),
    (5, 103, 101, 4.12, "2026-01-01", None, None, None),   # preço de referência
    (6, 105, 1, 4.12, "2025-01-01", None, 1, 1),
    (7, 105, 101, 4.12, "2026-01-01", None, None, None),
    (8, 105, 1, 3.95, "2026-12-01", None, 0, 1),           # próximo mês: não conta ainda
    (9, 107, 401, 18.40, "2025-06-01", None, 1, 1),        # PVP Max
    (10, 113, 602, 7.90, "2025-06-01", None, None, None),  # PVP notificado
]
escrever("PRECO", ["PRECO_ID", "EMB_ID", "TIPO_PRECO_ID", "PRECO", "DATA_INICIO", "DATA_FIM", "ATIVO", "ATIVO_MS",
                   "DATA_FIM_ESCOAMENTO"], [p + (None,) for p in PR])

escrever("COMERCIALIZACAO", ["COMERC_ID", "EMB_ID", "ESTADO_COMERC_ID", "DATA_INICIO", "DATA_FIM"],
         [(i, e[0], 5 if e[0] == 109 else 1, "2025-01-01", None) for i, e in enumerate(E, 1)])

escrever("COMPARTICIPACAO", ["COMPART_ID", "EMB_ID", "TIPO_REGIME_ID", "NORMA_REG_EXC_ID", "REGIME_EXCECIONAL_ID",
                             "NIVEL_COMPART_ID", "DATA_INICIO", "DATA_FIM"], [
    (1, 103, 1, None, None, 2, "2025-01-01", None),
    (2, 105, 1, None, None, 2, "2025-01-01", None),
    (3, 105, 2, None, None, 1, "2025-01-01", None),
    (4, 109, 1, None, None, 3, "2020-01-01", "2024-12-31"),  # já terminou
])
escrever("ESCOAMENTO", ["ESCOAM_ID", "EMB_ID", "MOTIVO_ESCOAM_ID", "DATA_INICIO", "DATA_FIM"], [
    (1, 118, 1, "2026-09-01", "2027-02-28"),
])
escrever("COND_ARMAZENAMENTO", ["COND_ARMAZ_ID", "EMB_ID", "ESTADO_ARMAZ_ID", "TEMPERATURA_ARMAZ_ID", "NR_PRAZO_VAL",
                                "UNID_TEMP_PRAZO_VAL_ID"], [(1, 108, 1, 2, "24", 1), (2, 111, 1, 2, "36", 1)])
escrever("ALERTA", ["ALERTA_ID", "DATA_INICIO", "DATA_FIM", "TIPO_APRESENTACAO_ID", "SEXO_ID", "TIPO_ALERTA_ID",
                    "FAIXA_ETARIA_INICIO", "FAIXA_ETARIA_FIM"], [(1, "2025-01-01", None, 1, None, 1, 0, 6)])
escrever("MENSAGEM_ALERTA", ["MENSAGEM_ALERTA_ID", "EMB_ID", "MENSAGEM", "LINK", "TIPO_DESTINATARIO_ID", "ALERTA_ID",
                             "IDIOMA"], [(1, 107, "Medicamento sujeito a controlo especial.", None, 2, 1, "PT")])

print(f"fixtures escritas em {out}")
