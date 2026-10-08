# Subir anúncios sozinho (na nuvem do GitHub)

O GitHub entra no AutoGerência com o seu login e roda o mesmo script do painel, **sem o seu PC ligado**, todos os dias, nestes horários (Cuiabá):

| Horário | O que faz |
|---|---|
| 07:00 | coloca o ponto em todos |
| 11:00 | tira o ponto de todos |
| 13:00 | coloca o ponto em todos |
| 17:00 | tira o ponto de todos (o dia termina sem ponto) |
| 17:25 | conferência final: tira o ponto de quem tiver sobrado |

O GitHub pode atrasar o início em alguns minutos (por isso os horários estão com ":03").

> **Antes de começar:** o repositório vai ficar **público**. Isso significa que o código e os registros das execuções (logs) aparecem para qualquer pessoa. O robô foi feito para escrever nos registros só contagens ("3 alterados, 0 erros"), nunca a senha, nomes ou links dos anúncios. A **senha fica nos "Secrets"** do GitHub, que ninguém vê.

---

## Passo 1: Deixar o repositório público
1. No repositório `medidor-anuncios`, clique em **Settings** (Configurações).
2. Role até o final, para **Danger Zone** (Zona de perigo).
3. **Change repository visibility** → **Change to public** e confirme.

## Passo 2: Guardar o login nos Secrets
1. **Settings → Secrets and variables → Actions**.
2. **New repository secret**. Nome: `AG_USUARIO`, valor: o seu usuário do AutoGerência. **Add secret**.
3. De novo: nome `AG_SENHA`, valor: a sua senha.
4. Só se a tela de login tiver um campo de empresa/loja: nome `AG_EMPRESA`, valor: o que preenche ali.

Dica: se o AutoGerência permitir, crie um usuário separado só para isso, e use esse nos Secrets.
**Nunca** escreva a senha no chat, em arquivo do repositório ou em mensagem de commit.

## Passo 3: Enviar os arquivos novos
Descompacte o `nuvem-anuncios.zip`. Na página do repositório, **Add file → Upload files** e arraste:
`subir_nuvem.js`, `config_nuvem.json`, `package.json`, `subir_anuncios.user.js`, `teste_nuvem.js` e este `LEIA-ME.md`. Clique em **Commit changes**.

Depois o agendamento (pasta escondida, igual ao do medidor):
1. **Add file → Create new file**.
2. No nome digite exatamente `.github/workflows/subir.yml`.
3. Cole o conteúdo do arquivo `subir.yml` (dentro da pasta `.github/workflows` do zip) e **Commit changes**.

## Passo 4: Teste do login (não altera nada)
1. Aba **Actions** → **Subir anúncios** (menu da esquerda) → **Run workflow**.
2. Marque **Só testar o login** e clique no botão verde **Run workflow**.
3. Espere uns 2 a 3 minutos (a primeira vez instala o navegador). Clique na execução e depois no passo **Subir os anúncios** para ler o resultado.

Resultados possíveis:
- **"Login feito" e "Anúncios encontrados na lista: N":** deu certo, siga para o passo 5.
- **"tem proteção não sou um robô":** o site usa captcha e não dá para automatizar.
- **"O login não funcionou":** confira usuário e senha nos Secrets. Se estiverem certos, o site pode estar bloqueando o GitHub (por exemplo, recusando acessos vindos de servidores) ou pedindo um código por SMS/e-mail. Copie o texto desse passo e me mande: ele mostra os campos da tela de login e eu ajusto.

## Passo 5: Teste pequeno (com 3 anúncios)
1. **Run workflow**, deixe "Só testar o login" **desmarcado**.
2. Em **modo** escolha `colocar`, em **limite** digite `3`, e clique em **Run workflow**.
3. Abra o AutoGerência e confira se 3 anúncios ficaram com o ponto na primeira linha da descrição.
4. Rode de novo com modo `tirar` e limite `3` para voltar ao normal.

## Passo 6: Deixar automático
Não precisa fazer mais nada. Os horários da tabela acima já estão valendo desde que o arquivo `subir.yml` entrou. Para rodar tudo na hora, use **Run workflow** com modo `auto` e limite vazio.

---

## Como saber se deu certo no dia a dia
- Aba **Actions**: ✔ verde = ok. ✖ vermelho = algum anúncio deu erro ou o login falhou. O GitHub costuma avisar por e-mail quando uma execução agendada falha (confira se as notificações estão ligadas em github.com/settings/notifications).
- O resumo no fim do registro mostra: "X alterados · Y já estavam certos · Z sem dados obrigatórios · W com erro". Os "sem dados obrigatórios" são os anúncios que o site não deixa salvar (Ano, Cor ou Fabricante vazios). Preencha à mão no AutoGerência.

## Ajustes (arquivo `config_nuvem.json`)
- `agenda`: a hora local a partir da qual vale cada modo. Por exemplo `["09:00","tirar"]` = a partir das 9h, tira.
- `ordem` e `palavras`: quem fica no topo do site (`lista`, `inversa`, `preco`, `cliques` ou `palavras`; ver o painel do script).
- `concorrencia`: anúncios ao mesmo tempo (4 por padrão; abaixe se aparecerem muitos erros).
- Para mudar os **horários** das execuções: edite os `cron` no `subir.yml` (estão em UTC; Cuiabá = UTC-4, então 07:00 = `11`). Para só fim de semana, troque o último `*` de cada linha por `0,6`.

## Se der problema
- **Anúncios ficaram com ponto no fim do dia:** rode **Run workflow** com modo `tirar`, limite vazio.
- **Quer parar tudo:** aba Actions → **Subir anúncios** → **⋯** → **Disable workflow**.
- **O GitHub desligou o agendamento ("scheduled workflows disabled"):** em repositório público isso pode acontecer se ficar 60 dias sem atividade. Há um aviso no topo da aba Actions e um botão para reativar. Como o medidor grava novos arquivos todo dia, o mais provável é que não aconteça.
- **Mudou a senha do AutoGerência:** atualize o Secret `AG_SENHA`.

## Limites
- Não foi possível testar contra o AutoGerência de verdade (só contra um site de mentira, com login, lista e edição). O passo 4 existe justamente para isso.
- Se o site mudar a tela de login ou passar a exigir captcha/código, a automação para e a execução fica vermelha. Nada é alterado nesse caso.
- Em repositório público os minutos de execução são grátis, pelo que sei. Confira em github.com/pricing.
