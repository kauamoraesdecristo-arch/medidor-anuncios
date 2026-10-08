'use strict';
/* Testes do medidor (rodam sem internet): node teste.js */
const assert = require('assert');
const { parseListagem, gerarResumo, parseCsv, infoAnuncio, CABECALHO } = require('./medir.js');

const cfg = { loja: { id: '8720', slugs: ['tk-tratores'] }, topoLimite: 3, fusoHorario: 'America/Cuiaba' };
const BASE = 'https://www.tratoresecolheitadeiras.com.br';
let falhas = 0;
const teste = (nome, fn) => { try { fn(); console.log('ok   -', nome); } catch (e) { falhas++; console.log('FALHA-', nome, '\n      ', e.message); } };

// cartão no mesmo formato da página real: imagem com link, selo, título, loja (2 links), preço, "Ver mais"
function cartao({ id, loja, lojaId, cidade = 'cidade', uf = 'ms', pago = false, tipo = 'trator' }) {
  const url = `${BASE}/veiculo/${cidade}/${uf}/${tipo}/marca/modelo-${id}/2010/tracao-4x4/sem-cabine/${loja}/${id}`;
  const urlLoja = `${BASE}/${cidade}/${uf}/loja/${loja}/veiculo/${lojaId}`;
  return `
<div class="item">
  <a href="${url}" title="ANUNCIO ${id}"><img src="x.webp" alt="ANUNCIO ${id}"></a>
  ${pago ? '<span class="tag">Publicidade</span>' : ''}
  <h2><a href="${url}">MODELO ${id} 2010/2010</a></h2>
  <a href="${urlLoja}">${loja}/${uf.toUpperCase()}</a>
  <a href="${urlLoja}"><img src="logo.jpg" alt="${loja} logo"></a>
  <h3>Tração 4x4</h3><span>R$ 100.000,00</span>
  <a href="${url}">Ver Mais</a>
</div>`;
}
function pagina(cartoes, rodape = '') {
  return `<html><body>
<a href="javascript:__doPostBack('ctl00$lbSupperBannerDesktop','')"><img src="b.webp"></a>
<nav><a href="${BASE}/comprar">Comprar</a><a href="${BASE}/veiculo/2760">falso link só com número</a></nav>
<div class="lista">${cartoes.join('\n')}</div>
<div class="pager"><a href="javascript:__doPostBack('ctl00$DataPager1$ctl01$ctl01','')">2</a></div>
<aside><h4>Publicidade</h4><a href="javascript:void(0)">banner</a></aside>${rodape}
</body></html>`;
}
const outros = (n, ini = 100) => Array.from({ length: n }, (_, i) => cartao({ id: ini + i, loja: 'loja-' + (ini + i), lojaId: 5000 + i }));
const nosso = id => cartao({ id, loja: 'tk-tratores', lojaId: 8720, cidade: 'nova-andradina' });

teste('infoAnuncio lê o id e a loja; ignora link de loja e de navegação', () => {
  assert.deepStrictEqual(infoAnuncio(`${BASE}/veiculo/a/ms/trator/m/x/2010/t/c/tk-tratores/1249673`), { id: '1249673', slug: 'tk-tratores' });
  assert.strictEqual(infoAnuncio(`${BASE}/nova-andradina/ms/loja/tk-tratores-nova-andradina/ms/veiculo/8720`), null);
  assert.strictEqual(infoAnuncio(`${BASE}/veiculo/2760`), null);
  assert.strictEqual(infoAnuncio(`${BASE}/comprar`), null);
  assert.strictEqual(infoAnuncio(`javascript:__doPostBack('x','')`), null);
});

teste('posição, anúncios acima, pagos e bloco inicial', () => {
  const lista = [
    cartao({ id: 1, loja: 'localiza', lojaId: 2760, pago: true }),
    cartao({ id: 2, loja: 'implemaq', lojaId: 19805, pago: true }),
    ...outros(2, 10),            // posições 3 e 4: outras lojas
    nosso(901), nosso(902), nosso(903),   // posições 5, 6, 7
    ...outros(4, 20),            // 8 a 11
    nosso(904),                  // 12
    ...outros(8, 40),            // 13 a 20
  ];
  const d = parseListagem(pagina(lista), cfg);
  assert.strictEqual(d.total, 20);
  assert.strictEqual(d.primeira, 5);
  assert.strictEqual(d.acimaTotal, 4);
  assert.strictEqual(d.acimaPagos, 2);
  assert.strictEqual(d.acimaOutras, 2);
  assert.strictEqual(d.nossas, 4);
  assert.strictEqual(d.bloco, 3);
});

teste('o selo "Publicidade" da lateral/rodapé não marca o último anúncio como pago', () => {
  const lista = [...outros(5, 10), nosso(901)];
  const d = parseListagem(pagina(lista), cfg);
  assert.strictEqual(d.total, 6);
  assert.strictEqual(d.ads[5].pago, false);
  assert.strictEqual(d.ads[5].nosso, true);
  assert.strictEqual(d.acimaPagos, 0);
});

