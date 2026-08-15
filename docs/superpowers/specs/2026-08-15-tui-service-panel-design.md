# Painel de serviços — redesenho da TUI

Data: 2026-08-15
Status: desenhado (não implementado)
Substitui: as telas `Home`, `Services` e `Running` do desenho de 2026-07-28

## Problema

A TUI de hoje tem seis telas (`Home`, `Wizard`, `Runner`, `Services`,
`Running`, `Logs`) e **espalha a operação de serviço por três delas**: o
atalho `b` na `Home` instala num passo, a `Services` escolhe backend e mostra
o plano, a `Running` lista o que está no ar. Três telas respondendo pedaços da
mesma pergunta — "que serviços existem e como mexo neles?" — e nenhuma
respondendo inteira.

Somam-se a isso dois defeitos concretos:

1. **`tab` decide quem escuta o teclado.** Com dois ou três painéis vivos ao
   mesmo tempo, apertar `enter` age sobre o painel em foco, que nem sempre é o
   que a pessoa está olhando. Já produziu o caso de `tab` + `enter` abrir o
   formulário de config nova quando a intenção era abrir o menu de um arquivo.
2. **Sudo falha no fim.** `manager.ts` tem um `if (step.privileged) continue;`:
   passos privilegiados são **pulados** e só depois relatados. O usuário
   configura tudo, manda instalar, espera, e recebe "não deu porque precisa de
   sudo". A informação existia antes de começar e foi guardada até o pior
   momento possível.

## Escopo

Substituir a camada de tela por **um painel único de gerenciamento de
serviços**, com overlays. Nenhuma mudança no comportamento de
`sync`/`migrate`/`ttl` além de passarem a gravar o resultado da execução.

Fora de escopo: o comando `compose up` da CLI, o `docker-compose-limit.yml`, e
a lógica de sincronização em si.

## Decisões

| Decisão | Escolha | Por quê |
|---|---|---|
| Estrutura de tela | Lista raiz + overlays modais | Amarra a ação ao objeto; uma camada dona do teclado por vez |
| Criar config | Formulário único, tudo visível | O passo a passo era o atrito principal relatado |
| Estado do serviço | Registro em `~/.pulsar/services/*.json` | Resultado precisa sobreviver à TUI fechada e à rotação de log |
| Sudo | Preflight + entrega do TTY na hora | Resolver na criação, nunca relatar como pendência no fim |
| One-shot | Auto-desliga o boot ao concluir | `migrate`/`ttl` não devem reexecutar a cada reinício |

## Arquitetura de tela

A tela raiz é a **lista de serviços**, em largura cheia. Selecionar um item
abre um overlay flutuante (`position="absolute"`, suportado pelo Yoga no Ink 7)
por cima da lista. `esc` fecha uma camada e devolve o cursor ao mesmo item.

```
┌─ pulsar ─────────────────────────── sudo ● liberado ─┐
│  ● pulsar-ads-replica   sync     systemd  boot  2h14 │
│  ○ pulsar-loja          sync     docker   boot   —   │
│  ✓ pulsar-limpeza       ttl      systemd    —   10:42│
│  ✗ pulsar-migra-2024    migrate  pm2        —   ontem│
│  ⊘ pulsar-antigo        sync     —  não instalado    │
│                                                       │
│  [n] novo serviço                                     │
└─ ↑↓ navegar · enter abrir · n novo · ? teclas · q sair┘
```

Quatro overlays:

| Overlay | Abre com | Conteúdo |
|---|---|---|
| Detalhe | `enter` num item | Identidade + ações daquele serviço |
| Formulário | `n`, ou `e` no detalhe | Criar/editar serviço e config |
| Logs | `l` | Tela cheia, rolagem, busca, cópia |
| Ajuda | `?` | Teclas da camada atual + globais |

**`tab` deixa de existir como troca de foco.** Com uma lista de largura cheia
e overlays modais, há sempre exatamente um dono do teclado: a camada de cima.
`esc` fecha uma camada, `q` sai só na raiz, `ctrl+d` sai de qualquer lugar.

### Layout

`src/tui/layout.ts` ganha `overlay(columns, rows)` — matemática pura, testável
sem montar componente, como a função `layout()` existente. Centraliza a caixa
com margem, e abaixo de 60 colunas o overlay passa a ocupar 100% da largura em
vez de virar uma caixa ilegível. `Shell.tsx` ganha uma prop `overlay` para que
nenhuma tela remonte o próprio chrome.

