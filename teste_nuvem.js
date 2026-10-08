'use strict';
/* Teste do robô da nuvem contra um site de mentira (login + lista + edição). Rodar: node teste_nuvem.js */
const http = require('http');
const { spawn } = require('child_process');
const assert = require('assert');
const { modoPorHorario } = require('./subir_nuvem.js');

const PORT = 8123, BASE = `http://127.0.0.1:${PORT}`;
const USER = 'joao', PASS = 'S3nha-MUITO-secreta!';
const NOMES = ['TRATOR A', 'COLHEITADEIRA B', 'PLANTADEIRA C', 'GRADE D', 'TRATOR E', 'ROÇADEIRA F'];
let captcha = false, estado, salvos;
const reset = () => { estado = NOMES.map(() => 'descrição do anúncio'); salvos = []; };
const cookieOk = q => /sid=ok/.test(q.headers.cookie || '');

const server = http.createServer((q, r) => {
  const u = new URL(q.url, BASE);
  const html = (b, st = 200, h = {}) => { r.writeHead(st, { 'content-type': 'text/html; charset=utf-8', ...h }); r.end(b); };
  if (u.pathname === '/login.aspx') {
    if (q.method === 'POST') {
      let b = ''; q.on('data', d => b += d); q.on('end', () => {
        const p = new URLSearchParams(b);
        if (p.get('txtUsuario') === USER && p.get('txtSenha') === PASS) { r.writeHead(302, { 'set-cookie': 'sid=ok; Path=/', location: '/Compacto/v4Estoque/ListarVeiculosCompact.aspx' }); return r.end(); }
        html(telaLogin('Usuário ou senha inválidos'));
      }); return;
    }
    return html(telaLogin(''));
  }
  if (u.pathname.endsWith('ListarVeiculosCompact.aspx')) {
    if (!cookieOk(q)) { r.writeHead(302, { location: '/login.aspx' }); return r.end(); }
    return html(`<html><body><table><thead><tr><th>Veículo</th><th>Preço</th></tr></thead><tbody>${NOMES.map((n, i) =>
      `<tr><td><a href="/Compacto/v4Estoque/DetalheVeiculoCompact.aspx?guid=g${i}">${n}</a></td><td>R$ ${(i + 1) * 10}.000,00</td></tr>`).join('')}</tbody></table></body></html>`);
  }
  if (u.pathname.endsWith('manterveiculocompact.aspx')) {
    if (!cookieOk(q)) { r.writeHead(302, { location: '/login.aspx' }); return r.end(); }
    const g = +u.searchParams.get('guid').slice(1);
    return html(`<html><body><textarea id="txtObservacao">${estado[g]}</textarea><button onclick="fetch('/save?g=${g}',{method:'POST',body:document.getElementById('txtObservacao').value})">Salvar</button></body></html>`);
  }
  if (u.pathname === '/save') {
    let b = ''; q.on('data', d => b += d); q.on('end', () => { const g = +u.searchParams.get('g'); estado[g] = b; salvos.push([g, b.startsWith('.') ? '+' : '-']); r.end('ok'); }); return;
  }
  r.writeHead(204); r.end();
});
function telaLogin(msg) {
  return `<html><head><title>AutoGerência - Login</title></head><body><form method="post" action="/login.aspx">
  <input type="text" id="txtUsuario" name="txtUsuario" placeholder="Usuário"><input type="password" id="txtSenha" name="txtSenha" placeholder="Senha">
  ${captcha ? '<div class="g-recaptcha" data-sitekey="abc"></div>' : ''}${msg ? `<span class="erro">${msg}</span>` : ''}
  <input type="submit" value="Entrar"></form></body></html>`;
}

