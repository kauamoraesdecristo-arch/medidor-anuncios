'use strict';
/*
 * MEDIDOR DE POSIÇÃO DOS ANÚNCIOS
 * Lê as listas públicas do site (ordenadas por "Mais recentes"), descobre em que posição
 * estão os anúncios da loja e guarda tudo em dados/posicoes.csv. Também escreve o RESUMO.md.
 * Não usa senha e não altera nada no site: só LÊ páginas públicas.
 */
const fs = require('fs');
const path = require('path');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const CABECALHO = [
  'data_hora_local', 'data_hora_utc', 'lista', 'status', 'total_anuncios', 'primeira_posicao',
  'acima_total', 'acima_pagos', 'acima_outras_lojas', 'nossas_na_pagina', 'bloco_inicial',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

// ---------------------------------------------------------------- horário
function agoraLocal(tz, d = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(d);
}

// ---------------------------------------------------------------- leitura da página
// Link de anúncio: /veiculo/<cidade>/<uf>/.../<loja>/<id>. O último trecho antes do número é a loja.
// (Links de loja têm o formato /<cidade>/<uf>/loja/<loja>/veiculo/<id> e NÃO começam com /veiculo/.)
function infoAnuncio(href) {
  const caminho = href.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0];
  const m = /^\/veiculo\/(.+)\/(\d+)\/?$/i.exec(caminho);
  if (!m) return null;
  const partes = m[1].split('/');
  let slug = partes[partes.length - 1];
  try { slug = decodeURIComponent(slug); } catch (e) { /* mantém como veio */ }
  return { id: m[2], slug: slug.toLowerCase() };
}

function parseListagem(html, cfg) {
  const reLink = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  const marcas = [];
  const vistos = new Set();
  const ultimo = {};   // posição do último link de cada anúncio (o "Ver mais" fecha o cartão)
  let m;
  while ((m = reLink.exec(html))) {
    const info = infoAnuncio((m[1] !== undefined ? m[1] : m[2] || '').trim());
    if (!info) continue;
    ultimo[info.id] = m.index;
    if (vistos.has(info.id)) continue;
    vistos.add(info.id);
    marcas.push({ ...info, ini: m.index });
  }
  const slugs = (cfg.loja.slugs || []).map(s => s.toLowerCase());
  const reLoja = new RegExp('/loja/[^"\'\\s>]*/veiculo/' + cfg.loja.id + '(?!\\d)', 'i');

  const ads = marcas.map((x, i) => {
    const proximo = i + 1 < marcas.length ? marcas[i + 1].ini : html.length;
    const fimBusca = Math.min(proximo, ultimo[x.id] + 1500, x.ini + 6000);
    const fimCartao = Math.min(proximo, x.ini + 2500, ultimo[x.id] > x.ini ? ultimo[x.id] : x.ini + 2500);
    const inicio = html.slice(x.ini, fimCartao);
    const texto = inicio.replace(/<[^>]*>/g, ' ');
    const pago = /publicidade|patrocinad/i.test(texto) || /class\s*=\s*["'][^"']*(publicidade|patrocinad)/i.test(inicio);
    const nosso = slugs.includes(x.slug) || reLoja.test(html.slice(x.ini, Math.max(fimBusca, x.ini + 1)));
    return { pos: i + 1, id: x.id, slug: x.slug, pago, nosso };
  });

  const nossas = ads.filter(a => a.nosso);
  const primeira = nossas.length ? nossas[0].pos : null;
  const antes = primeira ? ads.slice(0, primeira - 1) : [];
  const acimaPagos = antes.filter(a => a.pago).length;
  let bloco = 0;
  if (primeira) for (let i = primeira - 1; i < ads.length && ads[i].nosso; i++) bloco++;
  return {
    total: ads.length,
    primeira,
    acimaTotal: primeira ? primeira - 1 : null,
    acimaPagos: primeira ? acimaPagos : null,
    acimaOutras: primeira ? antes.length - acimaPagos : null,
    nossas: nossas.length,
    bloco: primeira ? bloco : null,
    ads,
  };
}

// ---------------------------------------------------------------- download
async function baixar(url) {
  let ultimoErro = '';
  for (let t = 1; t <= 3; t++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; medidor-posicao-anuncios/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'pt-BR,pt;q=0.9',
        },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);
      const html = await r.text();
      const desafio = /just a moment|cf-chl|attention required/i.test(html.slice(0, 6000));
      if ([403, 429, 503].includes(r.status) || (desafio && r.status !== 200)) {
        return { erro: `bloqueado_pelo_site (HTTP ${r.status})` };   // não insiste: evita sobrecarregar
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return { html };
    } catch (e) {
      ultimoErro = (e && e.name === 'AbortError') ? 'demorou_demais' : (e && e.message) || 'erro';
      await sleep(3000 * t);
    }
  }
  return { erro: 'falha_de_rede: ' + ultimoErro };
}