teste('detecta anúncio nosso pelo link da loja (id 8720) mesmo com outro nome na URL', () => {
  const x = cartao({ id: 777, loja: 'outro-nome-da-loja', lojaId: 8720, cidade: 'nova-andradina' });
  const d = parseListagem(pagina([...outros(3, 10), x]), cfg);
  assert.strictEqual(d.primeira, 4);
  assert.strictEqual(d.acimaOutras, 3);
});

teste('lojas de outras cidades com o mesmo prefixo não são confundidas com a nossa', () => {
  const x = cartao({ id: 555, loja: 'tk-tratores-sul', lojaId: 9999 });
  const d = parseListagem(pagina([x, nosso(901)]), cfg);
  assert.strictEqual(d.primeira, 2);
  assert.strictEqual(d.nossas, 1);
});

teste('lista sem nenhum anúncio nosso', () => {
  const d = parseListagem(pagina(outros(20)), cfg);
  assert.strictEqual(d.total, 20);
  assert.strictEqual(d.primeira, null);
  assert.strictEqual(d.acimaOutras, null);
  assert.strictEqual(d.nossas, 0);
});

teste('página sem anúncios (bloqueio ou mudança do site) dá total 0', () => {
  const d = parseListagem('<html><body>Just a moment...</body></html>', cfg);
  assert.strictEqual(d.total, 0);
});

teste('o mesmo anúncio repetido (imagem, título, ver mais) conta uma vez só', () => {
  const d = parseListagem(pagina([nosso(901), ...outros(2, 10)]), cfg);
  assert.strictEqual(d.total, 3);
});

teste('aspas simples e links relativos', () => {
  const html = `<a href='/veiculo/a/ms/trator/m/x/2010/t/c/tk-tratores/1'>x</a><a href='/veiculo/b/ms/trator/m/x/2010/t/c/loja-b/2'>y</a>`;
  const d = parseListagem(html, cfg);
  assert.strictEqual(d.total, 2);
  assert.strictEqual(d.primeira, 1);
});

teste('CSV: ler campos com aspas e vírgulas', () => {
  const r = parseCsv('a,b,c\n1,"x, y",3\n4,"diz ""oi""",6\n');
  assert.deepStrictEqual(r, [{ a: '1', b: 'x, y', c: '3' }, { a: '4', b: 'diz "oi"', c: '6' }]);
});

// ----- resumo com vários dias de leituras simuladas -----
function csvSimulado(dias, passoMin, fn) {
  const linhas = [CABECALHO.join(',')];
  const inicio = Date.UTC(2026, 9, 1, 11, 0, 0);   // 07:00 em Cuiabá (UTC-4)
  const total = Math.floor(dias * 24 * 60 / passoMin);
  for (let i = 0; i < total; i++) {
    const ts = inicio + i * passoMin * 60000;
    const utc = new Date(ts).toISOString();
    const loc = new Date(ts - 4 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
    const r = fn(i, ts);
    if (r === null) linhas.push([loc, utc, 'Implementos', 'erro:bloqueado_pelo_site (HTTP 403)', '', '', '', '', '', '', ''].join(','));
    else if (r === -1) linhas.push([loc, utc, 'Implementos', 'fora_da_pagina', 20, '', '', '', '', 0, ''].join(','));
    else linhas.push([loc, utc, 'Implementos', 'ok', 20, r + 3, r + 2, 2, r, 5, 3].join(','));
  }
  return linhas.join('\n') + '\n';
}

teste('resumo: com dados suficientes calcula períodos no topo, horas e sugestão', () => {
  // a cada 4 h (passo de 30 min = 8 leituras) sobe; depois os concorrentes passam 1 a cada leitura
  const csv = csvSimulado(4, 30, i => (i % 8));       // acima = 0..7; topo (<=3) em 4 de cada 8 leituras
  const md = gerarResumo(csv, cfg);
  assert.match(md, /## Implementos/);
  assert.match(md, /Em 50% das 192 leituras/);
  assert.match(md, /\| 24 \| 2 h \| 2 h \| 2 h \|/);
  assert.match(md, /Sugestão automática/);
  assert.match(md, /### Por hora do dia/);
  assert.match(md, /Últimas 12 leituras/);
});

teste('resumo: poucas leituras avisa que faltam dados', () => {
  const md = gerarResumo(csvSimulado(0.05, 30, () => 0), cfg);
  assert.match(md, /poucas leituras/);
});

teste('resumo: erros e "fora da página" aparecem sem quebrar', () => {
  const md = gerarResumo(csvSimulado(1, 30, i => (i % 5 === 0 ? null : i % 7 === 0 ? -1 : 2)), cfg);
  assert.match(md, /Leituras com erro: \d+ de 48/);
  assert.match(md, /fora da 1ª página|erro:bloqueado/);
});

teste('resumo: última leitura com erro mostra o motivo', () => {
  const csv = csvSimulado(0.2, 30, i => (i < 5 ? 1 : null));
  assert.match(gerarResumo(csv, cfg), /não funcionou:\*\* erro:bloqueado_pelo_site/);
});

teste('resumo: arquivo vazio', () => {
  assert.match(gerarResumo(CABECALHO.join(',') + '\n', cfg), /Ainda não há leituras/);
});

console.log(falhas ? `\n${falhas} teste(s) falharam` : '\nTodos os testes passaram');
process.exit(falhas ? 1 : 0);
