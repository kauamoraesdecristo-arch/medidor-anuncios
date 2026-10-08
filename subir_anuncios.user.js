// ==UserScript==
// @name         Subir Anúncios - AutoGerência
// @namespace    subir-anuncios
// @version      2.5
// @description  Sobe os anúncios com um clique: coloca (manhã) ou tira (tarde) o ponto da descrição de todos os veículos
// @match        https://www.autogerencia.com.br/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';
  if (window.top !== window.self) return;

  // ====================== CONFIGURAÇÃO ======================
  const CFG = {
    CONCORRENCIA: 3,          // anúncios processados ao mesmo tempo (use 1 se aparecerem muitos erros)
    ESPERA_MIN_CARREGAR: 1500, // espera mínima depois que a página abre (ms)
    ESTAVEL_MS: 2500,         // tempo que a página precisa ficar "parada" para considerar carregada (ms)
    TIMEOUT_CARREGAR: 30000,  // tempo máximo para abrir um anúncio (ms)
    RETENTATIVAS: 1,          // quantas vezes refazer os anúncios que deram erro
    VERIFICAR: true,          // reabre o anúncio depois de salvar para confirmar que gravou
    RETENTATIVAS_CONTINUO: 5, // no modo contínuo: quantas rodadas refazendo os que deram erro antes de desistir
    PAUSA_RETENTATIVA: 20000, // no modo contínuo: pausa entre as rodadas de nova tentativa (ms)
    MARGEM_FIM: 5 * 60000,    // no modo contínuo: folga de segurança antes do prazo final (ms)
    BOTOES_SALVAR: [/^\s*Salvar\s*$/i, /Salvar\s*\/\s*Finalizar/i], // botões tentados, em ordem
    ORDEM: 'lista',           // ordem de processamento: lista | inversa | preco | cliques | palavras (o ÚLTIMO processado fica no topo do site)
    PALAVRAS: '',             // para ORDEM 'palavras': termos separados por vírgula (o primeiro tem mais prioridade)
  };
  // ==========================================================
  // Todas estas opções também ficam no painel (aba Configurações) e são lembradas pelo navegador.
  const PADRAO = { ...CFG };
  const BOT = PADRAO.BOTOES_SALVAR;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // com muitos anúncios em paralelo o site/navegador ficam mais lentos: os tempos máximos de espera crescem junto (até 8x)
  const fator = () => Math.min(8, Math.max(1, CFG.CONCORRENCIA / 3));
  const txt = e => (e.value || e.textContent || '').trim();
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const temPonto = t => /^\s*\.\s*(\r?\n|$)/.test(t);
  const fmt = seg => {
    seg = Math.max(0, Math.round(seg));
    return seg >= 60 ? `${Math.floor(seg / 60)} min ${seg % 60} s` : `${seg} s`;
  };
  const esperar = async (fn, ms = 20000, passo = 250) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      try { const v = fn(); if (v) return v; } catch (e) { /* tenta de novo */ }
      await sleep(passo);
    }
    return null;
  };

  // ---------- leitura da página do anúncio ----------
  const carregar = url => new Promise((res, rej) => {
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:900px;opacity:0;pointer-events:none;z-index:-1;border:0';
    const t = setTimeout(() => { f.remove(); rej(new Error('demorou demais para abrir')); }, CFG.TIMEOUT_CARREGAR * fator());
    f.onload = () => { clearTimeout(t); res(f); };
    f.src = url;
    document.body.appendChild(f);
  });

  // campo da descrição: prefere o "Observações" visível; ignora campos escondidos
  const acharDescricao = doc => {
    const todas = [...doc.querySelectorAll('textarea')].filter(t => t.value.trim().length > 0);
    const visiveis = todas.filter(t => t.offsetParent !== null);
    const areas = visiveis.length ? visiveis : todas;
    return areas.find(t => /observ/i.test(t.id + t.name)) ||
           areas.find(t => /descri/i.test(t.id + t.name + (t.placeholder || ''))) ||
           [...areas].sort((a, b) => b.value.length - a.value.length)[0];
  };

  const rotulo = (doc, e) => {
    const l = e.id && doc.querySelector(`label[for="${e.id}"]`);
    return ((l && l.textContent) || e.id || e.name || e.tagName).replace(/\*/g, '').trim();
  };
  // campos obrigatórios VISÍVEIS (atributo required ou rótulo com asterisco)
  const obrigatorios = doc => {
    const lista = [...doc.querySelectorAll('[required],[aria-required="true"],.required,.obrigatorio')];
    doc.querySelectorAll('label').forEach(l => {
      if (/\*/.test(l.textContent) && l.htmlFor) { const e = doc.getElementById(l.htmlFor); if (e) lista.push(e); }
    });
    return [...new Set(lista)].filter(e => /^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName) &&
      e.type !== 'hidden' && !e.disabled && e.offsetParent !== null);
  };
  const vazio = e => e.tagName === 'SELECT'
    ? (e.selectedIndex <= 0 && !e.value)
    : !String(e.value || '').trim();

  const nomeAnuncio = doc => [...doc.querySelectorAll('select')].slice(0, 3)
    .map(x => ((x.selectedOptions[0] || {}).text || '').trim()).filter(Boolean).join(' ') || '';
  const assinatura = doc => [...doc.querySelectorAll('input,select,textarea')]
    .map(e => (e.tagName === 'SELECT' ? e.selectedIndex + ':' + e.options.length : e.value)).join('|');
  const pendente = win => { try { return !!(win.jQuery && win.jQuery.active > 0); } catch (e) { return false; } };

  // espera a página "assentar": nada mudando e sem requisições em andamento
  const esperarCarregar = async (doc, win) => {
    await sleep(CFG.ESPERA_MIN_CARREGAR);
    let ultima = assinatura(doc), desde = Date.now();
    const inicio = Date.now();
    while (Date.now() - inicio < 40000 * fator()) {
      await sleep(400);
      const atual = assinatura(doc);
      if (atual !== ultima || pendente(win)) { ultima = atual; desde = Date.now(); continue; }
      if (Date.now() - desde >= CFG.ESTAVEL_MS) return true;
    }
    return false;
  };

  const acharBotao = doc => {
    const bs = [...doc.querySelectorAll('button,input[type=submit],input[type=button],a.btn')];
    for (const re of CFG.BOTOES_SALVAR) { const b = bs.find(x => re.test(txt(x))); if (b) return b; }
    return null;
  };

  // depois de clicar em Salvar: confirma pergunta (se aparecer) e espera o site terminar
  const esperarSalvar = async (doc, win, jaVisiveis) => {
    const inicio = Date.now();
    let confirmou = false;
    await sleep(1200);
    while (Date.now() - inicio < 15000 * fator()) {
      try {
        if (!confirmou) {
          const c = [...doc.querySelectorAll('button,input[type=button],input[type=submit],a.btn')]
            .find(b => /^\s*Confirmar\s*$/i.test(txt(b)) && b.offsetParent && !jaVisiveis.has(b));
          if (c) { c.click(); confirmou = true; await sleep(1000); continue; }
        }
        if (!pendente(win) && Date.now() - inicio > 2000) break;
      } catch (e) { break; }
      await sleep(400);
    }
    await sleep(500);
  };
  const mensagensDoSite = doc => {
    try {
      return [...doc.querySelectorAll('.swal2-popup,.toast,.alert,.noty_body,.invalid-feedback,.text-danger,[role=alert]')]
        .filter(e => e.offsetParent && e.textContent.trim()).map(e => e.textContent.trim().slice(0, 120));
    } catch (e) { return []; }
  };

  // ---------- processa UM anúncio ----------
  async function processar(url, modo, simular) {
    let f = null, nome = '';
    const R = (status, extra = {}) => ({ status, nome, url, ...extra });
    try {
      f = await carregar(url);
      const doc = f.contentDocument, win = f.contentWindow;
      if (!await esperar(() => acharDescricao(doc), 25000 * fator())) return R('erro', { motivo: 'a descrição não carregou' });
      if (!await esperarCarregar(doc, win)) return R('erro', { motivo: 'a página não terminou de carregar' });
      nome = nomeAnuncio(doc);

      const ta = acharDescricao(doc);
      if (!ta) return R('erro', { motivo: 'campo da descrição não encontrado' });
      const tem = temPonto(ta.value);
      if (modo === 'colocar' ? tem : !tem) return R('pulado');

      // campos obrigatórios vazios: o site não deixa salvar. Dá uma segunda chance antes de desistir.
      let vazios = obrigatorios(doc).filter(vazio);
      if (vazios.length) { await sleep(3000); vazios = obrigatorios(doc).filter(vazio); }
      if (vazios.length) return R('faltaDados', { campos: vazios.map(e => rotulo(doc, e)) });

      const btn = acharBotao(doc);
      if (!btn) return R('erro', { motivo: 'botão Salvar não encontrado' });
      if (simular) return R('ok', { simulado: true });

      const novo = modo === 'colocar' ? '.\n' + ta.value : ta.value.replace(/^\s*\.\s*(\r?\n)?/, '');
      const avisos = [];
      win.alert = m => { avisos.push(String(m)); };
      win.confirm = () => true;
      const jaVisiveis = new Set([...doc.querySelectorAll('button,input[type=button],input[type=submit],a.btn')]
        .filter(b => b.offsetParent));

      Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value').set.call(ta, novo);
      ['input', 'keyup', 'change'].forEach(n => ta.dispatchEvent(new win.Event(n, { bubbles: true })));
      btn.click();
      await esperarSalvar(doc, win, jaVisiveis);
      const msgs = avisos.concat(mensagensDoSite(doc));

      if (CFG.VERIFICAR) {
        f.remove(); f = null;
        f = await carregar(url);
        const t2 = await esperar(() => acharDescricao(f.contentDocument), 25000 * fator());
        if (!t2 || temPonto(t2.value) !== (modo === 'colocar'))
          return R('erro', { motivo: 'o site não gravou' + (msgs.length ? ' (' + msgs.join(' / ') + ')' : '') });
      }
      return R('ok');
    } catch (e) {
      return R('erro', { motivo: (e && e.message) || 'erro inesperado' });
    } finally {
      if (f) f.remove();
    }
  }

  // ---------- lista de anúncios da tela ----------
  const listarUrls = () => [...new Set(
    [...document.querySelectorAll('a[href]')].map(a => a.href)
      .filter(h => /DetalheVeiculo/i.test(h) && /guid=/i.test(h))
      .map(h => h.replace(/DetalheVeiculo\w*\.aspx/i, 'manterveiculocompact.aspx'))
  )];
  // ---------- ordem de processamento ----------
  // No site público a lista "Mais recentes" vem pela última edição: quem é salvo POR ÚLTIMO fica no topo.
  // Então os anúncios que você quer em destaque precisam ser os últimos da fila.
  const semAcento = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const lerPreco = t => {
    const m = /R\$\s*([\d.]+(?:,\d{1,2})?)/.exec(t || '');
    return m ? parseFloat(m[1].replace(/\./g, '').replace(',', '.')) : null;
  };
  const colunaCliques = () => {
    const th = [...document.querySelectorAll('th')].find(h => /clique|visita|visualiza|acesso/i.test(h.textContent || ''));
    return th ? th.cellIndex : -1;
  };
  // cada anúncio da tela, na ordem da lista, com o texto da linha (para preço, cliques e palavras)
  const listarItens = () => {
    const col = colunaCliques();
    const vistos = new Set(), itens = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const h = a.href;
      if (!(/DetalheVeiculo/i.test(h) && /guid=/i.test(h))) continue;
      const url = h.replace(/DetalheVeiculo\w*\.aspx/i, 'manterveiculocompact.aspx');
      if (vistos.has(url)) continue;
      vistos.add(url);
      const tr = a.closest ? a.closest('tr') : null;
      const texto = (tr ? tr.textContent : a.textContent || '').replace(/\s+/g, ' ').trim();
      let cliques = null;
      if (tr && col >= 0 && tr.cells && tr.cells[col]) {
        const n = parseInt((tr.cells[col].textContent || '').replace(/\D/g, ''), 10);
        if (Number.isFinite(n)) cliques = n;
      }
      itens.push({ url, texto, preco: lerPreco(texto), cliques, i: itens.length });
    }
    return itens;
  };
  const termosOrdem = () => String(CFG.PALAVRAS || '').split(',').map(semAcento).map(t => t.trim()).filter(Boolean);
  // devolve { urls na ordem de processamento, aviso }
  const ordenar = itens => {
    const o = CFG.ORDEM, base = itens.slice();
    let aviso = '';
    const asc = (f, vazio) => base.sort((a, b) => ((f(a) === null ? vazio : f(a)) - (f(b) === null ? vazio : f(b))) || a.i - b.i);
    if (o === 'inversa') base.reverse();
    else if (o === 'preco') {
      if (!base.some(x => x.preco !== null)) aviso = 'Não consegui ler o preço na tabela: mantive a ordem da lista.';
      else asc(x => x.preco, -1);                       // mais caros por último = no topo
    } else if (o === 'cliques') {
      if (!base.some(x => x.cliques !== null)) aviso = 'Não achei a coluna de cliques na tabela: mantive a ordem da lista.';
      else asc(x => x.cliques, -1);
    } else if (o === 'palavras') {
      const t = termosOrdem();
      if (!t.length) aviso = 'Nenhuma palavra informada: mantive a ordem da lista.';
      else {
        const prio = x => { const tx = semAcento(x.texto); const k = t.findIndex(w => tx.includes(w)); return k < 0 ? t.length : k; };
        const n = base.filter(x => prio(x) < t.length).length;
        if (!n) aviso = 'Nenhum anúncio da tela contém essas palavras: mantive a ordem da lista.';
        else { base.forEach(x => { x.p = prio(x); }); base.sort((a, b) => (b.p - a.p) || a.i - b.i); }   // prioridade 0 por último
        if (n) aviso = `${n} anúncio(s) contêm essas palavras e ficarão no topo.`;
      }
    }
    return { urls: base.map(x => x.url), aviso };
  };
  const ROTULO_ORDEM = { lista: 'ordem da lista', inversa: 'ordem inversa', preco: 'mais caros no topo', cliques: 'mais cliques no topo', palavras: 'palavras de destaque no topo' };
  // pega os anúncios da tela (limite ANTES de ordenar) já na ordem em que serão processados
  const planejar = lim => {
    let itens = listarItens();
    if (lim > 0) itens = itens.slice(0, lim);
    return ordenar(itens);
  };
  // coloca a tabela para mostrar todos os registros
  const mostrarTodos = async () => {
    try {
      const sel = document.querySelector('select[name$="_length"]');
      if (!sel) return;
      const opt = [...sel.options].find(o => o.value === '-1') ||
        [...sel.options].sort((a, b) => (+b.value) - (+a.value))[0];
      if (!opt || sel.value === opt.value) return;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(2500);
    } catch (e) { /* segue com o que tem */ }
  };
  const totalDaTabela = () => {
    const el = document.querySelector('.dataTables_info');
    if (!el) return null;
    const n = [...el.textContent.matchAll(/[\d.]+/g)].map(m => parseInt(m[0].replace(/\./g, ''), 10));
    return n.length >= 3 ? n[2] : null;
  };

  // ---------- execução em paralelo ----------
  let rodando = false, parar = false;
  const estado = { total: 0, inicio: 0, resultados: [], modo: '', simular: false, continuo: false, ciclo: 1, historico: [], motivo: '', inicioGeral: 0, fimTs: 0, fimTxt: '', finalizando: false, encerradoOk: false, feed: [], prazoTs: 0, atrasou: false, sOk: 0, nOk: 0, calcGatilho: null };
  // tempo real gasto por anúncio alterado (usado para calcular quando começar a fase final)
  const medir = (r, ms) => { if (r && r.status === 'ok' && !r.simulado) { estado.sOk += ms; estado.nOk++; } };
  const contagem = res => {
    const c = { ok: 0, pulado: 0, faltaDados: 0, erro: 0 };
    res.forEach(r => { if (r) c[r.status]++; });
    return c;
  };

  const esperarInterrompivel = async ms => { const t = Date.now(); while (!parar && Date.now() - t < ms) await sleep(500); };

  async function executar(modo, urls, simular, opt = {}) {
    const retent = opt.retent !== undefined ? opt.retent : CFG.RETENTATIVAS;
    const res = estado.resultados = new Array(urls.length);
    let prox = 0;
    const trabalhador = async () => {
      while (!parar && !(opt.abortar && opt.abortar())) {
        const i = prox++;
        if (i >= urls.length) return;
        const t0 = Date.now();
        res[i] = await processar(urls[i], modo, simular);
        medir(res[i], Date.now() - t0);
        empurrar(res[i], modo);
        atualizar();
        await sleep(200);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CFG.CONCORRENCIA, urls.length) }, trabalhador));

    for (let t = 0; t < retent && !parar; t++) {
      if (opt.abortar && opt.abortar()) break;
      const idx = res.map((r, i) => (r && r.status === 'erro' ? i : -1)).filter(i => i >= 0);
      if (!idx.length) break;
      if (opt.pausa) {
        ui.status.textContent = `${idx.length} anúncio(s) com erro · nova tentativa em ${fmt(opt.pausa / 1000)} (rodada ${t + 1}/${retent})...`;
        await esperarInterrompivel(opt.pausa);
        if (parar) break;
      }
      ui.status.textContent = `Refazendo ${idx.length} anúncio(s) que deram erro...`;
      for (const i of idx) {
        if (parar) break;
        const t0 = Date.now();
        res[i] = await processar(urls[i], modo, simular);
        medir(res[i], Date.now() - t0);
        empurrar(res[i], modo);
        atualizar();
      }
    }
    return res.filter(Boolean);
  }

  // ---------- painel (Shadow DOM, não sofre interferência do CSS do site) ----------
  const ui = {};
  const CSS = `
    :host{all:initial;
      --card:#2b2f36;--card2:#353a43;--borda:#444a55;--borda2:#5a6270;--txt:#e8ecf2;--txt2:#aeb7c5;--txt3:#8893a6;--tit:#ffffff;
      --trilho:#434954;--cabg:linear-gradient(135deg,#1b2233,#27344f);--sombra:0 14px 44px rgba(0,0,0,.55),0 2px 6px rgba(0,0,0,.4);
      --kok:#34d399;--kcertos:#60a5fa;--kfalta:#fbbf24;--kerro:#f87171;
      --btnsbg:#353a43;--btnshv:#3f4551;--btnlbg:#3a404b;--btnlhv:#454c59;--btnc:#2f5fc4;--btnchv:#3a6fd8;
      --campo:#23272e;--link:#7db7ff;--rodape:#262a31;--histb:#3b5ea8;
      --vbg:#12372d;--vtx:#8ae6c4;--vbd:#1f5c4a;--ybg:#3d3216;--ytx:#f3d27a;--ybd:#5f4d1d;--ovbg:rgba(0,0,0,.6)}
    :host([data-tema="claro"]){
      --card:#ffffff;--card2:#f4f7fc;--borda:#e6ecf5;--borda2:#cfd8e8;--txt:#1f2a44;--txt2:#5b6b8a;--txt3:#8a97b2;--tit:#0b2a6f;
      --trilho:#e8edf5;--cabg:linear-gradient(135deg,#0b2a6f,#1a4fb3);--sombra:0 14px 44px rgba(11,42,111,.30),0 2px 6px rgba(0,0,0,.12);
      --kok:#0f9d7a;--kcertos:#2563eb;--kfalta:#d97706;--kerro:#dc2626;
      --btnsbg:#ffffff;--btnshv:#f4f7fc;--btnlbg:#eef2fa;--btnlhv:#e1e8f6;--btnc:#0b2a6f;--btnchv:#123c94;
      --campo:#ffffff;--link:#1d6fb8;--rodape:#fafbfe;--histb:#cfe0ff;
      --vbg:#e7f8f1;--vtx:#0b6b53;--vbd:#bfe9d9;--ybg:#fff6e0;--ytx:#8a5a00;--ybd:#f6dd9b;--ovbg:rgba(10,20,50,.55)}
    *{box-sizing:border-box;font-family:"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif}
    button{font-family:inherit}
    .box{width:392px;background:var(--card);border-radius:16px;box-shadow:var(--sombra);overflow:hidden;color:var(--txt);font-size:13px}
    .cab{display:flex;align-items:center;gap:10px;padding:12px 14px;background:var(--cabg);color:#fff;cursor:move;user-select:none}
    .logo{width:34px;height:34px;border-radius:10px;background:rgba(255,255,255,.16);display:grid;place-items:center;font-size:18px;flex:none}
    .tit{flex:1;min-width:0}.tit b{display:block;font-size:14px;letter-spacing:.2px}.tit span{font-size:11px;opacity:.8}
    .chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:700;background:rgba(255,255,255,.18);color:#fff;white-space:nowrap}
    .chip i{width:8px;height:8px;border-radius:50%;background:#cbd5e1;display:inline-block}
    .chip.rodando i{background:#34d399;animation:pulso 1.2s infinite}
    .chip.ok i{background:#34d399}.chip.alerta i{background:#fbbf24}.chip.erro i,.chip.parado i{background:#f87171}
    @keyframes pulso{0%{box-shadow:0 0 0 0 rgba(52,211,153,.7)}100%{box-shadow:0 0 0 8px rgba(52,211,153,0)}}
    .ib{background:rgba(255,255,255,.16);border:0;color:#fff;width:28px;height:28px;border-radius:8px;cursor:pointer;font-size:15px;line-height:1;padding:0;flex:none}
    .ib:hover{background:rgba(255,255,255,.3)}
    .pm{display:none;font-weight:800;font-size:12px}
    .mini .corpo{display:none}.mini .pm{display:inline}
    .corpo{padding:14px}
    .st{font-size:15px;font-weight:700;color:var(--tit);line-height:1.3}
    .fase{font-size:12px;color:var(--txt2);margin-top:2px;min-height:16px}
    .prog{display:flex;align-items:center;gap:10px;margin:12px 0 4px}
    .barra{flex:1;height:10px;background:var(--trilho);border-radius:999px;overflow:hidden}
    #prog{height:100%;width:0;background:linear-gradient(90deg,#14b8a6,#2dd4bf);border-radius:999px;transition:width .4s ease}
    .pct{font-weight:800;color:var(--tit);min-width:40px;text-align:right}
    .eta{font-size:11.5px;color:var(--txt3);min-height:15px;margin-bottom:10px}
    .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
    .kpi{border-radius:12px;padding:9px 4px;text-align:center;background:var(--card2);border:1px solid var(--borda)}
    .kpi b{display:block;font-size:20px;line-height:1.15}
    .kpi span{font-size:10.5px;color:var(--txt2)}
    .kpi.ok b{color:var(--kok)}.kpi.certos b{color:var(--kcertos)}.kpi.falta b{color:var(--kfalta)}.kpi.erro b{color:var(--kerro)}
    .acoes{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .btn{border:0;border-radius:10px;padding:10px 12px;font-weight:700;font-size:13px;cursor:pointer;transition:transform .05s,box-shadow .15s,background .15s}
    .btn:active{transform:translateY(1px)}
    .btn:disabled{opacity:.5;cursor:not-allowed}
    .btn.p{background:linear-gradient(135deg,#14b8a6,#0f9d8a);color:#fff;box-shadow:0 4px 12px rgba(20,184,166,.35)}
    .btn.p:hover{filter:brightness(1.05)}
    .btn.s{background:var(--btnsbg);color:var(--tit);border:1.5px solid var(--borda2)}.btn.s:hover{background:var(--btnshv)}
    .btn.c{background:var(--btnc);color:#fff}.btn.c:hover{background:var(--btnchv)}
    .btn.a{background:#f59e0b;color:#fff}.btn.a:hover{background:#d98a06}
    .btn.d{background:#dc2626;color:#fff}.btn.d:hover{background:#b91c1c}
    .btn.l{background:var(--btnlbg);color:var(--tit)}.btn.l:hover{background:var(--btnlhv)}
    #cont,#enc,#parar,#rel{grid-column:1/-1}
    details{margin-top:12px;border-top:1px solid var(--borda);padding-top:8px}
    summary{cursor:pointer;font-weight:700;color:var(--tit);font-size:12.5px;list-style:none;display:flex;align-items:center;gap:6px}
    summary::-webkit-details-marker{display:none}
    summary::after{content:"▾";margin-left:auto;color:var(--txt3)}
    details[open] summary::after{content:"▴"}
    .cfg label{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 0;border-bottom:1px dashed var(--borda);color:var(--txt)}
    .cfg label:last-child{border-bottom:0}
    .cfg input[type=number],.cfg input[type=time],.cfg input[type=text]{border:1.5px solid var(--borda2);border-radius:8px;padding:5px 8px;width:96px;font-size:12.5px;color:var(--txt);background:var(--campo);color-scheme:inherit}
    .cfg input[type=checkbox]{width:17px;height:17px;accent-color:#14b8a6}
    .cfg small{display:block;color:var(--txt3);font-size:11px}
    .cfg input[type=text]{width:170px}
    .cfg select{border:1.5px solid var(--borda2);border-radius:8px;padding:5px 8px;font-size:12.5px;color:var(--txt);background:var(--campo);max-width:170px}
    .cfgb{max-height:320px;overflow:auto;padding-right:6px}
    .gr{font-size:10.5px;text-transform:uppercase;letter-spacing:.7px;color:var(--txt3);font-weight:700;margin:12px 0 2px}
    .cfgb .btn{width:100%;margin-top:10px}
    .feed{margin-top:4px;max-height:170px;overflow:auto}
    .it{display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-bottom:1px solid var(--borda);font-size:12px}
    .it:last-child{border-bottom:0}
    .it b{font-weight:600}.it .t{color:var(--txt2)}
    .it small{margin-left:auto;color:var(--txt3);white-space:nowrap;font-size:11px}
    .ic{width:18px;height:18px;border-radius:50%;display:grid;place-items:center;font-size:10px;color:#fff;flex:none;margin-top:1px;font-weight:800}
    .ic.ok{background:#0f9d7a}.ic.certo{background:#2563eb}.ic.falta{background:#d97706}.ic.erro{background:#dc2626}
    .vazio{color:var(--txt3);font-size:12px;padding:6px 0}
    .rod{margin-top:10px;text-align:center;font-size:10.5px;color:var(--txt3)}
    .ov{position:fixed;inset:0;background:var(--ovbg);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:5}
    .dlg{background:var(--card);border-radius:18px;width:min(780px,94vw);max-height:88vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.4);color:var(--txt);font-size:13px}
    .dh{display:flex;align-items:center;gap:12px;padding:16px 20px;background:var(--cabg);color:#fff}
    .dh div{flex:1}.dh h3{margin:0;font-size:18px}.dh span{font-size:12px;opacity:.85}
    .db{padding:18px 20px;overflow:auto}
    .df{display:flex;gap:8px;justify-content:flex-end;padding:12px 20px;border-top:1px solid var(--borda);background:var(--rodape)}
    .ban{margin:0 0 14px;padding:10px 14px;border-radius:10px;font-weight:600;line-height:1.4}
    .ban.v{background:var(--vbg);color:var(--vtx);border:1px solid var(--vbd)}.ban.y{background:var(--ybg);color:var(--ytx);border:1px solid var(--ybd)}
    .db .kpis{margin-bottom:14px}.db .kpi b{font-size:26px}
    .db h4{margin:18px 0 8px;font-size:13px;color:var(--tit)}
    .hist{margin:0;padding:0;list-style:none}.hist li{padding:6px 0 6px 14px;border-left:3px solid var(--histb);margin-left:4px;color:var(--txt)}
    table{width:100%;border-collapse:collapse;font-size:12.5px}
    th{text-align:left;color:var(--txt2);font-weight:600;padding:6px 8px;border-bottom:2px solid var(--borda)}
    td{padding:7px 8px;border-bottom:1px solid var(--borda);vertical-align:top;color:var(--txt)}
    td a{color:var(--link);text-decoration:none;font-weight:600}
    .meta{color:var(--txt2);margin:-4px 0 10px}
  `;
  // Todas as opções ajustáveis. 'cfg' = nome no CFG; 'mult' converte segundos em ms.
  const OPCOES = [
    { grupo: 'Aparência' },
    { id: 'cTema', tipo: 'select', rot: 'Cor de fundo', dica: 'cinza escuro ou branco', def: 'escuro', opcoes: [['escuro', 'Cinza escuro'], ['claro', 'Branco']] },
    { grupo: 'Execução' },
    { id: 'simular', tipo: 'check', rot: 'Só simular', dica: 'não salva nada', def: false },
    { id: 'limite', rot: 'Limite de anúncios', dica: 'vazio = todos', ph: 'todos', def: '' },
    { grupo: 'Ordem de processamento' },
    { id: 'cOrdem', tipo: 'select', rot: 'Quem fica no topo do site', dica: 'o último anúncio salvo aparece primeiro', cfg: 'ORDEM', def: 'lista',
      opcoes: [['lista', 'Ordem da lista (padrão)'], ['inversa', 'Inverter a lista'], ['preco', 'Mais caros no topo'], ['cliques', 'Mais cliques no topo'], ['palavras', 'Palavras de destaque']] },
    { id: 'cPalavras', tipo: 'text', rot: 'Palavras de destaque', dica: 'separadas por vírgula; a 1ª tem mais prioridade', cfg: 'PALAVRAS', def: '', ph: 'ex.: john deere, 7230' },
    { grupo: 'Modo contínuo' },
    { id: 'fim', tipo: 'time', rot: 'Tudo pronto até', dica: 'hora de desligar o PC (todos sem ponto)', def: '17:30' },
    { id: 'cMargem', rot: 'Margem de segurança', dica: 'minutos de folga antes do prazo', cfg: 'MARGEM_FIM', mult: 60000, min: 0, max: 180, def: PADRAO.MARGEM_FIM / 60000 },
    { id: 'pausa', rot: 'Pausa entre fases', dica: 'minutos', def: 0 },
    { id: 'cTent', rot: 'Tentativas se algum falhar', dica: 'antes de parar e avisar', cfg: 'RETENTATIVAS_CONTINUO', min: 0, max: 50, def: PADRAO.RETENTATIVAS_CONTINUO },
    { id: 'cPausaT', rot: 'Pausa entre tentativas', dica: 'segundos', cfg: 'PAUSA_RETENTATIVA', mult: 1000, min: 0, max: 600, def: PADRAO.PAUSA_RETENTATIVA / 1000 },
    { grupo: 'Desempenho' },
    { id: 'cConc', rot: 'Anúncios ao mesmo tempo', dica: '3 = padrão · valor alto pode travar o Chrome', cfg: 'CONCORRENCIA', min: 1, max: 200, def: PADRAO.CONCORRENCIA },
    { id: 'cEspera', rot: 'Espera mínima ao abrir', dica: 'segundos', cfg: 'ESPERA_MIN_CARREGAR', mult: 1000, min: 0, max: 60, step: 0.5, def: PADRAO.ESPERA_MIN_CARREGAR / 1000 },
    { id: 'cEstavel', rot: 'Página parada por', dica: 'segundos, para considerar carregada', cfg: 'ESTAVEL_MS', mult: 1000, min: 0.5, max: 60, step: 0.5, def: PADRAO.ESTAVEL_MS / 1000 },
    { id: 'cTimeout', rot: 'Tempo máximo para abrir', dica: 'segundos', cfg: 'TIMEOUT_CARREGAR', mult: 1000, min: 5, max: 600, def: PADRAO.TIMEOUT_CARREGAR / 1000 },
    { grupo: 'Segurança' },
    { id: 'cRetent', rot: 'Tentar de novo se der erro', dica: 'vezes (execução única)', cfg: 'RETENTATIVAS', min: 0, max: 20, def: PADRAO.RETENTATIVAS },
    { id: 'cVerif', tipo: 'check', rot: 'Confirmar depois de salvar', dica: 'reabre e confere (recomendado)', cfg: 'VERIFICAR', def: PADRAO.VERIFICAR },
    { id: 'cBotao', tipo: 'select', rot: 'Botão de salvar', dica: 'qual botão o script clica', def: 'auto',
      opcoes: [['auto', 'Automático'], ['salvar', 'Só "Salvar"'], ['finalizar', 'Só "Salvar / Finalizar"']] },
  ];
  const opcaoSalvavel = o => o.id && o.id !== 'simular' && o.id !== 'limite';
  const campoHtml = o => {
    if (o.grupo) return `<div class="gr">${o.grupo}</div>`;
    let inp;
    if (o.tipo === 'check') inp = `<input type="checkbox" id="${o.id}"${o.def ? ' checked' : ''}>`;
    else if (o.tipo === 'select') inp = `<select id="${o.id}">${o.opcoes.map(([v, t]) => `<option value="${v}"${v === o.def ? ' selected' : ''}>${t}</option>`).join('')}</select>`;
    else if (o.tipo === 'time') inp = `<input type="time" id="${o.id}" value="${o.def}">`;
    else if (o.tipo === 'text') inp = `<input type="text" id="${o.id}" value="${esc(o.def)}" placeholder="${esc(o.ph || '')}" autocomplete="off" spellcheck="false">`;
    else inp = `<input type="number" id="${o.id}" min="${o.min !== undefined ? o.min : 0}"${o.max ? ` max="${o.max}"` : ''} step="${o.step || 1}" value="${o.def}" placeholder="${o.ph || ''}">`;
    return `<label><span>${o.rot}<small>${o.dica || ''}</small></span>${inp}</label>`;
  };
  const valorCampo = o => {
    const el = ui[o.id];
    if (o.tipo === 'check') return el.checked;
    if (o.tipo === 'select' || o.tipo === 'time' || o.tipo === 'text') return el.value;
    const n = parseFloat(el.value);
    return Number.isFinite(n) ? n : o.def;
  };
  // lê os campos do painel e aplica no CFG
  const aplicarCfg = () => {
    OPCOES.forEach(o => {
      if (!opcaoSalvavel(o)) return;
      let v = valorCampo(o);
      if (typeof v === 'number') {
        if (o.min !== undefined && v < o.min) v = o.min;
        if (o.max !== undefined && v > o.max) v = o.max;
        ui[o.id].value = v;
      }
      if (o.cfg) CFG[o.cfg] = (o.tipo === 'check' || o.tipo === 'select' || o.tipo === 'text') ? v : Math.round(v * (o.mult || 1));
      if (o.id === 'cOrdem' && ui.cPalavras) ui.cPalavras.closest('label').style.display = v === 'palavras' ? '' : 'none';
      if (o.id === 'cTema') {
        ui.host.setAttribute('data-tema', v === 'claro' ? 'claro' : 'escuro');
        ui.tema.textContent = v === 'claro' ? '🌙' : '☀';
        ui.tema.title = v === 'claro' ? 'Mudar para cinza escuro' : 'Mudar para branco';
      }
      if (o.id === 'cBotao') CFG.BOTOES_SALVAR = v === 'salvar' ? [BOT[0]] : v === 'finalizar' ? [BOT[1]] : BOT;
    });
  };
  const salvarCfg = () => {
    try {
      const obj = {};
      OPCOES.forEach(o => { if (opcaoSalvavel(o)) obj[o.id] = o.tipo === 'check' ? ui[o.id].checked : ui[o.id].value; });
      localStorage.setItem('subir_cfg', JSON.stringify(obj));
    } catch (e) { /* opcional */ }
  };
  const carregarCfg = () => {
    try {
      const obj = JSON.parse(localStorage.getItem('subir_cfg') || 'null') || {};
      if (!('fim' in obj)) { const antigo = localStorage.getItem('subir_fim'); if (antigo !== null) obj.fim = antigo; }
      OPCOES.forEach(o => {
        if (!opcaoSalvavel(o) || !(o.id in obj)) return;
        if (o.tipo === 'check') ui[o.id].checked = !!obj[o.id]; else ui[o.id].value = obj[o.id];
      });
    } catch (e) { /* opcional */ }
  };

  const criarPainel = () => {
    const cfgHtml = OPCOES.map(campoHtml).join('');
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647';
    const sh = host.attachShadow({ mode: 'open' });
    sh.innerHTML = `
      <style>${CSS}</style>
      <div class="box" id="box">
        <div class="cab" id="cab">
          <div class="logo">🚜</div>
          <div class="tit"><b>Subir Anúncios</b><span>AutoGerência · publicação automática</span></div>
          <span class="pm" id="pm">0%</span>
          <span class="chip" id="chip"><i></i><span id="chipTxt">Pronto</span></span>
          <button class="ib" id="tema" title="Mudar para branco">☀</button>
          <button class="ib" id="min" title="Minimizar / expandir">–</button>
        </div>
        <div class="corpo">
          <div class="st" id="status"></div>
          <div class="fase" id="fase"></div>
          <div class="prog"><div class="barra"><div id="prog"></div></div><div class="pct" id="pct">0%</div></div>
          <div class="eta" id="eta"></div>
          <div class="kpis">
            <div class="kpi ok"><b id="kOk">0</b><span>Alterados</span></div>
            <div class="kpi certos"><b id="kCertos">0</b><span>Já certos</span></div>
            <div class="kpi falta"><b id="kFalta">0</b><span>Faltam dados</span></div>
            <div class="kpi erro"><b id="kErro">0</b><span>Erros</span></div>
          </div>
          <div class="acoes">
            <button class="btn p" id="colocar">☀ Subir anúncios</button>
            <button class="btn s" id="tirar">🌙 Tirar ponto</button>
            <button class="btn c" id="cont">🔁 Modo contínuo (até encerrar o expediente)</button>
            <button class="btn a" id="enc" style="display:none">🏁 Encerrar expediente</button>
            <button class="btn d" id="parar" style="display:none">⏹ Parar agora</button>
            <button class="btn l" id="rel" style="display:none">📋 Ver relatório</button>
          </div>
          <details>
            <summary>📡 Atividade recente</summary>
            <div class="feed" id="feed"></div>
          </details>
          <details class="cfg">
            <summary>⚙ Configurações</summary>
            <div class="cfgb">
              ${cfgHtml}
              <button class="btn l" id="restaurar">↺ Restaurar padrões</button>
            </div>
          </details>
          <div class="rod">Deixe esta aba aberta e visível durante a execução</div>
        </div>
      </div>`;
    ['box', 'cab', 'chip', 'chipTxt', 'tema', 'min', 'pm', 'colocar', 'tirar', 'cont', 'enc', 'parar', 'rel', 'restaurar',
     'status', 'fase', 'prog', 'pct', 'eta', 'kOk', 'kCertos', 'kFalta', 'kErro', 'feed'].forEach(id => { ui[id] = sh.getElementById(id); });
    OPCOES.forEach(o => { if (o.id) ui[o.id] = sh.getElementById(o.id); });
    ui.sh = sh; ui.host = host;
    ui.colocar.onclick = () => iniciar('colocar');
    ui.tirar.onclick = () => iniciar('tirar');
    ui.cont.onclick = () => iniciarContinuo();
    ui.enc.onclick = () => {
      if (!rodando || !estado.continuo) return;
      if (confirm('Encerrar o expediente agora?\nVou deixar TODOS os anúncios SEM ponto e então parar.')) {
        estado.fimTs = Date.now();
        ui.status.textContent = 'Encerrando o expediente: finalizando do jeito certo...';
      }
    };
    ui.parar.onclick = () => { parar = true; ui.status.textContent = 'Parando... terminando os anúncios em andamento.'; };
    ui.rel.onclick = () => abrirRelatorio();

    // lembra o horário de encerrar, a posição e se está minimizado
    carregarCfg();
    aplicarCfg();
    OPCOES.forEach(o => { if (opcaoSalvavel(o)) ui[o.id].onchange = () => { aplicarCfg(); salvarCfg(); }; });
    ui.tema.onclick = () => { ui.cTema.value = ui.cTema.value === 'claro' ? 'escuro' : 'claro'; aplicarCfg(); salvarCfg(); };
    ui.restaurar.onclick = () => {
      OPCOES.forEach(o => {
        if (!opcaoSalvavel(o)) return;
        if (o.tipo === 'check') ui[o.id].checked = o.def; else ui[o.id].value = o.def;
      });
      aplicarCfg(); salvarCfg();
      ui.status.textContent = 'Configurações restauradas para o padrão.';
    };
    const salvarUi = () => {
      try { localStorage.setItem('subir_ui', JSON.stringify({ mini: ui.box.classList.contains('mini'), x: host.style.left, y: host.style.top })); } catch (e) { /* opcional */ }
    };
    try {
      const u = JSON.parse(localStorage.getItem('subir_ui') || 'null');
      if (u) {
        if (u.mini) ui.box.classList.add('mini');
        if (u.x && u.y) {   // mantém dentro da tela, mesmo que a janela esteja menor hoje
          host.style.left = Math.max(0, Math.min(window.innerWidth - 120, parseInt(u.x, 10) || 0)) + 'px';
          host.style.top = Math.max(0, Math.min(window.innerHeight - 60, parseInt(u.y, 10) || 0)) + 'px';
          host.style.right = 'auto';
        }
      }
    } catch (e) { /* opcional */ }
    ui.min.onclick = () => { ui.box.classList.toggle('mini'); ui.min.textContent = ui.box.classList.contains('mini') ? '+' : '–'; salvarUi(); };
    ui.min.textContent = ui.box.classList.contains('mini') ? '+' : '–';

    // arrastar pelo cabeçalho
    let arr = null;
    ui.cab.onpointerdown = e => {
      if (e.target.closest('button')) return;
      const r = host.getBoundingClientRect();
      arr = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      ui.cab.setPointerCapture(e.pointerId);
    };
    ui.cab.onpointermove = e => {
      if (!arr) return;
      host.style.left = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - arr.dx)) + 'px';
      host.style.top = Math.max(0, Math.min(window.innerHeight - 50, e.clientY - arr.dy)) + 'px';
      host.style.right = 'auto';
    };
    ui.cab.onpointerup = () => { if (arr) { arr = null; salvarUi(); } };

    document.body.appendChild(host);
    setChip('pronto', 'Pronto');
    renderFeed();
  };

  const setChip = (tipo, texto) => { ui.chip.className = 'chip ' + tipo; ui.chipTxt.textContent = texto; };

  const empurrar = (r, modo) => {
    estado.feed.unshift({ t: Date.now(), r, modo });
    if (estado.feed.length > 8) estado.feed.length = 8;
  };
  const renderFeed = () => {
    if (!ui.feed) return;
    ui.feed.innerHTML = estado.feed.length ? estado.feed.map(({ t, r, modo }) => {
      const [cls, ic, tx] = r.status === 'ok' ? ['ok', '✓', modo === 'colocar' ? 'Ponto colocado' : 'Ponto removido']
        : r.status === 'pulado' ? ['certo', '↷', 'Já estava certo']
        : r.status === 'faltaDados' ? ['falta', '!', 'Faltam dados: ' + r.campos.join(', ')]
        : ['erro', '✕', 'Erro: ' + r.motivo];
      return `<div class="it"><span class="ic ${cls}">${ic}</span><div><b>${esc(r.nome || 'Anúncio')}</b><br><span class="t">${esc(tx)}</span></div>` +
        `<small>${new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</small></div>`;
    }).join('') : '<div class="vazio">As ações aparecem aqui durante a execução.</div>';
  };

  const atualizar = () => {
    const c = contagem(estado.resultados);
    const feitos = c.ok + c.pulado + c.faltaDados + c.erro;
    const dec = (Date.now() - estado.inicio) / 1000;
    const resta = feitos ? dec / feitos * (estado.total - feitos) : null;
    const pct = estado.total ? Math.round(feitos / estado.total * 100) : 0;
    ui.kOk.textContent = c.ok; ui.kCertos.textContent = c.pulado; ui.kFalta.textContent = c.faltaDados; ui.kErro.textContent = c.erro;
    ui.pct.textContent = ui.pm.textContent = pct + '%';
    ui.prog.style.width = pct + '%';
    if (rodando) {
      const nomeFase = estado.modo === 'colocar' ? 'Colocando ponto' : 'Removendo ponto';
      ui.status.textContent = `${feitos} de ${estado.total} anúncios processados`;
      ui.fase.textContent = estado.continuo
        ? `Ciclo ${estado.ciclo} · ${nomeFase}` + (estado.finalizando ? ' · FASE FINAL (deixando tudo sem ponto)' : (estado.fimTs ? ` · pronto até ${estado.fimTxt}` + (estado.calcGatilho ? ` (fase final ~${new Date(estado.calcGatilho()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })})` : '') : ''))
        : nomeFase;
      ui.eta.textContent = `Decorrido ${fmt(dec)}` + (resta !== null && feitos < estado.total ? ` · faltam ~${fmt(resta)}` : '') +
        (document.hidden ? ' · ⚠ aba em segundo plano (pode ficar lento)' : '');
      setChip('rodando', estado.finalizando ? 'Encerrando' : (estado.continuo ? 'Contínuo ativo' : 'Em execução'));
    }
    renderFeed();
  };

  // ---------- relatório ----------
  const textoRelatorio = () => {
    const res = estado.resultados.filter(Boolean), c = contagem(res);
    const L = [
      `Subir anúncios (${estado.modo}${estado.simular ? ', SIMULAÇÃO' : ''}) - ${new Date().toLocaleString('pt-BR')}`,
      `Tempo: ${fmt((estado.fim - (estado.continuo ? estado.inicioGeral : estado.inicio)) / 1000)}`,
      `${estado.continuo ? 'Última fase - ' : ''}OK: ${c.ok} | Já estavam certos: ${c.pulado} | Faltam dados: ${c.faltaDados} | Erros: ${c.erro}`];
    if (estado.continuo) L.push(`Ciclos completos (colocar+tirar): ${estado.ciclo - 1}`);
    if (estado.motivo) L.push(estado.motivo);
    if (estado.historico.length) { L.push('', 'HISTÓRICO:'); estado.historico.forEach(h => L.push('- ' + h)); }
    const fd = res.filter(r => r.status === 'faltaDados');
    if (fd.length) { L.push('', 'FALTAM DADOS OBRIGATÓRIOS (preencher à mão):'); fd.forEach(r => L.push(`- ${r.nome || '(sem nome)'}: ${r.campos.join(', ')}\n  ${r.url}`)); }
    const er = res.filter(r => r.status === 'erro');
    if (er.length) { L.push('', 'ERROS:'); er.forEach(r => L.push(`- ${r.nome || '(sem nome)'}: ${r.motivo}\n  ${r.url}`)); }
    return L.join('\n');
  };
  const abrirRelatorio = () => {
    const res = estado.resultados.filter(Boolean), c = contagem(res);
    const fd = res.filter(r => r.status === 'faltaDados'), er = res.filter(r => r.status === 'erro');
    const dur = fmt((estado.fim - (estado.continuo ? estado.inicioGeral : estado.inicio)) / 1000);
    const titulo = estado.continuo ? 'Modo contínuo encerrado' : (estado.parou ? 'Execução interrompida' : 'Execução concluída');
    const modoTxt = estado.continuo ? 'Modo contínuo' : (estado.modo === 'colocar' ? 'Colocar ponto' : 'Tirar ponto');
    const tabela = (lista, cab, det) => `<table><tr><th>Anúncio</th><th>${cab}</th><th></th></tr>` +
      lista.map(r => `<tr><td><b>${esc(r.nome || '(sem nome)')}</b></td><td>${esc(det(r))}</td><td><a href="${esc(r.url)}" target="_blank">abrir</a></td></tr>`).join('') + '</table>';
    const ov = document.createElement('div');
    ov.className = 'ov';
    ov.innerHTML = `<div class="dlg">
      <div class="dh"><div><h3>${titulo}${estado.simular ? ' (simulação)' : ''}</h3>
        <span>${new Date().toLocaleString('pt-BR')} · ${modoTxt} · duração ${dur}</span></div>
        <button class="ib" id="x" title="Fechar">✕</button></div>
      <div class="db">
        ${estado.motivo ? `<div class="ban ${estado.encerradoOk && !estado.atrasou ? 'v' : 'y'}">${esc(estado.motivo)}</div>` : ''}
        ${estado.simular ? '<div class="ban y">Simulação: nada foi salvo no site.</div>' : ''}
        <div class="kpis">
          <div class="kpi ok"><b>${c.ok}</b><span>Alterados</span></div>
          <div class="kpi certos"><b>${c.pulado}</b><span>Já estavam certos</span></div>
          <div class="kpi falta"><b>${c.faltaDados}</b><span>Faltam dados</span></div>
          <div class="kpi erro"><b>${c.erro}</b><span>Erros</span></div>
        </div>
        ${estado.continuo ? `<div class="meta">Ciclos completos (colocar + tirar): <b>${estado.ciclo - 1}</b> · números acima = última fase</div>` : ''}
        ${estado.historico.length ? `<h4>Histórico</h4><ul class="hist">${estado.historico.map(h => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
        ${fd.length ? `<h4>Faltam dados obrigatórios (preencher à mão — o site não deixa salvar)</h4>${tabela(fd, 'Campos vazios', r => r.campos.join(', '))}` : ''}
        ${er.length ? `<h4>Erros (clique no botão de novo para tentar outra vez)</h4>${tabela(er, 'Motivo', r => r.motivo)}` : ''}
        ${!fd.length && !er.length ? '<h4 style="color:#0b6b53">✔ Nenhuma pendência</h4>' : ''}
      </div>
      <div class="df">
        <button class="btn l" id="baixar">⬇ Baixar (.txt)</button>
        <button class="btn s" id="copiar">Copiar</button>
        <button class="btn c" id="fechar">Fechar</button>
      </div>
    </div>`;
    ui.sh.appendChild(ov);
    const fechar = () => { ov.remove(); document.removeEventListener('keydown', esc_); };
    const esc_ = e => { if (e.key === 'Escape') fechar(); };
    document.addEventListener('keydown', esc_);
    ov.onclick = e => { if (e.target === ov) fechar(); };
    ov.querySelector('#fechar').onclick = ov.querySelector('#x').onclick = fechar;
    ov.querySelector('#copiar').onclick = async e => {
      try { await navigator.clipboard.writeText(textoRelatorio()); e.target.textContent = 'Copiado!'; } catch (x) { e.target.textContent = 'Não consegui copiar'; }
    };
    ov.querySelector('#baixar').onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([textoRelatorio()], { type: 'text/plain;charset=utf-8' }));
      a.download = 'relatorio-anuncios-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.txt';
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    };
    console.log(textoRelatorio());
  };

  // ---------- fluxo principal ----------
  const travarUI = on => {
    ui.colocar.style.display = ui.tirar.style.display = ui.cont.style.display = ui.rel.style.display = on ? 'none' : '';
    ui.parar.style.display = on ? '' : 'none';
    ui.enc.style.display = 'none';
    OPCOES.forEach(o => { if (o.id && o.id !== 'cTema' && ui[o.id]) ui[o.id].disabled = on; });
    ui.restaurar.disabled = on;
  };
  const msgOrdem = plano => CFG.ORDEM === 'lista' ? '' :
    `Ordem: ${ROTULO_ORDEM[CFG.ORDEM]}. ${plano.aviso}` +
    (CFG.CONCORRENCIA > 1 ? ` (Com ${CFG.CONCORRENCIA} ao mesmo tempo a ordem é aproximada; use 1 em "Anúncios ao mesmo tempo" para ser exata.)` : '') + '\n';
  const iniciar = async modo => {
    if (rodando) return;
    ui.status.textContent = 'Preparando a lista...';
    await mostrarTodos();
    const total = totalDaTabela();
    const lim = parseInt(ui.limite.value, 10);
    const plano = planejar(lim);
    const urls = plano.urls;
    if (!urls.length) { alert('Não achei anúncios na lista.'); return; }
    const simular = ui.simular.checked;
    const acao = modo === 'colocar' ? 'COLOCAR o ponto' : 'TIRAR o ponto';
    const min = Math.max(1, Math.round(urls.length * 16 / CFG.CONCORRENCIA / 60));
    let msg = `${simular ? '[SIMULAÇÃO - não salva nada]\n' : ''}Vou ${acao} em ${urls.length} anúncios (uns ${min} minutos).\n`;
    if (total && total > urls.length && !(lim > 0)) msg += `ATENÇÃO: a tabela tem ${total} registros, mas só ${urls.length} aparecem na tela.\n`;
    msg += msgOrdem(plano);
    msg += 'Deixe esta aba aberta e visível. Continuar?';
    if (!confirm(msg)) { ui.status.textContent = `${listarUrls().length} anúncios na lista`; return; }

    rodando = true; parar = false;
    Object.assign(estado, { total: urls.length, inicio: Date.now(), modo, simular, resultados: [], parou: false, fim: 0, continuo: false, historico: [], motivo: '', fimTs: 0, finalizando: false, encerradoOk: false, feed: [] });
    travarUI(true);
    atualizar();
    let wl = null;
    try { if (navigator.wakeLock) wl = await navigator.wakeLock.request('screen'); } catch (e) { /* opcional */ }
    try {
      await executar(modo, urls, simular);
    } catch (e) {
      console.error('Falha geral:', e);
    } finally {
      try { wl && wl.release(); } catch (e) { /* opcional */ }
      estado.fim = Date.now(); estado.parou = parar;
      rodando = false;
      travarUI(false);
      const c = contagem(estado.resultados);
      atualizar();
      ui.status.textContent = `${parar ? 'Execução interrompida' : 'Execução concluída'} em ${fmt((estado.fim - estado.inicio) / 1000)}`;
      ui.fase.textContent = ''; ui.eta.textContent = '';
      if (parar) setChip('parado', 'Interrompido');
      else if (c.erro || c.faltaDados) setChip('alerta', 'Concluído com avisos');
      else setChip('ok', 'Concluído');
      abrirRelatorio();
    }
  };

  // ---------- modo contínuo: colocar -> (100%) -> tirar -> (100%) -> colocar ... até o horário de encerrar ----------
  // Regra do fim do dia: os anúncios SEMPRE terminam SEM ponto, para o "colocar" de amanhã não perder tempo pulando.
  const iniciarContinuo = async () => {
    if (rodando) return;
    if (ui.simular.checked) { alert('O modo contínuo não funciona com "Só simular". Desmarque a simulação.'); return; }
    ui.status.textContent = 'Preparando a lista...';
    await mostrarTodos();
    const lim = parseInt(ui.limite.value, 10);
    const pegar = () => planejar(lim).urls;
    const plano0 = planejar(lim);
    let urls = plano0.urls;
    if (!urls.length) { alert('Não achei anúncios na lista.'); return; }
    const pausaMin = Math.max(0, parseFloat(ui.pausa.value) || 0);

    // horário de encerramento (se já passou hoje, vale o de amanhã)
    let fimTs = 0, fimTxt = '';
    const mm = /^(\d{1,2}):(\d{2})$/.exec(ui.fim.value || '');
    if (mm) {
      const d = new Date(); const hoje = d.getDate();
      d.setHours(+mm[1], +mm[2], 0, 0);
      if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
      fimTs = d.getTime();
      fimTxt = `${mm[1].padStart(2, '0')}:${mm[2]}` + (d.getDate() !== hoje ? ' (amanhã)' : '');
    }
    const hhmm = ts => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const est0 = urls.length * 16000 / Math.max(1, Math.min(CFG.CONCORRENCIA, urls.length)) * 1.25;   // estimativa inicial da fase final
    const g0 = fimTs ? fimTs - est0 - CFG.MARGEM_FIM : 0;
    const msg = `MODO CONTÍNUO\n\n` +
      `Vou repetir nesta ordem: COLOCAR o ponto nos ${urls.length} anúncios → só quando todos estiverem completos, TIRAR o ponto de todos → de novo.\n\n` +
      (fimTxt
        ? `• PRAZO: tudo pronto, com todos SEM ponto, até ${fimTxt} (hora de desligar o PC).\n` +
          `  Eu começo a fase final ANTES, calculando pelo tempo real dos anúncios + ${Math.round(CFG.MARGEM_FIM / 60000)} min de segurança. ` +
          `Estimativa agora: fase final por volta das ${hhmm(g0)}.\n` +
          (g0 <= Date.now() ? `  ⚠ O prazo está curto para ${urls.length} anúncios: a fase final começa já.\n` : '')
        : `• Sem horário definido: encerre quando quiser no botão 🏁 Encerrar expediente (ele deixa tudo sem ponto).\n`) +
      `• A fase seguinte só começa quando a atual está 100% completa. Anúncios com erro são refeitos até ${CFG.RETENTATIVAS_CONTINUO} vezes; se algum não completar, eu paro e aviso.\n` +
      `• Anúncios sem dados obrigatórios não podem ser salvos e são pulados.\n` +
      (CFG.ORDEM !== 'lista' ? `• ${msgOrdem(plano0)}` : '') +
      (pausaMin ? `• Pausa entre fases: ${pausaMin} min.\n` : '') +
      `• ⏹ Parar interrompe na hora (os anúncios ficam como estiverem).\n\n` +
      `Deixe a aba aberta e visível. Continuar?`;
    if (!confirm(msg)) { ui.status.textContent = `${listarUrls().length} anúncios na lista`; return; }

    rodando = true; parar = false;
    Object.assign(estado, { continuo: true, ciclo: 1, historico: [], motivo: '', parou: false, simular: false, fim: 0,
      inicioGeral: Date.now(), fimTs, fimTxt, prazoTs: fimTs, atrasou: false, sOk: 0, nOk: 0, finalizando: false, encerradoOk: false, feed: [] });
    travarUI(true);
    ui.enc.style.display = '';
    let wl = null;
    try { if (navigator.wakeLock) wl = await navigator.wakeLock.request('screen'); } catch (e) { /* opcional */ }

    // Quando começar a fase final: prazo - (tempo estimado para tirar o ponto de todos) - margem de segurança.
    // O tempo estimado usa a média real dos anúncios já alterados (antes de medir, usa 16 s por anúncio).
    const estFinal = () => {
      const med = estado.nOk ? estado.sOk / estado.nOk : 16000;
      const n = Math.max(1, urls.length);
      return n * med / Math.max(1, Math.min(CFG.CONCORRENCIA, n)) * 1.25;
    };
    const gatilho = () => (estado.fimTs > 0 ? estado.fimTs - estFinal() - CFG.MARGEM_FIM : 0);
    estado.calcGatilho = gatilho;
    const acabou = () => estado.fimTs > 0 && Date.now() >= gatilho();
    const nomeFase = m => (m === 'colocar' ? 'COLOCAR' : 'TIRAR');
    let modo = 'colocar', ultima = null, abortou = false;
    // durante a fase COLOCAR, ao chegar a hora, para de pegar anúncios novos (vai direto para o TIRAR final)
    const abortar = () => {
      if (!estado.finalizando && modo === 'colocar' && acabou()) { abortou = true; return true; }
      return false;
    };
    try {
      while (!parar) {
        if (acabou()) {
          if (ultima === 'tirar') {   // o último passo completo já foi TIRAR: tudo está sem ponto
            const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            estado.atrasou = !!(estado.prazoTs && Date.now() > estado.prazoTs);
            estado.motivo = 'Expediente encerrado: todos os anúncios ficaram SEM ponto (prontos para o COLOCAR de amanhã).' +
              (estado.prazoTs ? (estado.atrasou ? ` ⚠ Terminou às ${hora}, DEPOIS do prazo de ${fimTxt}. Aumente a margem de segurança.` : ` Terminou às ${hora}, dentro do prazo (${fimTxt}).`) : '');
            estado.encerradoOk = true;
            break;
          }
          if (!estado.finalizando) {
            estado.finalizando = true; modo = 'tirar';
            estado.historico.push(`Hora de começar a fase final (${hhmm(Date.now())}): TIRAR o ponto de todos para ficar pronto até ${fimTxt || 'agora'}.`);
          }
        }
        urls = pegar();
        if (!urls.length) { estado.motivo = 'A lista de anúncios ficou vazia.'; break; }
        abortou = false;
        Object.assign(estado, { total: urls.length, inicio: Date.now(), modo, resultados: [] });
        atualizar();
        ultima = null;   // a fase vai mexer nos anúncios: o estado deixa de ser "limpo" até ela completar
        const res = await executar(modo, urls, false, { retent: CFG.RETENTATIVAS_CONTINUO, pausa: CFG.PAUSA_RETENTATIVA, abortar });
        const c = contagem(res);
        estado.historico.push(`Ciclo ${estado.ciclo} · ${nomeFase(modo)}${abortou ? ' (interrompida: hora de encerrar)' : ''}${estado.finalizando ? ' [fase final]' : ''}: ` +
          `✔ ${c.ok} · já certos ${c.pulado} · faltam dados ${c.faltaDados} · erros ${c.erro} · ${fmt((Date.now() - estado.inicio) / 1000)}`);
        if (parar) {
          estado.motivo = `Você parou no meio da fase "${nomeFase(modo)}": alguns anúncios podem estar com ponto e outros sem.`;
          break;
        }
        if (abortou) continue;  // volta ao topo: vai para a fase final TIRAR
        if (c.erro > 0) {
          estado.motivo = estado.finalizando
            ? `ATENÇÃO: ${c.erro} anúncio(s) não conseguiram a fase final TIRAR e podem ter ficado COM ponto. Veja abaixo; no início do dia eles serão pulados no COLOCAR.`
            : `${c.erro} anúncio(s) não completaram a fase "${nomeFase(modo)}" mesmo após ${CFG.RETENTATIVAS_CONTINUO} tentativas. Parei para não sair da ordem. Veja os erros abaixo.`;
          break;
        }
        ultima = modo;
        if (modo === 'tirar') estado.ciclo++;
        modo = modo === 'colocar' ? 'tirar' : 'colocar';
        const t = Date.now();
        while (!parar && !acabou() && Date.now() - t < pausaMin * 60000) {
          ui.status.textContent = `Fase concluída. Próxima fase (${nomeFase(modo)}) em ${fmt((pausaMin * 60000 - (Date.now() - t)) / 1000)}...`;
          await sleep(1000);
        }
      }
    } catch (e) {
      console.error('Falha geral:', e);
      estado.motivo = 'Erro inesperado: ' + ((e && e.message) || e);
    } finally {
      try { wl && wl.release(); } catch (e) { /* opcional */ }
      estado.fim = Date.now(); estado.parou = parar;
      rodando = false;
      travarUI(false);
      atualizar();
      ui.status.textContent = `Modo contínuo encerrado · ${estado.ciclo - 1} ciclo(s) completo(s)` + (estado.encerradoOk ? ' · todos SEM ponto' : '');
      ui.fase.textContent = ''; ui.eta.textContent = '';
      if (estado.encerradoOk) setChip('ok', 'Expediente encerrado');
      else if (parar) setChip('parado', 'Interrompido');
      else setChip('alerta', 'Atenção');
      abrirRelatorio();
    }
  };

  // evita fechar/recarregar a aba sem querer enquanto roda
  window.addEventListener('beforeunload', e => { if (rodando) { e.preventDefault(); e.returnValue = ''; } });

  // leitura do andamento por fora (usada pelo robô da nuvem; não altera nada)
  window.__subirResumo = () => ({ rodando, concluido: !rodando && estado.fim > 0, parou: !!estado.parou, modo: estado.modo,
    total: estado.total, feitos: estado.resultados.filter(Boolean).length, ...contagem(estado.resultados) });

  // mostra o painel só em páginas que têm a lista de veículos
  setInterval(() => {
    if (!ui.host && listarUrls().length) { criarPainel(); ui.status.textContent = `${listarUrls().length} anúncios na lista`; }
    else if (ui.host && !rodando && ui.rel.style.display === 'none') {
      ui.status.textContent = `${listarUrls().length} anúncios na lista`;
    }
  }, 2000);
})();