// ---------------------------------------------------------------- CSV
function csvCampo(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function parseCsv(texto) {
  const linhas = [];
  let campo = '', linha = [], aspas = false;
  const fecha = () => { linha.push(campo); campo = ''; };
  const fechaLinha = () => { fecha(); if (linha.length > 1 || linha[0] !== '') linhas.push(linha); linha = []; };
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === ',') fecha();
    else if (c === '\n') fechaLinha();
    else if (c !== '\r') campo += c;
  }
  if (campo !== '' || linha.length) fechaLinha();
  if (!linhas.length) return [];
  const cab = linhas[0];
  return linhas.slice(1).filter(l => l.length === cab.length).map(l => Object.fromEntries(cab.map((k, i) => [k, l[i]])));
}

// ---------------------------------------------------------------- resumo
const mediana = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const media = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const dur = min => {
  if (min === null || min === undefined) return '—';
  min = Math.round(min);
  return min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ' ' + (min % 60) + ' min' : ''}` : `${min} min`;
};
const f1 = v => (v === null || v === undefined ? '—' : (Math.round(v * 10) / 10).toString().replace('.', ','));

function resumoDaLista(nome, rs, topoLim) {
  const L = [`## ${nome}`, ''];
  const ultima = rs[rs.length - 1];
  if (ultima.status === 'ok') {
    L.push(`**Agora (${ultima.local}):** posição **${ultima.pos}ª** · **${ultima.acima}** anúncio(s) de outras lojas acima · ${ultima.nossas} nosso(s) na 1ª página.`);
  } else if (ultima.status === 'fora_da_pagina') {
    L.push(`**Agora (${ultima.local}):** nenhum anúncio nosso nos ${ultima.total} primeiros da lista. Estamos abaixo da 1ª página.`);
  } else {
    L.push(`**Última leitura (${ultima.local}) não funcionou:** ${ultima.status}`);
  }
  L.push('');

  const validas = rs.filter(r => r.status === 'ok' || r.status === 'fora_da_pagina')
    .map(r => ({ ...r, acima: r.status === 'ok' ? r.acima : r.total, topo: r.status === 'ok' && r.acima <= topoLim }));
  const falhas = rs.filter(r => r.status.startsWith('erro')).length;
  if (falhas) L.push(`Leituras com erro: ${falhas} de ${rs.length}.`, '');
  if (validas.length < 4) { L.push('_Ainda há poucas leituras para análise. Volte depois de algumas horas._', ''); return L; }

  // intervalo típico entre leituras
  const gaps = [];
  for (let i = 1; i < validas.length; i++) { const g = (validas[i].ts - validas[i - 1].ts) / 60000; if (g <= 90) gaps.push(g); }
  const passo = Math.round(mediana(gaps) || 30);

  // períodos seguidos no topo
  const periodos = [];
  let ini = null, fim = null;
  validas.forEach((r, i) => {
    const quebrou = i > 0 && (r.ts - validas[i - 1].ts) / 60000 > 90;
    if (ini !== null && (!r.topo || quebrou)) { periodos.push((fim - ini) / 60000 + passo); ini = null; }
    if (r.topo) { if (ini === null) ini = r.ts; fim = r.ts; }
  });
  if (ini !== null) periodos.push((fim - ini) / 60000 + passo);   // período ainda em andamento

  const pctTopo = Math.round(100 * validas.filter(r => r.topo).length / validas.length);
  L.push(`### Tempo no topo (até ${topoLim} anúncios de outras lojas acima)`, '');
  L.push(`Em ${pctTopo}% das ${validas.length} leituras estávamos no topo.`, '');
  if (periodos.length) {
    L.push('| Períodos seguidos no topo | Média | Mediana | Maior |', '|---|---|---|---|');
    L.push(`| ${periodos.length} | ${dur(media(periodos))} | ${dur(mediana(periodos))} | ${dur(Math.max(...periodos))} |`, '');
    if (periodos.length >= 3 && validas.length >= 96) {
      const sug = Math.max(30, Math.round(mediana(periodos) * 0.8 / 30) * 30);
      L.push(`**Sugestão automática:** subir a cada cerca de **${dur(sug)}** mantém os anúncios no topo na maior parte do tempo. ` +
        `É uma estimativa pelos dados até agora; revise depois de uma semana.`, '');
    } else {
      L.push('_Dados ainda insuficientes para sugerir um intervalo (preciso de pelo menos 2 dias e 3 períodos)._', '');
    }
  } else {
    L.push('Nenhum período no topo nas leituras até agora.', '');
  }

  // por hora do dia
  const horas = {};
  validas.forEach((r, i) => {
    const h = r.local.slice(11, 13);
    const o = horas[h] || (horas[h] = { n: 0, topo: 0, acima: [], pares: 0, empurrao: 0 });
    o.n++; if (r.topo) o.topo++;
    if (r.status === 'ok') o.acima.push(r.acima);
    if (i > 0 && validas[i - 1].status === 'ok' && r.status === 'ok' && (r.ts - validas[i - 1].ts) / 60000 <= 45) {
      o.pares++;
      const d = r.acima - validas[i - 1].acima;
      if (d > 0) o.empurrao += d;
    }
  });
  const hs = Object.keys(horas).sort();
  L.push('### Por hora do dia (horário local)', '');
  L.push('| Hora | Leituras | % no topo | Outras lojas acima (média) | Concorrentes passando na frente, por leitura |', '|---|---|---|---|---|');
  hs.forEach(h => {
    const o = horas[h];
    L.push(`| ${h}h | ${o.n} | ${Math.round(100 * o.topo / o.n)}% | ${f1(media(o.acima))} | ${o.pares ? f1(o.empurrao / o.pares) : '—'} |`);
  });
  L.push('');
  const mexem = hs.filter(h => horas[h].pares >= 2).sort((a, b) => horas[b].empurrao / horas[b].pares - horas[a].empurrao / horas[a].pares).slice(0, 3)
    .filter(h => horas[h].empurrao > 0);
  if (mexem.length) L.push(`Horas em que os concorrentes mais mexem nos anúncios: ${mexem.map(h => h + 'h').join(', ')}.`, '');

  // últimas leituras
  L.push('### Últimas 12 leituras', '', '| Quando | Posição | Outras lojas acima | Nossos na página | Obs. |', '|---|---|---|---|---|');
  rs.slice(-12).reverse().forEach(r => {
    if (r.status === 'ok') L.push(`| ${r.local.slice(5, 16)} | ${r.pos}ª | ${r.acima} | ${r.nossas} | |`);
    else if (r.status === 'fora_da_pagina') L.push(`| ${r.local.slice(5, 16)} | fora da 1ª página | ≥ ${r.total} | 0 | |`);
    else L.push(`| ${r.local.slice(5, 16)} | — | — | — | ${r.status} |`);
  });
  L.push('');
  return L;
}

