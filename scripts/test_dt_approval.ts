async function run() {
  const farmaciaId = '3ac42c32-87a8-4afe-98cc-4ca61ac64aca';
  const getUrl = `http://localhost:3000/api/packs?farmaciaId=${farmaciaId}&acesso=FARM-A-279188`;
  console.log('Fetching packs from:', getUrl);
  const packsRes = await fetch(getUrl);
  const packsData = await packsRes.json();
  const packToApprove = (packsData.packs || []).find((p: any) => p.id === 'pack_imunidade_inverno');
  if (!packToApprove) {
    console.error('Pack pack_imunidade_inverno não encontrado. Packs retornados:', (packsData.packs || []).map((p: any) => p.id));
    return;
  }
  console.log('Pack a testar:', packToApprove.titulo, '| Hash:', packToApprove.hashComposicao);

  // 1. Testar password errada
  console.log('\n--- 1. Teste de Password Incorreta ---');
  const failRes = await fetch('http://localhost:3000/api/packs/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-code': 'FARM-A-279188' },
    body: JSON.stringify({
      farmaciaId,
      packId: packToApprove.id,
      hashComposicao: packToApprove.hashComposicao,
      packData: packToApprove,
      reauth: { password: 'wrongpassword' },
    }),
  });
  console.log('Status com password errada (esperado 401):', failRes.status);
  const failData = await failRes.json();
  console.log('Mensagem erro recebida:', failData.error);

  // 2. Testar aprovação com DT (SuperAdmin2026!)
  console.log('\n--- 2. Teste de Assinatura DT com Sucesso ---');
  const okRes = await fetch('http://localhost:3000/api/packs/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-code': 'FARM-A-279188' },
    body: JSON.stringify({
      farmaciaId,
      packId: packToApprove.id,
      hashComposicao: packToApprove.hashComposicao,
      packData: packToApprove,
      reauth: { password: 'SuperAdmin2026!' },
    }),
  });
  console.log('Status com password certa (esperado 200):', okRes.status);
  const okData = await okRes.json();
  console.log('Resultado aprovação:', okData);

  // 3. Verificar que agora o pack aparece como ATIVO
  console.log('\n--- 3. Verificação de Estado do Pack em /api/packs ---');
  const afterRes = await fetch(getUrl);
  const afterData = await afterRes.json();
  const approvedPack = (afterData.packs || []).find((p: any) => p.id === packToApprove.id);
  console.log('Pack após aprovação:', approvedPack.titulo, '| Estado:', approvedPack.estadoCiclo, '| Validado por:', approvedPack.validadoPor);
}

run().catch(console.error);
