# TUI do pulsar (Ink) — desenho

Data: 2026-07-28
Status: implementado

## Problema

O pulsar só tem CLI. Para começar a usar é preciso escrever um yml à mão,
sabendo de cor os nomes das collections da origem, e depois descobrir sozinho
como deixar o `sync` rodando 24/7 e como ler o que ele fez. Três atritos
distintos: **descoberta** (o que existe no banco), **configuração** (montar o
yml certo) e **operação** (rodar, deixar de pé, ler log).

## Escopo

Uma TUI em [Ink](https://term.ink) que resolve os três, sem tocar no
comportamento dos comandos existentes:

1. Criar/editar o yml por formulário, com introspecção do banco de origem
   (collections, views, índices, contagens) e busca por nome.
2. Disparar `sync`/`migrate`/`ttl` com a saída ao vivo na tela.
3. Instalar como serviço de background com autostart: systemd (Linux), launchd
   (macOS), pm2 e docker.
4. Ler logs: ao vivo (do serviço em background) e gravados (`./logs/*.log`).

## Arquitetura

**Núcleo puro + Ink como casca fina.** Nada em `src/core/` importa React; nada
em `src/tui/` fala com o driver do Mongo ou com o sistema operacional
diretamente. Isso mantém a regra de negócio testável com `bun test` sem
renderizar componente, no mesmo estilo dos testes que já existiam.

```
src/tui/
  index.tsx              # render(<App/>); exige TTY
  App.tsx                # roteador de telas (união discriminada em useState)
  theme.ts               # paleta (identidade em hex, estados em ANSI-16) e glifos
  layout.ts              # geometria do cockpit — pura, testada
  components/            # Shell (cabeçalho/Panel/Sidebar/Stat), Select,
                         # TextInput, CollectionPicker, Spinner
  hooks/                 # useInspector (Mongo), useProcess (filho), useSpinner
  screens/               # Home, Wizard, Runner, Services, Logs
    wizard/              # ConnectionStep, CollectionsStep, EstimatesPanel,
                         # AdvancedStep, ReviewStep
src/core/
  inspect/               # inspectDb, collStats, indexSummary, summary, probe, maskUri
  config/                # formState, buildConfig, loadConfig, writeConfig
  run/                   # pulsarCommand, logLines
  service/               # types, systemd, launchd, pm2, dockerService, detect, manager
  logs/                  # readLog, tailCommand
```

Reuso do que já existia: `core/compose/detectConfigs` (classificar ymls),
`core/compose/buildCompose` + `recommend` + `committed` (backend docker),
`types/parseYml` (validação Zod), `utils/i18n`.

## Decisões

### Entrypoint: `pulsar` sem argumento abre a TUI

`pulsar tui` também funciona explicitamente. Os subcomandos seguem idênticos.
O import do módulo da TUI é **dinâmico**: quem roda `pulsar sync` num container
não carrega react/ink.

### Estimativas são opt-in ("show estimatives")

`countDocuments` numa collection de 215M docs leva minutos e gera carga real no
cluster. Por padrão a tela só lista nomes (metadata, instantâneo). O painel de
estimativas liga a coleta e escolhe quais métricas puxar (docs, tamanho,
índices) via `$collStats`. Números aproximados aparecem com `~`; a tecla `c`
faz a contagem exata de UMA collection sob demanda. Com filtro, só o exato
responde — a estimativa é cega a filtro.

### Conexão de sondagem separada de `db/conn.ts`

`db/conn.ts` retenta erro transitório até 60 vezes com backoff, o que é certo
para o daemon e errado para um form: um typo na URI prenderia a tela por
minutos. `core/inspect/probe.ts` usa timeout curto (8s, parametrizável) e uma
tentativa, e traduz o erro do driver em frase acionável.

### Um `useInput` por tela

O ink entrega cada tecla a TODOS os `useInput` ativos. Com dois handlers na
mesma tela, digitar "e" numa busca abriria o painel de estimativas e um `esc`
para sair da busca também voltaria de tela. Por isso o `CollectionPicker`
trata inclusive as teclas que "pertencem" ao passo (`esc`, `e`) e as devolve
por callback.

### Layout de cockpit

Tela cheia em *alternate screen* (o mesmo buffer de vim/htop/k9s), com sidebar,
painel central e painel de contexto simultâneos; `tab` alterna o foco. A
geometria vive em `src/tui/layout.ts` — pura e testada, fora do componente.
Abaixo de 96 colunas o painel da direita é sacrificado antes de tudo: ele é
contexto, não conteúdo, e espremer três painéis num terminal estreito deixaria
a lista de collections com uma dúzia de caracteres.

O `Box` do ink não sabe escrever título dentro da moldura, então o `Panel`
desenha a linha de cima à mão (`╭─ título ───╮`) e usa `borderTop={false}` no
Box abaixo. Como as larguras são conhecidas, a linha bate exatamente.

### Saída global: Ctrl+C e Ctrl+D

O `render()` roda com `exitOnCtrlC: false` para que um sync disparado pela TUI
receba SIGTERM (e grave o resume token) antes de o processo morrer. Isso, porém,
deixa a TUI **sem saída** se ninguém tratar o atalho — as telas internas só
tratam `esc`, e `esc` na inicial não encerra. O handler global vive no `App`.

### `flexShrink` mora em `Box`, não em `Text`

Quando a linha passa da largura do terminal, o yoga encolhe cada filho
proporcionalmente — o cabeçalho vira "pulsa · iníci" e um item vira "docke".
Rótulos ficam em `<Box flexShrink={0}>` e só a dica encolhe, com
`wrap="truncate-end"`.

### Serviços: plano visível, nada de sudo automático

Cada backend produz um `InstallPlan` — arquivos que serão gravados + comandos
que serão executados + notas — exibido **antes** de qualquer efeito. Passos que
exigem root (`loginctl enable-linger` como fallback, `pm2 startup`,
`systemctl enable docker`) são listados como manuais e nunca executados pela
TUI.

Diferenças reais entre backends, refletidas nos geradores:

- **systemd**: unit de *usuário* (sem sudo). `loginctl enable-linger` é parte do
  plano quando há autostart — sem ele o serviço não sobe no boot de uma VM
  headless. `TimeoutStopSec=45 > PULSAR_SHUTDOWN_TIMEOUT_MS=30000`, para o
  pulsar gravar o resume token antes de morrer. `Restart=always` no sync,
  `on-failure` no migrate/ttl.
- **launchd**: LaunchAgent do usuário; sobe no **login**, não no boot (um
  LaunchDaemon exigiria root e escrita em `/Library` — fora do escopo da TUI).
  `KeepAlive` é `true` no sync e `{SuccessfulExit: false}` no migrate/ttl, senão
  um migrate bem-sucedido reiniciaria em loop.
- **pm2**: ecosystem file em vez de linha de comando, porque `pm2 start ... --
  args` quebra quando o pulsar roda via `bun src/cli.ts`. `interpreter: none`.
- **docker**: herda `docker-compose-limit.yml` do projeto (fonte única) e só é
  oferecido para `sync`.

`core/run/pulsarCommand.ts` detecta se o processo é binário compilado
(`Bun.main` em `/$bunfs`) ou código-fonte, porque a linha de comando gravada na
unit muda — e um erro aí só apareceria no boot seguinte.

### Logs: duas leituras que não se substituem

Arquivo (`./logs/*.log`) é o histórico do winston, lido pela cauda
(`readSince`/`tailFile`, nunca o arquivo inteiro) com busca e follow por
polling de offset. Ao vivo é o stdout do serviço, via seguidor nativo do
supervisor (`journalctl -f`, `pm2 logs --raw`, `docker logs -f`, `tail -F`).

O processo filho roda sem TTY, então o próprio pulsar já desliga as barras de
progresso e passa a imprimir o bloco STATUS — o formato certo para ler dentro
de um painel. `LineBuffer` ainda remove ANSI, converte `\r` em quebra e limita
o histórico em memória.

### Ink no binário compilado

`ink/build/reconciler.js` referencia `react-devtools-core`, e o
`bun build --compile` resolve o import mesmo com o guard `process.env.DEV`.
`--external` não serve (o binário não tem `node_modules` em runtime). Solução:
`src/stubs/react-devtools-core.ts` mapeado por `paths` no tsconfig.

## Verificação

- `test/tuiConfig.test.ts` (27) — build/parse/round-trip de yml, validação,
  plano de transferência, formatação.
- `test/tuiService.test.ts` (25) — units do systemd, plists do launchd,
  ecosystem do pm2, LineBuffer, leitura de log em arquivo.
- `test/tuiInspect.test.ts` (10) — introspecção contra Mongo real.
- Manual, em pty: wizard completo até gravar o yml, `sync` gerado replicando
  dados de verdade, install/start/status/stop/uninstall de um serviço systemd
  real, log ao vivo via journalctl e leitura do `debug.log`.

## Fora de escopo (por ora)

- Editor de `filter`/`filterFile` por collection dentro da TUI. Os filtros de um
  yml aberto são **preservados** ao salvar (`preservedEntries`), mas não editáveis.
- LaunchDaemon em `/Library` (autostart sem login no macOS).
- Múltiplas instâncias docker pela TUI — continua no `pulsar compose up`.