function gerarResumo(csvTexto, cfg) {
  const tz = cfg.fusoHorario || 'America/Cuiaba';
  const topoLim = cfg.topoLimite !== undefined ? cfg.topoLimite : 3;
  const linhas = parseCsv(csvTexto);
  const out = ['# Posição dos anúncios — resumo', ''];
  if (!linhas.length) { out.push('Ainda não há leituras.'); return out.join('\n') + '\n'; }
  out.push(`Atualizado em ${agoraLocal(tz)} (horário local) · ${linhas.length} leituras no total.`, '');
  out.push(`Como ler: "no topo" significa que no máximo ${topoLim} anúncios de outras lojas (fora os patrocinados) aparecem acima do primeiro anúncio nosso na lista "Mais recentes".`, '');
  const nomes = [...new Set(linhas.map(l => l.lista))];
  nomes.forEach(nome => {
    const rs = linhas.filter(l => l.lista === nome).map(l => ({
      local: l.data_hora_local, ts: Date.parse(l.data_hora_utc), status: l.status || '',
      total: num(l.total_anuncios), pos: num(l.primeira_posicao), acima: num(l.acima_outras_lojas),
      nossas: num(l.nossas_na_pagina),
    })).filter(r => !Number.isNaN(r.ts)).sort((a, b) => a.ts - b.ts);
    if (rs.length) out.push(...resumoDaLista(nome, rs, topoLim));
  });
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- execução
async function main() {
  const dir = path.join(__dirname, 'dados');
  fs.mkdirSync(dir, { recursive: true });
  const csvPath = path.join(dir, 'posicoes.csv');
  if (!fs.existsSync(csvPath)) fs.writeFileSync(csvPath, CABECALHO.join(',') + '\n');

  const agora = new Date();
  const local = agoraLocal(CONFIG.fusoHorario || 'America/Cuiaba', agora);
  const utc = agora.toISOString();
  const linhas = [];

  for (const [i, lista] of CONFIG.listas.entries()) {
    if (i > 0) await sleep((CONFIG.pausaEntrePaginasSegundos || 3) * 1000);
    const r = await baixar(lista.url);
    let campos;
    if (r.erro) {
      campos = ['erro:' + r.erro, '', '', '', '', '', '', ''];
      console.log(`${lista.nome}: ERRO ${r.erro}`);
    } else {
      const d = parseListagem(r.html, CONFIG);
      if (d.total === 0) {
        campos = ['erro:nenhum_anuncio_encontrado_na_pagina', 0, '', '', '', '', '', ''];
        console.log(`${lista.nome}: ERRO nenhum anúncio encontrado (a página pode ter mudado)`);
      } else if (d.primeira === null) {
        campos = ['fora_da_pagina', d.total, '', '', '', '', 0, ''];
        console.log(`${lista.nome}: nenhum anúncio nosso entre os ${d.total} primeiros`);
      } else {
        campos = ['ok', d.total, d.primeira, d.acimaTotal, d.acimaPagos, d.acimaOutras, d.nossas, d.bloco];
        console.log(`${lista.nome}: posição ${d.primeira} · ${d.acimaOutras} de outras lojas acima · ${d.nossas} nossos na página`);
      }
    }
    // ordem das colunas: status, total, primeira, acima_total, acima_pagos, acima_outras, nossas, bloco
    linhas.push([local, utc, lista.nome, ...campos].map(csvCampo).join(','));
  }

  fs.appendFileSync(csvPath, linhas.join('\n') + '\n');
  fs.writeFileSync(path.join(__dirname, 'RESUMO.md'), gerarResumo(fs.readFileSync(csvPath, 'utf8'), CONFIG));
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { parseListagem, gerarResumo, parseCsv, agoraLocal, baixar, infoAnuncio, CABECALHO };
