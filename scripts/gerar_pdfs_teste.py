"""
Gera PDF sintéticos para testar o worker de RCM (todos com o nome que o Infomed dá: documento*.pdf).
Texto fictício com a estrutura QRD; não usar como informação clínica.

  python3 scripts/gerar_pdfs_teste.py test/fixtures/rcm_sintetico
"""
import shutil
import sys
import textwrap
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

out = Path(sys.argv[1] if len(sys.argv) > 1 else "test/fixtures/rcm_sintetico")
if out.exists():
    shutil.rmtree(out)
out.mkdir(parents=True)

# Fonte com acentos
for cand in ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"]:
    if Path(cand).exists():
        pdfmetrics.registerFont(TTFont("F", cand))
        FONTE = "F"
        break
else:
    FONTE = "Helvetica"


def pdf(nome, linhas):
    c = canvas.Canvas(str(out / nome), pagesize=A4)
    c.setFont(FONTE, 10)
    y = 800
    for l in linhas:
        for parte in textwrap.wrap(l, 95) or [""]:
            if y < 60:
                c.showPage(); c.setFont(FONTE, 10); y = 800
            c.drawString(50, y, parte)
            y -= 14
    c.save()


ENCHIMENTO = "Texto de enchimento para simular o comprimento de um RCM real com várias linhas de conteúdo. " * 6


def rcm(nome, dci, dosagem, forma, indicacoes, posologia, cnps, titular, revisao="03/2025", sec8=True):
    l = [
        "ANEXO I", "RESUMO DAS CARACTERÍSTICAS DO MEDICAMENTO", "",
        "1. NOME DO MEDICAMENTO", f"{nome} {dosagem} {forma}", "",
        "2. COMPOSIÇÃO QUALITATIVA E QUANTITATIVA", f"Cada unidade contém {dosagem} de {dci}.", "Lista completa de excipientes, ver secção 6.1.", "",
        "3. FORMA FARMACÊUTICA", forma, "",
        "4. INFORMAÇÕES CLÍNICAS", "",
        "4.1 Indicações terapêuticas", indicacoes, "",
        "4.2 Posologia e modo de administração", posologia, "Em caso de doença hepática, ver secção 4.3 Contraindicações e secção 4.4.", ENCHIMENTO, "",
        "4.3 Contraindicações", "Hipersensibilidade à substância ativa ou a qualquer um dos excipientes mencionados na secção 6.1.", "",
        "4.4 Advertências e precauções especiais de utilização", ENCHIMENTO, "",
        "4.5 Interações medicamentosas e outras formas de interação", ENCHIMENTO, "",
        "4.6 Fertilidade, gravidez e aleitamento", ENCHIMENTO, "",
        "4.7 Efeitos sobre a capacidade de conduzir e utilizar máquinas", "Não relevante.", "",
        "4.8 Efeitos indesejáveis", ENCHIMENTO, "",
        "4.9 Sobredosagem", ENCHIMENTO, "",
        "5. PROPRIEDADES FARMACOLÓGICAS", "",
        "5.1 Propriedades farmacodinâmicas", ENCHIMENTO, "",
        "5.2 Propriedades farmacocinéticas", ENCHIMENTO, "",
        "5.3 Dados de segurança pré-clínica", ENCHIMENTO, "",
        "6. INFORMAÇÕES FARMACÊUTICAS", "",
        "6.1 Lista dos excipientes", "Celulose microcristalina, estearato de magnésio.", "",
        "6.2 Incompatibilidades", "Não aplicável.", "",
        "6.3 Prazo de validade", "3 anos.", "",
        "6.4 Precauções especiais de conservação", "Não necessita de precauções especiais de conservação.", "",
        "6.5 Natureza e conteúdo do recipiente", "Blister de PVC/Alu. Embalagens de 20 unidades.", "",
        "6.6 Precauções especiais de eliminação e manuseamento", "Não existem requisitos especiais.", "",
        "7. TITULAR DA AUTORIZAÇÃO DE INTRODUÇÃO NO MERCADO", titular, "Rua Exemplo, 1, 1000-001 Lisboa", "",
        "8. NÚMERO(S) DA AUTORIZAÇÃO DE INTRODUÇÃO NO MERCADO",
    ]
    if sec8:
        l += [f"N.º de registo: {c} - Embalagem de 20 unidades" for c in cnps]
    else:
        l += ["Ver embalagem."]
    l += ["", "9. DATA DA PRIMEIRA AUTORIZAÇÃO/RENOVAÇÃO DA AUTORIZAÇÃO DE INTRODUÇÃO NO MERCADO",
          "Data da primeira autorização: 12 de março de 2010", "",
          "10. DATA DA REVISÃO DO TEXTO", revisao]
    return l


IND_PARACETAMOL = ("Tratamento sintomático da dor ligeira a moderada e da febre. "
                   "Fictício para testes.")
POS_ADULTO = "Adultos e adolescentes com peso superior a 50 kg: 1 comprimido até 3 vezes por dia. Fictício."

# 1. marca
pdf("documento.pdf", rcm("Dorfim", "paracetamol", "500 mg", "Comprimido", IND_PARACETAMOL, POS_ADULTO,
                         ["5000001"], "Laboratório Alfa, S.A."))
# 2. genérico com indicações iguais (texto da 4.1 idêntico -> mesmo hash)
pdf("documento (1).pdf", rcm("Paracetamol Beta", "paracetamol", "500 mg", "Comprimido", IND_PARACETAMOL, POS_ADULTO,
                             ["5000002"], "Genéricos Beta, Lda.", revisao="Novembro de 2024"))
# 3. pediátrico, várias apresentações na secção 8
pdf("documento (2).pdf", rcm("Dorfim Pediátrico", "paracetamol", "40 mg/ml", "Xarope",
                             "Tratamento sintomático da febre e da dor ligeira a moderada em crianças. Fictício.",
                             "Crianças a partir dos 3 meses: dose ajustada ao peso. Fictício.",
                             ["5000012", "5000099"], "Laboratório Alfa, S.A."))
# 4. RCM sem números de registo na secção 8 -> por rever
pdf("documento (3).pdf", rcm("Lipocor", "atorvastatina", "20 mg", "Comprimido revestido por película",
                             "Redução do colesterol elevado. Fictício.", POS_ADULTO, [], "Laboratório Alfa, S.A.", sec8=False))
# 5. RCM cujo CNP não existe na referência -> por rever
pdf("documento (4).pdf", rcm("Produto Desconhecido", "omeprazol", "20 mg", "Cápsula", "Fictício.", POS_ADULTO,
                             ["7777777"], "Pharma Gama, S.A."))
# 6. Folheto informativo
pdf("documento (5).pdf", ["Folheto informativo: Informação para o utilizador", "Dorfim 500 mg comprimidos", "Paracetamol",
                          "Leia com atenção todo este folheto antes de começar a tomar este medicamento.", ENCHIMENTO, ENCHIMENTO])
# 7. PDF sem texto (simula digitalização)
c = canvas.Canvas(str(out / "documento (6).pdf"), pagesize=A4); c.rect(50, 50, 400, 700); c.save()
# 8. Duplicado exato do n.º 1
shutil.copy(out / "documento.pdf", out / "documento (7).pdf")
# 9. CNP que existe mas o nome não confere (ex.: descarregou o RCM errado para o CNP)
pdf("documento (8).pdf", rcm("Zetamax", "azitromicina", "500 mg", "Comprimido", "Infeções bacterianas. Fictício.",
                             POS_ADULTO, ["5000003"], "Pharma Gama, S.A."))
print(f"PDF de teste em {out}")