## Estado

### Registro

Um arquivo por serviço em `~/.pulsar/services/<nome>.json`, gravado
atomicamente (tmp + rename, como o `writeConfig` atual):

```json
{
  "name": "pulsar-migra-2024",
  "mode": "migrate",
  "config": "/home/padawan/projects/mongo/bryan/pulsar/migra.yml",
  "workingDir": "/home/padawan/projects/mongo/bryan/pulsar",
  "backend": "systemd",
  "boot": false,
  "createdBy": "pulsar-tui",
  "lastRun": {
    "startedAt": "2026-08-15T10:02:11Z",
    "endedAt": "2026-08-15T10:47:03Z",
    "status": "ok",
    "exitCode": 0,
    "stats": {
      "collections": 49,
      "inserted": 1214882,
      "updated": 0,
      "skipped": 331,
      "indexes": 12,
      "views": 3
    },
    "error": null
  }
}
```

`status` é um de `ok` | `error` | `running`. `stats` é um objeto livre por
modo: o `sync` grava os contadores do painel final, o `ttl` grava índices
criados e docs materializados, o `migrate` grava collections e documentos.

**Registro corrompido ou ilegível nunca derruba a lista** — o serviço aparece
como `adotado` e a leitura segue para os demais arquivos.

### Quem escreve

- **A TUI** grava identidade (modo, yml, backend, boot) ao criar, editar ou
  trocar backend.
- **O próprio processo do pulsar** grava `lastRun` ao terminar, via um módulo
  novo `core/state/runRecord.ts` chamado no fim de `commands/sync.ts`,
  `commands/migrate.ts` e `commands/ttl.ts`.

A segunda metade é o que faz o recurso existir: o serviço roda no boot às 3h
da manhã com a TUI fechada, e o resultado precisa estar lá quando ela abrir.
Os números já existem — hoje viram texto no painel final e se perdem. O
`runRecord` recebe o mesmo objeto que alimenta o painel e serializa.

### Reconciliação

A lista é o cruzamento do registro (significado) com `discoverServices()`
(verdade viva). Quatro casos, todos visíveis:

| Situação | Estado exibido | Ações |
|---|---|---|
| Registro + supervisor | `● no ar` / `○ parado` | todas |
| Supervisor sem registro | `adotado` | iniciar, parar, logs, remover, **adotar** |
| Registro sem supervisor | `⊘ não instalado` | reinstalar do registro, descartar |
| One-shot terminado | `✓ concluído` / `✗ erro` | ver resultado, ver erro, rodar de novo |

**Adotar** reconstrói o registro lendo o próprio supervisor: o `ExecStart` da
unit systemd, o `command` do container e os `args` do ecosystem do pm2 contêm
o caminho do yml e o modo. Serviço criado por versão anterior da TUI, ou à
mão, não vira órfão sem gerência.

## Fluxos

### Formulário único

Um componente `ServiceForm`, o mesmo para criar e editar (editar é o form com
os campos preenchidos). Todos os campos visíveis ao mesmo tempo, navegação
livre por `↑↓` e clique. Não há "próximo".

Blocos:

1. **Identidade** — nome do serviço, modo (`sync`/`migrate`/`ttl`).
2. **O quê** — config pronta (`Select` dos ymls encontrados) ou `— definir
   aqui —`; origem, destino, collections, views, índices.
3. **Como rodar** — backend, boot.

A lista de ymls do campo "config pronta" vem da varredura recursiva que já
existe (a mesma da `Home` atual, com seus tetos de profundidade, pastas
ignoradas e tempo), a partir da pasta em que a TUI foi aberta. A **lista de
serviços**, ao contrário, é global à máquina: serviço não pertence a uma
pasta, e abrir a TUI em outro diretório não pode fazer serviços sumirem.

O campo **origem** conecta ao perder o foco (com debounce). É a conexão que
destrava os campos dependentes: `banco` vira um `Select` com os bancos reais e
seus tamanhos (via `dbStats`, já implementado), e `collections`/`views`/
`índices` viram contadores clicáveis que abrem o `CollectionPicker` existente,
com a busca `/` visível. Sem conexão, esses campos ficam **apagados com o
motivo ao lado** ("informe a origem") em vez de sumirem, e as collections
podem ser digitadas à mão.

