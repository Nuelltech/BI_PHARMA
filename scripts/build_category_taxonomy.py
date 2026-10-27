import openpyxl
import json
import os
import re

def main():
    print("1. A carregar ficheiros Excel da FirstPharma...")
    
    # 1. Categorias 2304
    wb1 = openpyxl.load_workbook('Avenida/Farmácia Avenida Categorias 2304.xlsx', read_only=True)
    s1 = wb1['Export']
    cat_2304 = {}
    cur_cat = None
    for row in s1.iter_rows(values_only=True):
        if len(row) > 3 and row[2] == 'Categoria' and row[3]:
            cur_cat = str(row[3]).strip()
        elif cur_cat and len(row) > 1 and row[1]:
            cnp = str(row[1]).strip()
            if cnp.isdigit() and len(cnp) == 7:
                cat_2304[cnp] = cur_cat
    print(f" - Categorias 2304: {len(cat_2304)} CNPs")

    # 2. Categorias Sazonais
    wb2 = openpyxl.load_workbook('Avenida/Categorias Sazonais F.Avenida Vila Real.xlsx', read_only=True)
    inverno_map = {}
    for row in wb2['Inverno'].iter_rows(values_only=True):
        if len(row) > 14 and row[3]:
            cnp = str(row[3]).strip()
            if cnp.isdigit() and len(cnp) == 7:
                inverno_map[cnp] = {
                    'hmr3': str(row[14]).strip() if row[14] else None,
                    'lab': str(row[13]).strip() if row[13] else None
                }

    primavera_map = {}
    for row in wb2['Primavera '].iter_rows(values_only=True):
        if len(row) > 14 and row[3]:
            cnp = str(row[3]).strip()
            if cnp.isdigit() and len(cnp) == 7:
                primavera_map[cnp] = {
                    'hmr3': str(row[14]).strip() if row[14] else None,
                    'lab': str(row[13]).strip() if row[13] else None
                }
    print(f" - Sazonais: {len(inverno_map)} Inverno, {len(primavera_map)} Primavera")

    # 3. Analise GH (Switches de Grupos Homogéneos)
    wb3 = openpyxl.load_workbook('Avenida/Análise GH - F. Avenida Vila Real.xlsx', read_only=True)
    gh_switches = {}
    for row in wb3['Genéricos'].iter_rows(values_only=True):
        if len(row) > 13 and row[1] and row[8]:
            cnp_orig = str(row[1]).strip()
            cnp_switch = str(row[8]).strip()
            if cnp_orig.isdigit() and len(cnp_orig) == 7 and cnp_switch.isdigit() and len(cnp_switch) == 7:
                rent_orig = 0.0
                rent_switch = 0.0
                try:
                    if row[7] is not None: rent_orig = float(row[7])
                except: pass
                try:
                    if row[13] is not None: rent_switch = float(row[13])
                except: pass
                ganho = round(max(0.0, rent_switch - rent_orig), 2)
                gh_switches[cnp_orig] = {
                    'switch_cnp': cnp_switch,
                    'switch_nome': str(row[9]).strip() if row[9] else '',
                    'switch_lab': str(row[10]).strip() if row[10] else '',
                    'ganho_unitario': ganho
                }
    print(f" - Analise GH Switches: {len(gh_switches)} pares de substituição")

    # 4. Dicionário Mestre FirstPharma existente (55k)
    dict_path = 'src/data/firstpharma_dictionary.json'
    fp_dict = {}
    if os.path.exists(dict_path):
        with open(dict_path, 'r', encoding='utf-8') as f:
            fp_dict = json.load(f)
    print(f" - Dicionário Mestre FirstPharma: {len(fp_dict)} produtos")

    # Função de Mapeamento Hierárquico
    def categorize(cnp, fp_entry):
        hmr3 = None
        if cnp in cat_2304:
            hmr3 = cat_2304[cnp]
        elif cnp in inverno_map and inverno_map[cnp]['hmr3']:
            hmr3 = inverno_map[cnp]['hmr3']
        elif cnp in primavera_map and primavera_map[cnp]['hmr3']:
            hmr3 = primavera_map[cnp]['hmr3']
        elif fp_entry and fp_entry.get('c') and fp_entry['c'] != 'MSRM':
            hmr3 = fp_entry['c']

        is_msrm = False
        if fp_entry and fp_entry.get('m') == 1:
            is_msrm = True
        
        # Determinar Sazonalidade
        sazonalidade = 'TODO_O_ANO'
        if cnp in inverno_map:
            sazonalidade = 'INVERNO'
        elif cnp in primavera_map:
            sazonalidade = 'PRIMAVERA'
        elif hmr3:
            h_lower = hmr3.lower()
            if any(k in h_lower for k in ['antigripal', 'tosse', 'expectorante', 'garganta', 'frieira', 'descongestionante nasal']):
                sazonalidade = 'INVERNO'
            elif any(k in h_lower for k in ['anti-alérg', 'antialérg', 'piolho', 'antiparasitário capilar', 'emagrecimento', 'drenante']):
                sazonalidade = 'PRIMAVERA'
            elif any(k in h_lower for k in ['solar', 'bronzeador', 'repelente', 'picada', 'pernas pesadas', 'venotrópico']):
                sazonalidade = 'VERAO'

        # Determinar Macro-Área, Categoria (Nível 2) e Subcategoria (Nível 3)
        macro_area = 'MSRM' if is_msrm else 'MNSRM_OTC'
        categoria = 'Outros Cuidados de Saúde'
        subcategoria = hmr3 or 'Geral'

        if not hmr3:
            if is_msrm:
                macro_area = 'MSRM'
                categoria = 'Medicamentos de Prescrição Médica'
                subcategoria = 'Terapêutica Crónica / Geral'
            else:
                macro_area = 'MNSRM_OTC'
                categoria = 'Venda Livre / OTC'
                subcategoria = 'Geral'
        else:
            h = hmr3.lower()
            if any(k in h for k in ['dor', 'febre', 'analgésic', 'anti-inflamatório', 'reumático']):
                macro_area = 'MSRM' if is_msrm else 'MNSRM_OTC'
                categoria = 'Alívio da Dor & Febre'
                if 'tópico' in h or 'gel' in h or 'penso' in h:
                    subcategoria = 'Dor Tópica (Géis/Emplastros)'
                elif 'oral' in h or 'comprimido' in h or 'paracetamol' in h or 'ibuprofeno' in h:
                    subcategoria = 'Dor Oral (Comprimidos/Saquetas)'
                else:
                    subcategoria = hmr3

            elif any(k in h for k in ['gripe', 'tosse', 'respirat', 'expectorante', 'nasal', 'garganta', 'antitússic']):
                macro_area = 'MSRM' if is_msrm else 'MNSRM_OTC'
                categoria = 'Gripes & Vias Respiratórias'
                if 'antigripal' in h: subcategoria = 'Antigripais & Descongestionantes'
                elif 'tosse seca' in h: subcategoria = 'Tosse Seca'
                elif 'expectorante' in h or 'produtiva' in h: subcategoria = 'Tosse Produtiva / Expectorantes'
                elif 'garganta' in h: subcategoria = 'Inflamação e Dor de Garganta'
                elif 'nasal' in h: subcategoria = 'Descongestionantes Nasais'
                else: subcategoria = hmr3

            elif any(k in h for k in ['digestiv', 'laxante', 'diarreia', 'probiótic', 'estômag', 'antiácid', 'hemorroid']):
                macro_area = 'MSRM' if is_msrm else 'MNSRM_OTC'
                categoria = 'Gastroenterologia & Digestivo'
                if 'laxante' in h: subcategoria = 'Laxantes & Trânsito Intestinal'
                elif 'diarreia' in h: subcategoria = 'Antidiarreicos'
                elif 'probiótic' in h: subcategoria = 'Probióticos & Flora Intestinal'
                elif 'antiácid' in h or 'estômag' in h: subcategoria = 'Antiácidos & Refluxo'
                elif 'hemorroid' in h: subcategoria = 'Anti-Hemorroidários'
                else: subcategoria = hmr3

            elif any(k in h for k in ['alérg', 'olho', 'lágrima', 'ocular', 'oftálmic']):
                macro_area = 'MSRM' if is_msrm else 'MNSRM_OTC'
                categoria = 'Alergias & Saúde Ocular'
                if 'oral' in h or 'anti-alérgicos' in h: subcategoria = 'Anti-alérgicos Orais'
                elif 'lágrima' in h or 'lubrificante' in h or 'olho' in h: subcategoria = 'Lágrimas Artificiais & Saúde Ocular'
                else: subcategoria = hmr3

            elif any(k in h for k in ['sono', 'ansiedade', 'stress', 'humor', 'sedativ']):
                macro_area = 'MSRM' if is_msrm else 'MNSRM_OTC'
                categoria = 'Sono, Stress & Sistema Nervoso'
                subcategoria = 'Sono & Tranquilizantes Ligeiros'

            elif any(k in h for k in ['pele', 'dermo', 'acne', 'atópic', 'hidrat', 'solar', 'champô', 'capilar', 'cabelo', 'cicatriz', 'calos']):
                macro_area = 'DERMOCOSMETICA'
                categoria = 'Dermocosmética & Higiene da Pele'
                if 'solar' in h or 'bronzeador' in h: subcategoria = 'Proteção Solar'
                elif 'acne' in h: subcategoria = 'Anti-Acne & Pele Oleosa'
                elif 'atópic' in h or 'secura' in h: subcategoria = 'Pele Seca & Atópica'
                elif 'cicatriz' in h: subcategoria = 'Cicatrizantes & Queimaduras'
                elif 'capilar' in h or 'champô' in h or 'cabelo' in h: subcategoria = 'Cuidado Capilar & Antiqueda'
                else: subcategoria = hmr3

            elif any(k in h for k in ['vitamina', 'suplement', 'ginseng', 'minerais', 'ómega', 'emagrecimento']):
                macro_area = 'NUTRICAO_SUPLEMENTOS'
                categoria = 'Nutrição, Vitaminas & Suplementos'
                subcategoria = hmr3

            elif any(k in h for k in ['pensos', 'preservativ', 'tiras', 'agulhas', 'dispositivo', 'termómetro']):
                macro_area = 'DISPOSITIVOS_SAUDE'
                categoria = 'Dispositivos Médicos & Primeiros Socorros'
                subcategoria = hmr3

            elif is_msrm:
                macro_area = 'MSRM'
                categoria = 'Medicamentos de Prescrição Médica'
                subcategoria = hmr3

        # Dados de GH / Switch
        gh_data = gh_switches.get(cnp, {})
        gh_codigo = fp_entry.get('gh') if fp_entry else None
        if gh_codigo == 'Sem Grupo Homogéneo': gh_codigo = None

        return {
            'macro_area': macro_area,
            'categoria': categoria,
            'subcategoria': subcategoria,
            'sazonalidade': sazonalidade,
            'gh_codigo': gh_codigo,
            'gh_switch_cnp': gh_data.get('switch_cnp'),
            'gh_switch_nome': gh_data.get('switch_nome'),
            'gh_switch_margem_ganho': gh_data.get('ganho_unitario')
        }

    # Gerar mapa completo
    print("2. A processar taxonomia para todo o catálogo...")
    taxonomy_map = {}
    
    # Processar todos os CNPs dos ficheiros
    all_cnps = set(fp_dict.keys()) | set(cat_2304.keys()) | set(inverno_map.keys()) | set(primavera_map.keys()) | set(gh_switches.keys())
    
    macro_counts = {}
    cat_counts = {}
    saz_counts = {}
    switches_count = 0

    for cnp in all_cnps:
        fp_e = fp_dict.get(cnp)
        res = categorize(cnp, fp_e)
        taxonomy_map[cnp] = res

        m = res['macro_area']
        macro_counts[m] = macro_counts.get(m, 0) + 1
        c = res['categoria']
        cat_counts[c] = cat_counts.get(c, 0) + 1
        s = res['sazonalidade']
        saz_counts[s] = saz_counts.get(s, 0) + 1
        if res['gh_switch_cnp']:
            switches_count += 1

    print("\n--- Estatísticas da Estrutura Criada ---")
    print(f"Total de Produtos Taxonomizados: {len(taxonomy_map)}")
    print("\nPor Macro-Área:")
    for k, v in sorted(macro_counts.items(), key=lambda x: -x[1]):
        print(f" - {k}: {v} produtos ({v/len(taxonomy_map)*100:.1f}%)")

    print("\nPor Categoria (Top 10):")
    for k, v in sorted(cat_counts.items(), key=lambda x: -x[1])[:10]:
        print(f" - {k}: {v} produtos")

    print("\nPor Sazonalidade:")
    for k, v in sorted(saz_counts.items(), key=lambda x: -x[1]):
        print(f" - {k}: {v} produtos")

    print(f"\nOportunidades de Switch GH Mapeadas: {switches_count} produtos com alternativa rentável")

    out_file = 'src/data/category_taxonomy_map.json'
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(taxonomy_map, f, ensure_ascii=False)
    print(f"\nGravação concluída em: {out_file}")

if __name__ == '__main__':
    main()
