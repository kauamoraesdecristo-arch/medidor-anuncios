'use strict';
/*
 * Sobe os anúncios sozinho, na nuvem do GitHub (sem o seu PC).
 * Faz login no AutoGerência, abre a lista de veículos e roda o MESMO script do painel (subir_anuncios.user.js),
 * apertando por você o botão "Subir anúncios" (colocar o ponto) ou "Tirar ponto".
 *
 * Variáveis de ambiente:
 *   AG_USUARIO, AG_SENHA   (obrigatórias; ficam nos "Secrets" do GitHub, nunca no código)
 *   AG_EMPRESA             (só se a tela de login tiver um campo extra de empresa/loja)
 *   MODO                   auto | colocar | tirar   (auto = pela hora, ver config_nuvem.json)
 *   LIMITE                 quantidade de anúncios (vazio = todos). Use 3 nos primeiros testes.
 *   SIMULAR                1 = só simula, não salva nada
 *   DIAGNOSTICO            1 = só testa o login e conta os anúncios, não mexe em nada
 *   AG_LISTA_URL           (testes) troca o endereço da lista
 *
 * IMPORTANTE: este repositório é público e os registros (logs) também. Por isso o robô escreve só
 * contagens e mensagens gerais: nunca a senha, nunca nomes ou links dos anúncios.
 */