**Serviço sempre aponta para um arquivo yml**, nunca guarda config embutida.
Escolhendo `— definir aqui —`, o pulsar grava um yml novo (nome escolhido no
form) e vincula. Isso preserva `pulsar sync arquivo.yml` fora da TUI e mantém
"editar config" como edição de um arquivo real.

Backend indisponível aparece **desabilitado, com motivo e conserto** — os dois
já vêm de `detect.ts` (`reason` e `fix`) e hoje são descartados.

### Sudo

Só três passos em todo o código pedem root, e os três são sobre boot:
`loginctl enable-linger` (systemd, apenas como fallback quando o passo sem
sudo falha), `systemctl enable docker`, e `pm2 startup`.

Três momentos, nesta ordem:

1. **Ao marcar `no boot`** — o form já sabe se aquele backend exige root nesta
   máquina e avisa ali: `⚠ vai precisar de sudo (1 comando)`.
2. **Ao criar, antes de gravar qualquer arquivo** — roda `sudo -n true`. Se
   passa, os passos privilegiados executam junto com os demais, sem
   interrupção.
3. **Se pede senha** — a instalação para no ponto exato, mostra o comando
   literal, e espera: `enter` digita a senha agora, `p` pula.

No `enter`, a TUI **larga o terminal**: sai do alternate screen (`\x1b[?1049l`),
desliga o rastreio de mouse e o raw mode, entrega o TTY ao `sudo` com
`stdio: "inherit"`, aguarda, e restaura tudo em `finally`. A restauração em
`finally` não é opcional — falhar ali deixa o terminal do usuário com o eco
desligado.

O `if (step.privileged) continue;` de `manager.ts:177` sai. No lugar entra
`core/service/privileged.ts`, que recebe um callback `onNeedsTerminal`. O
`manager` continua sem saber o que é uma TUI, e os testes continuam rodando
sem TTY.

Pulando com `p`, **o serviço é criado e sobe mesmo assim**; apenas o boot fica
pendente, e isso vira estado visível no detalhe (`boot: pendente — 1 comando
com sudo`) com atalho para resolver depois. O que deixa de acontecer é
descobrir a pendência no fim.

### One-shot

`migrate` e `ttl` terminam. Ao concluir **com sucesso**, o processo desabilita
o próprio autostart antes de sair e carimba `boot: false` no registro:

| Backend | Comando |
|---|---|
| systemd | `systemctl --user disable <nome>` |
| docker | `docker update --restart=no <nome>` |
| pm2 | `pm2 delete <nome>` + `pm2 save` |
| launchd | remove o `RunAtLoad` do plist e recarrega |

Duas travas: só acontece se o registro disser `createdBy: "pulsar-tui"`, e só
no sucesso. **Erro não desliga nada** — desligar no erro tiraria a retentativa
sem o usuário perceber. Unidade one-shot nasce com `Restart=no`, então um erro
para e fica com a flag em vez de entrar em laço de restart.

No detalhe, `✓ concluído` oferece **ver resultado** (os `stats` do `lastRun`
formatados por modo) e `✗ erro` oferece **ver erro** (comando, código de saída
e cauda da saída).

### Trocar modo de inicialização

Uma ação única no detalhe: escolhe o novo backend, o pulsar mostra o plano
(remover do antigo → gravar no novo → subir) e executa. Nome, yml e estado de
boot são preservados; serviço que estava no ar volta no ar. **Se o novo
backend falhar no meio, reinstala no antigo** em vez de deixar o usuário sem
serviço nenhum.

### Logs em tela cheia

`l` abre o log ocupando 100% da tela — sem sidebar, sem painel de contexto,
sem chrome; só conteúdo e uma linha de teclas. A fonte é escolhida pelo
backend (`journalctl -f`, `docker logs -f`, `pm2 logs`, `tail -F`), mais os
`./logs/*.log` gravados.

| Tecla | Ação |
|---|---|
| `↑↓` `PgUp/PgDn` `g` `G` | rolar linha, página, topo, fim |
| `f` | seguir (auto-scroll); desliga sozinho ao rolar para cima |
| `/`, `n`, `N` | buscar e pular entre ocorrências |
| `ctrl+c` | copia a linha em foco (OSC 52) |
| `Y` | copia tudo que está na tela |
| `m` | desliga o mouse |
| `esc` | fecha |