function rodar(env) {
  return new Promise(res => {
    const p = spawn('node', ['subir_nuvem.js'], { cwd: __dirname, env: { ...process.env, NODE_PATH: '/home/claude/.npm-global/lib/node_modules', AG_LISTA_URL: `${BASE}/Compacto/v4Estoque/ListarVeiculosCompact.aspx`, ...env } });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('close', code => res({ code, out }));
  });
}
let falhas = 0;
const teste = async (nome, fn) => { try { await fn(); console.log('ok   -', nome); } catch (e) { falhas++; console.log('FALHA-', nome, '\n      ', e.message); } };

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const d = h => new Date(`2026-10-08T${h}:00-04:00`);
  await teste('modo automático pela hora (Cuiabá)', () => {
    assert.strictEqual(modoPorHorario(d('07:05')), 'colocar');
    assert.strictEqual(modoPorHorario(d('11:30')), 'tirar');
    assert.strictEqual(modoPorHorario(d('13:40')), 'colocar');
    assert.strictEqual(modoPorHorario(d('17:03')), 'tirar');
    assert.strictEqual(modoPorHorario(d('17:25')), 'tirar');
  });

  reset();
  await teste('sem os Secrets: avisa e falha', async () => {
    const r = await rodar({ AG_USUARIO: '', AG_SENHA: '', MODO: 'colocar' });
    assert.strictEqual(r.code, 1); assert.match(r.out, /Faltam os Secrets/);
  });

  await teste('diagnóstico: faz login, conta anúncios e não altera nada', async () => {
    const r = await rodar({ AG_USUARIO: USER, AG_SENHA: PASS, DIAGNOSTICO: '1' });
    assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /Tela de login encontrada/); assert.match(r.out, /Login feito/);
    assert.match(r.out, /Anúncios encontrados na lista: 6/); assert.strictEqual(salvos.length, 0);
  });

  await teste('senha errada: falha com mensagem clara e sem vazar a senha', async () => {
    const r = await rodar({ AG_USUARIO: USER, AG_SENHA: 'errada-123', MODO: 'colocar' });
    assert.strictEqual(r.code, 1); assert.match(r.out, /login não funcionou/); assert.match(r.out, /Usuário ou senha inválidos/);
    assert.ok(!r.out.includes('errada-123')); assert.strictEqual(salvos.length, 0);
  });

  captcha = true;
  await teste('tela com captcha: avisa que não dá para automatizar', async () => {
    const r = await rodar({ AG_USUARIO: USER, AG_SENHA: PASS, MODO: 'colocar' });
    assert.strictEqual(r.code, 1); assert.match(r.out, /não sou um robô/); assert.strictEqual(salvos.length, 0);
  });
  captcha = false;

  reset();
  await teste('simulação: não salva nada', async () => {
    const r = await rodar({ AG_USUARIO: USER, AG_SENHA: PASS, MODO: 'colocar', SIMULAR: '1', LIMITE: '3' });
    assert.strictEqual(r.code, 0, r.out); assert.strictEqual(salvos.length, 0);
  });

  reset();
  await teste('colocar com limite 3: só mexe em 3 e confirma', async () => {
    const r = await rodar({ AG_USUARIO: USER, AG_SENHA: PASS, MODO: 'colocar', LIMITE: '3' });
    assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /3 alterados/);
    assert.strictEqual(estado.filter(t => t.startsWith('.')).length, 3);
  });

  await teste('colocar de novo (todos): os 3 já feitos são pulados', async () => {
    const r = await rodar({ AG_USUARIO: USER, AG_SENHA: PASS, MODO: 'colocar' });
    assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /3 alterados · 3 já estavam certos/);
    assert.ok(estado.every(t => t.startsWith('.')));
  });

  await teste('tirar (todos): termina sem ponto; nada sensível nos registros', async () => {
    const r = await rodar({ AG_USUARIO: USER, AG_SENHA: PASS, MODO: 'tirar' });
    assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /6 alterados/);
    assert.ok(estado.every(t => !t.startsWith('.')));
    assert.ok(!r.out.includes(PASS)); NOMES.forEach(n => assert.ok(!r.out.includes(n), 'vazou nome de anúncio: ' + n));
    assert.ok(!/guid=/.test(r.out));
  });

  server.close();
  console.log(falhas ? `\n${falhas} teste(s) falharam` : '\nTodos os testes passaram');
  process.exit(falhas ? 1 : 0);
})();