const fs = require('fs');
const path = require('path');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config_nuvem.json'), 'utf8'));
const SCRIPT_PATH = path.join(__dirname, 'subir_anuncios.user.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ---------- hora local e modo automático ----------
function horaLocal(data, fuso) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: fuso, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(data);
  const h = +p.find(x => x.type === 'hour').value % 24, m = +p.find(x => x.type === 'minute').value;
  return { h, m, txt: String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') };
}
// config_nuvem.json -> "agenda": [["00:00","colocar"],["09:00","tirar"],...] : vale a última faixa que já começou
function modoPorHorario(data, cfg = CONFIG) {
  const { h, m } = horaLocal(data, cfg.fusoHorario || 'America/Cuiaba');
  const agora = h * 60 + m;
  let modo = null;
  for (const [hhmm, md] of cfg.agenda) {
    const [a, b] = hhmm.split(':').map(Number);
    if (a * 60 + b <= agora) modo = md;
  }
  return modo || cfg.agenda[0][1];
}

// ---------- login ----------
const SEL_CAPTCHA = 'iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i], iframe[src*="captcha" i], .g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], input[name*="captcha" i], input[id*="captcha" i], img[src*="captcha" i], img[id*="captcha" i]';

async function descreverTela(page) {
  // só descreve a ESTRUTURA da página (tipos e nomes dos campos), nunca valores digitados
  return page.evaluate(sel => {
    const vis = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
    const campos = [...document.querySelectorAll('input,select,textarea')].filter(vis).map(e => ({
      tag: e.tagName.toLowerCase(), tipo: e.type || '', id: e.id || '', nome: e.name || '', dica: e.placeholder || '' }));
    const botoes = [...document.querySelectorAll('button,input[type=submit],input[type=button],input[type=image],a.btn')].filter(vis)
      .map(e => (e.value || e.textContent || e.alt || '').trim().slice(0, 30)).filter(Boolean);
    return { titulo: document.title.slice(0, 80), caminho: location.pathname, campos, botoes: botoes.slice(0, 12), captcha: !!document.querySelector(sel) };
  }, SEL_CAPTCHA);
}
function mostrarTela(t) {
  log(`  Página: "${t.titulo}" (${t.caminho})`);
  log(`  Campos visíveis: ${t.campos.length ? t.campos.map(c => `${c.tag}[${c.tipo}] id=${c.id || '-'} nome=${c.nome || '-'} dica=${c.dica || '-'}`).join(' | ') : 'nenhum'}`);
  log(`  Botões: ${t.botoes.join(' | ') || 'nenhum'}`);
  log(`  Proteção "não sou um robô" na página: ${t.captcha ? 'SIM' : 'não'}`);
}
const temLista = page => page.evaluate(() => [...document.querySelectorAll('a[href]')].some(a => /DetalheVeiculo/i.test(a.href) && /guid=/i.test(a.href)));
const temSenha = page => page.evaluate(() => [...document.querySelectorAll('input[type=password]')].some(e => e.offsetWidth || e.offsetHeight || e.getClientRects().length));

async function entrar(page, listaUrl, usuario, senha, empresa, diagnostico) {
  await page.goto(listaUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  if (await temLista(page)) { log('Já estava logado.'); return true; }
  if (!(await temSenha(page))) {
    log('✖ Não achei a tela de login nem a lista de veículos. O site pode ter mudado ou bloqueado o acesso.');
    mostrarTela(await descreverTela(page));
    return false;
  }
  const tela = await descreverTela(page);
  if (diagnostico) { log('Tela de login encontrada:'); mostrarTela(tela); }
  if (tela.captcha) {
    log('✖ A tela de login tem proteção "não sou um robô" (captcha). Não dá para entrar automaticamente.');
    if (!diagnostico) mostrarTela(tela);
    return false;
  }
  // preenche: campo de empresa (se houver), usuário e senha
  const textos = await page.$$('input:not([type=password]):not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=image])');
  const visiveis = [];
  for (const el of textos) if (await el.isVisible()) visiveis.push(el);
  let usuarioPreenchido = false;
  for (const el of visiveis) {
    const dica = await el.evaluate(e => (e.id + ' ' + e.name + ' ' + (e.placeholder || '')).toLowerCase());
    if (/empresa|loja|cnpj|codigo|código/.test(dica) && empresa) await el.fill(empresa);
    else if (!usuarioPreenchido) { await el.fill(usuario); usuarioPreenchido = true; }
  }
  if (!usuarioPreenchido) { log('✖ Não achei o campo de usuário na tela de login.'); mostrarTela(tela); return false; }
  const campoSenha = (await page.$$('input[type=password]'))[0];
  await campoSenha.fill(senha);
  const botao = await page.evaluateHandle(() => {
    const vis = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
    const bs = [...document.querySelectorAll('button,input[type=submit],input[type=button],input[type=image],a.btn')].filter(vis);
    return bs.find(b => /entrar|login|acessar|acesso|ok|enviar|confirmar/i.test(b.value || b.textContent || b.alt || '')) || bs.find(b => b.type === 'submit') || null;
  });
  const el = botao.asElement();
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {}),
    el ? el.click() : campoSenha.press('Enter'),
  ]);
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  // guarda a mensagem do site (ex.: "senha inválida") ANTES de recarregar a lista
  const msg = await page.evaluate(() => {
    const e = [...document.querySelectorAll('[class*=erro i],[class*=error i],[class*=alert i],[id*=msg i],[id*=erro i],[class*=invalid i]')]
      .map(x => (x.textContent || '').replace(/\s+/g, ' ').trim()).find(t => t && t.length < 140);
    return e || '';
  });
  // confere se entrou: vai para a lista
  await page.goto(listaUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  for (let i = 0; i < 40; i++) { if (await temLista(page)) break; await sleep(1500); }
  if (await temLista(page)) { log('Login feito.'); return true; }
  log('✖ O login não funcionou. Possíveis causas: usuário ou senha errados nos Secrets, código de verificação (SMS/e-mail), ou o site bloqueou o acesso vindo do GitHub.');
  if (msg) log(`  Mensagem do site: "${msg}"`);
  mostrarTela(await descreverTela(page));
  return false;
}