O mouse nasce **ligado** (roda rola o log). Rastrear cliques rouba a seleção
nativa do terminal — não há como ter as duas — então `m` existe para devolvê-la,
e `ctrl+c`/`Y` cobrem a cópia via OSC 52, que funciona através de SSH.

### Ajuda

`?` abre um overlay com todas as teclas; `esc` fecha. É **contextual**: mostra
as teclas da camada atual, com as globais no rodapé. `?` na lista mostra as da
lista; com o detalhe aberto, as ações daquele serviço; no log, rolagem, busca
e cópia.

A fonte é a **mesma** lista de `hints` que cada camada já declara ao `Shell`:
a barra mostra as principais, o `?` mostra todas, agrupadas. Não há dois
lugares para manter em dia — é assim que help de terminal apodrece.

`?` é o único caso em que `esc` não volta uma camada: fecha a ajuda e devolve
o usuário onde estava.

## Erros

Toda operação de serviço (criar, iniciar, trocar backend, remover) roda com
saída em streaming, reusando o `execStep` atual. O que muda é o destino:
falha deixa de ser uma linha vermelha que some e vira **estado no item da
lista** (`✗ erro`), com atalho para comando exato, código de saída e cauda da
saída. Erro em um serviço nunca derruba o painel nem bloqueia os outros.

## Testes

Lógica pura, testável sem TTY nem supervisor — o padrão que
`test/tuiService.test.ts` e `test/compose.test.ts` já seguem:

| Módulo | O que cobre |
|---|---|
| `core/state/registry.ts` | ler, gravar, atomicidade; registro corrompido não derruba a lista |
| `core/state/reconcile.ts` | os quatro casos da tabela, com `discoverServices()` mockado |
| `core/state/adopt.ts` | extrair yml e modo do `ExecStart`, do `command` e do ecosystem |
| `core/state/runRecord.ts` | serialização dos stats por modo; escrita atômica |
| `core/service/oneshot.ts` | desliga o boot só com `createdBy` do pulsar **e** status `ok` |
| `core/service/privileged.ts` | decide entre rodar direto, pedir senha ou pular, com `sudo -n` mockado |
| `tui/layout.ts` | geometria do overlay, inclusive em terminal estreito |
| `tui/keys.ts` | toda tecla tratada está anunciada — o teste que mantém o `?` honesto |

Dois pontos **não** são cobertos por teste automatizado: a entrega e a
retomada do TTY para o sudo, e o desenho do overlay. Ambos entram num roteiro
de verificação manual em `tmux`, executado antes de declarar o trabalho
pronto.

## O que sai do código

- `src/tui/screens/Home.tsx`
- `src/tui/screens/Services.tsx`
- `src/tui/screens/Running.tsx`
- `src/tui/hooks/useBackgroundStart.ts` (o atalho `b` perde sentido quando
  criar serviço é a operação principal)
- O roteador de seis rotas do `App.tsx` e o `tab` de troca de foco
- `src/tui/screens/Wizard.tsx` como wizard

Os sub-componentes do wizard (`CollectionPicker`, `EntryPicker`, os passos de
views e índices, `SearchField`) são **reaproveitados dentro do formulário
único** — o trabalho é recente e continua bom; deixa apenas de ser sequência.

## O que não muda

`discover.ts`, `manager.ts` (exceto o tratamento de passo privilegiado), os
quatro backends, `detect.ts`, `logLines.ts`, `readLog`, `tailCommand`,
`useProcess`, e os componentes `Select`, `TextInput`, `SearchField`,
`CollectionPicker`. O redesenho é da camada de tela; o núcleo de serviço passa
a ser chamado de um lugar só.

## Riscos

1. **Entregar e retomar o TTY sob o Ink** é a parte mais arriscada. Se a
   restauração falhar, o terminal fica sem eco. Mitigação: `finally`
   incondicional, e este é o primeiro item da implementação, não o último.
2. **Overlay absoluto no Ink 7** é suportado pelo Yoga, mas a composição de
   caixas sobrepostas precisa ser verificada cedo, com uma prova concreta
   antes de o resto do painel depender dela.
3. **Auto-desligar o boot** é um processo reconfigurando o próprio supervisor.
   As duas travas (`createdBy` e `status: ok`) são o que impede isso de
   surpreender quem criou o serviço à mão.
