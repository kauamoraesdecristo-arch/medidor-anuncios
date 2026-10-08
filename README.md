# Medidor de posição dos anúncios

Este medidor **olha o site público** (tratoresecolheitadeiras.com.br) a cada 30 minutos, anota em que posição estão os anúncios da TK Tratores na lista "Mais recentes" e monta um resumo. Roda nos servidores gratuitos do GitHub, **com o seu computador desligado**.

- Não usa login nem senha. Só lê páginas públicas, como qualquer visitante.
- Não mexe em nenhum anúncio. Só mede.
- Depois de alguns dias de dados, o `RESUMO.md` mostra quanto tempo ficamos no topo e de quanto em quanto tempo vale a pena subir.

---

## Instalação (uns 10 minutos, uma vez só)

### 1. Criar a conta
Entre em https://github.com e crie uma conta gratuita (se ainda não tiver).

### 2. Criar o repositório (a "pasta" na nuvem)
1. Clique no **+** (canto superior direito) → **New repository**.
2. Nome: `medidor-anuncios` (pode ser outro).
3. Marque **Private** (privado: só você enxerga).
4. **Não** marque "Add a README file".
5. Clique em **Create repository**.

### 3. Enviar os arquivos
Na página do repositório vazio, clique em **uploading an existing file** e arraste:

- `medir.js`
- `config.json`
- `README.md`
- `teste.js`

Clique em **Commit changes**.

**O arquivo do agendamento** fica numa pasta escondida (`.github/workflows`), e o arraste do navegador costuma ignorá-la. Por isso crie-o assim:

1. **Add file → Create new file**.
2. No campo do nome, digite exatamente: `.github/workflows/medir.yml` (ao digitar a `/` ele cria as pastas sozinho).
3. Abra o arquivo `medir.yml` desta pasta no Bloco de Notas, copie tudo e cole na área grande.
4. **Commit changes**.

### 4. Ligar e testar
1. Aba **Actions**. Se aparecer um botão verde para habilitar, clique nele.
2. No menu da esquerda, clique em **Medir posição dos anúncios**.
3. Botão **Run workflow** → **Run workflow** (verde).
4. Espere ~30 segundos e atualize. Um ✔ verde significa que funcionou.
5. Volte à aba **Code**: apareceram a pasta `dados` (arquivo `posicoes.csv`) e o `RESUMO.md`. Abra o `RESUMO.md`.

Daqui em diante ele roda sozinho a cada 30 minutos.

### Se der erro ao guardar os resultados
Se o passo "Guardar os resultados" falhar com "permission denied": **Settings → Actions → General → Workflow permissions → Read and write permissions → Save**, e rode de novo.

---

## Como ler o resultado

- **`RESUMO.md`**: abra e leia. Mostra a posição agora, % do tempo no topo, duração média de cada período no topo, tabela por hora do dia (quando os concorrentes mais passam na nossa frente) e uma sugestão automática de intervalo (só aparece com pelo menos 2 dias de leituras).
- **`dados/posicoes.csv`**: todas as leituras, abre no Excel.

"No topo" = no máximo 3 anúncios de **outras lojas** (sem contar patrocinados) acima do primeiro anúncio nosso. Para mudar, altere `topoLimite` no `config.json`.

### Possíveis valores da coluna `status`
| Valor | Significa |
|---|---|
| `ok` | Leu a lista e achou anúncios nossos na 1ª página |
| `fora_da_pagina` | Nenhum anúncio nosso entre os 20 primeiros |
| `erro:bloqueado_pelo_site (HTTP 403)` | O site (que usa proteção Cloudflare) recusou o acesso do servidor do GitHub |
| `erro:nenhum_anuncio_encontrado_na_pagina` | A página veio, mas sem anúncios: o site pode ter mudado de layout |

**Se aparecer sempre `bloqueado_pelo_site`:** o site não aceita visitas vindas do GitHub. Não tente contornar. Avise-me e eu faço a versão que roda no navegador do seu PC (precisa estar ligado).

---

## Ajustes (`config.json`)

- `loja`: `id` (8720) e `slugs` (`tk-tratores`) identificam os anúncios nossos.
- `listas`: as páginas medidas. Para medir outra categoria, copie o endereço da lista no site público e acrescente uma linha.
- `topoLimite`: quantos anúncios de outras lojas ainda contam como "topo".
- `fusoHorario`: horário usado nas tabelas (America/Cuiaba).

## Limites e cuidados

- Lê só a **1ª página** (20 anúncios) de cada lista, com pausa entre as páginas. É uma carga mínima, bem menos que um visitante normal.
- A detecção de "patrocinado" é por texto da página ("Publicidade"); se o site mudar, pode errar.
- Em repositório privado, o GitHub Free dá cerca de 2.000 minutos/mês de execução (pelo que sei). Este medidor usa uns 1.400/mês. Confira em Settings → Billing se quiser.
- O GitHub pode atrasar alguns minutos o agendamento nos horários de pico. Normal.
- Se o repositório ficar 60 dias sem nenhuma alteração, o GitHub pausa o agendamento. Aqui isso não acontece, pois cada leitura grava um arquivo novo.

## Desligar
Aba **Actions → Medir posição dos anúncios → ⋯ → Disable workflow**.