// ---------- execução ----------
async function main() {
  const usuario = process.env.AG_USUARIO || '', senha = process.env.AG_SENHA || '', empresa = process.env.AG_EMPRESA || '';
  const diagnostico = process.env.DIAGNOSTICO === '1' || /^true$/i.test(process.env.DIAGNOSTICO || '');
  const simular = process.env.SIMULAR === '1' || /^true$/i.test(process.env.SIMULAR || '');
  const limite = parseInt(process.env.LIMITE || '', 10) || 0;
  let modo = (process.env.MODO || 'auto').toLowerCase();
  if (!usuario || !senha) {
    log('✖ Faltam os Secrets AG_USUARIO e/ou AG_SENHA (Settings → Secrets and variables → Actions).');
    return 1;
  }
  const agora = new Date();
  const hl = horaLocal(agora, CONFIG.fusoHorario || 'America/Cuiaba');
  if (modo === 'auto') modo = modoPorHorario(agora);
  if (modo !== 'colocar' && modo !== 'tirar') { log('✖ MODO inválido: use auto, colocar ou tirar.'); return 1; }
  log(`Hora local ${hl.txt} · ${diagnostico ? 'DIAGNÓSTICO (não altera nada)' : `modo ${modo.toUpperCase()}${simular ? ' (simulação)' : ''}${limite ? ` · limite ${limite}` : ''}`}`);

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ args: ['--no-sandbox'], executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext({ locale: 'pt-BR', timezoneId: CONFIG.fusoHorario || 'America/Cuiaba', viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const avisos = [];
  page.on('dialog', async d => { avisos.push(d.message().split('\n')[0].slice(0, 160)); await d.accept(); });
  let codigo = 0;
  try {
    const listaUrl = process.env.AG_LISTA_URL || CONFIG.listaUrl;
    if (!(await entrar(page, listaUrl, usuario, senha, empresa, diagnostico))) return 1;
    // espera a lista completa carregar
    let n = 0;
    for (let i = 0; i < 40; i++) { n = await page.evaluate(() => new Set([...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => /DetalheVeiculo/i.test(h) && /guid=/i.test(h))).size); if (n) break; await sleep(1500); }
    log(`Anúncios encontrados na lista: ${n}`);
    if (!n) { log('✖ A lista veio vazia.'); return 1; }
    if (diagnostico) { log('Diagnóstico concluído: login OK e lista lida. Nada foi alterado.'); return 0; }

    // roda o mesmo script do painel
    const codigoScript = fs.readFileSync(SCRIPT_PATH, 'utf8');
    await page.evaluate(codigoScript);
    await page.waitForFunction(() => [...document.body.children].some(e => e.shadowRoot && e.shadowRoot.getElementById('colocar')), null, { timeout: 30000 });
    const opcoes = { cConc: CONFIG.concorrencia, cOrdem: CONFIG.ordem || 'lista', cPalavras: CONFIG.palavras || '', cRetent: CONFIG.tentativas, ...(limite ? { limite } : {}) };
    await page.evaluate(({ o, simular }) => {
      const sh = [...document.body.children].find(e => e.shadowRoot && e.shadowRoot.getElementById('colocar')).shadowRoot;
      for (const [id, v] of Object.entries(o)) { const el = sh.getElementById(id); if (el && v !== undefined && v !== '') { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); } }
      const s = sh.getElementById('simular'); if (s) { s.checked = !!simular; s.dispatchEvent(new Event('change', { bubbles: true })); }
    }, { o: opcoes, simular });
    await page.evaluate(m => {
      const sh = [...document.body.children].find(e => e.shadowRoot && e.shadowRoot.getElementById('colocar')).shadowRoot;
      sh.getElementById(m === 'colocar' ? 'colocar' : 'tirar').click();
    }, modo);

    const maxMs = (CONFIG.tempoMaximoMin || 50) * 60000, t0 = Date.now();
    let ultimoLog = 0, r = null;
    while (Date.now() - t0 < maxMs) {
      await sleep(5000);
      r = await page.evaluate(() => window.__subirResumo && window.__subirResumo());
      if (r && r.concluido) break;
      if (Date.now() - ultimoLog > 60000 && r) { ultimoLog = Date.now(); log(`  andamento: ${r.feitos} de ${r.total}`); }
    }
    if (!r || !r.concluido) {
      log('✖ Passou do tempo máximo. Parando.');
      await page.evaluate(() => { const sh = [...document.body.children].find(e => e.shadowRoot && e.shadowRoot.getElementById('parar')).shadowRoot; sh.getElementById('parar').click(); });
      await sleep(15000);
      r = await page.evaluate(() => window.__subirResumo()).catch(() => r);
      codigo = 1;
    }
    if (avisos.length) log(`Aviso do script: ${avisos[0]}`);
    if (r) {
      log(`Resultado (${modo}): ${r.ok} alterados · ${r.pulado} já estavam certos · ${r.faltaDados} sem dados obrigatórios (preencher à mão no AutoGerência) · ${r.erro} com erro`);
      if (r.erro > 0 || r.parou) codigo = 1;
      if (r.ok + r.pulado + r.faltaDados + r.erro === 0) { log('✖ Nenhum anúncio foi processado.'); codigo = 1; }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return codigo;
}

module.exports = { modoPorHorario, horaLocal };
if (require.main === module) {
  main().then(c => process.exit(c), e => { console.error('Falha inesperada:', String(e && e.message || e).split('\n')[0]); process.exit(1); });
}
