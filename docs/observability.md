# Observabilidade do CoJam

Guia curto para quem não escreve consulta PromQL, LogQL nem SQL. Todo número
importante já está salvo num painel: não precisa digitar consulta para as
perguntas comuns. Os nomes técnicos de cada série estão em
[`observability-metrics.md`](observability-metrics.md).

## Como abrir o Grafana

O Grafana é o do homelab (repositório `homelab`, serviço `grafana`), o mesmo
do Lucky:

- **De qualquer lugar:** https://grafana.luk-homeserver.com.br (login Google).
- **Pela tailnet:** http://100.95.204.103:3002

Os dashboards ficam na pasta **CoJam** e todos têm a tag `cojam`. Comece por
**CoJam: comece aqui**: de lá dá para abrir os outros três. No topo de cada
dashboard o menu "Dashboards do CoJam" também leva a qualquer um deles.

Os filtros ficam em listas no topo (Método RPC, Provedor, Plataforma, Player).
Para mudar o período use o relógio no canto superior direito. Você nunca
precisa editar uma consulta.

## Os quatro dashboards

- **CoJam: comece aqui**: uma tela só. Servidor no ar, alertas disparando,
  erros no log em 24 horas, pessoas e salas agora, salas criadas hoje,
  dessincronia p95 dos últimos 30 minutos e cota do YouTube. Tudo verde =
  nada a fazer.
- **CoJam: negócio**: salas criadas, entradas e salas com 2+ pessoas, músicas
  por sala, tempo ouvindo junto, pulos (voto, anfitrião, automático),
  curtidas, YouTube vs Spotify, buscas e acerto de cache, provedor conectado e
  retenção semanal (W1 e W4).
- **CoJam: erros**: erros e avisos do log por mensagem, linhas de erro
  recentes, RPCs com erro por método, falhas por provedor, erros do navegador,
  panics, telemetria rejeitada e cota do YouTube.
- **CoJam: sistema**: latência de RPC (p50 e p95 por método), salvar no banco e
  publicar, conexões, goroutines e memória, pool do Postgres, dessincronia por
  plataforma e player, web vitals e limites de taxa.

Todo painel tem uma descrição (ícone de informação no canto) que diz o que é
normal e o que é preocupante.

## Pergunta e onde olhar

| Pergunta | Onde olhar |
| --- | --- |
| O CoJam está no ar? | **comece aqui**, "Servidor no ar" |
| Tem algo quebrado agora? | **comece aqui**, "Alertas disparando" e "Erros no log (24 h)" |
| Por que deu erro? | **erros**, "Erros por mensagem (Top 15)", depois "Linhas de erro recentes" (clique na linha para ver `request_id` e `room_id`) |
| O celular e o PC estão dessincronizados? | **sistema**, "Dessincronia p50 e p95 por plataforma e player"; use o filtro Plataforma |
| A cota do YouTube acabou? | **comece aqui**, "Cota do YouTube"; histórico em **erros**, "Cota do YouTube aberta" |
| Quantas salas hoje? | **comece aqui**, "Salas criadas hoje"; por dia em **negócio** |
| Alguém está usando de verdade, ou só abre e sai? | **negócio**, "Salas que tiveram 2+ pessoas" e "Horas-sala com 2+ pessoas" |
| As pessoas voltam? | **negócio**, "Retenção semanal por coorte (W1 e W4)" |
| O que as pessoas ouvem, YouTube ou Spotify? | **negócio**, "YouTube vs Spotify (origem da faixa)" |
| Pular por voto está sendo usado? | **negócio**, "Pulos por voto, anfitrião e automático" |
| Está lento? | **sistema**, "RPC: p50 e p95 por método" e "Salvar sala no banco" |
| O banco está sofrendo? | **sistema**, "Pool do Postgres" e "Esperas por conexão livre no pool" |
| O servidor vai ficar sem memória? | **sistema**, "Memória" e "Goroutines" |
| O site está lento para quem usa? | **sistema**, "Web vitals (p75)" |
| O YouTube ou o Spotify está falhando? | **erros**, "Falhas por provedor"; filtro Provedor |
| Os números de negócio estão certos? | **erros**, "Eventos descartados" (se maior que 0, o negócio está subcontando) |

## De onde vêm os dados

| Fonte | O que alimenta | Observação |
| --- | --- | --- |
| Prometheus (job `cojam-server`) | servidor no ar, RPC, conexões, salas, banco, provedores, cota, dessincronia, web vitals, telemetria | Séries `music_jam_*`. Reiniciar o servidor zera os contadores; o Prometheus compensa nos gráficos. |
| Loki (container `cojam-server`) | erros e avisos, linhas de erro | O servidor escreve JSON (`slog`). Os painéis filtram pelo texto `"level":"ERROR"`, porque o label `level` do promtail não é confiável. Períodos acima de 30 dias ficam lentos: mantenha 7 dias. |
| Postgres (tabela `product_events`, papel `grafana_ro`) | negócio: salas, entradas, músicas, pulos, curtidas, buscas, retenção | Anônimo: sala e pessoa são hashes. Visitante sem login conta como pessoa nova a cada conexão, então retenção é um piso. Linhas somem após 13 meses. |

A telemetria de dessincronia só aparece com `COJAM_FEATURE_TELEMETRY=true` e
`COJAM_FEATURE_SYNC=true` no site (veja [`configuration.md`](configuration.md)).
Sem isso o painel mostra "sem amostras", e isso não é defeito.

O tempo ouvindo junto é uma aproximação: cada linha `listener_peak` com `n >= 2`
(uma por sala por hora) conta como uma hora-sala. Serve para tendência.

## Editar um dashboard

Os JSON em `observability/grafana/dashboards/` são gerados. Edite
`observability/grafana/build_dashboards.py`, rode

```
python3 observability/grafana/build_dashboards.py
```

e faça commit dos dois. O CI roda `--check` e reprova se o JSON commitado
estiver diferente do gerado. O homelab lê a pasta direto do checkout do CoJam e
o deploy recarrega; editar pela interface do Grafana não é salvo.

## Papel `grafana_ro` no Postgres

Criado por `observability/postgres/grafana-ro.sql` (idempotente; o cabeçalho
do arquivo tem o comando, com a senha pelo stdin). O papel só lê a tabela
`product_events`. Rode de novo depois de restaurar um dump em outro host
(papéis não vão no `pg_dump`) ou se uma migration recriar a tabela. O
datasource do Grafana usa o uid `cojam-postgres`.

## Alertas

Regras em `observability/prometheus/rules/cojam-alerts.rules.yml`, testadas
com `promtool test rules` (arquivo em `rules/tests/`). O nome do arquivo segue
o padrão `cojam-*.rules.yml` que o Prometheus do homelab carrega. Todo alerta
some sozinho quando a causa passa; o painel "Alertas disparando" de **comece
aqui** mostra os ativos.

| Alerta | O que significa | O que fazer |
| --- | --- | --- |
| <a id="cojamserverdown"></a>**CoJamServerDown** (crítico) | O Prometheus não lê o servidor há 5 minutos. | Veja se o container `cojam-server` está de pé (`docker ps`); se caiu, reinicie e leia os logs do último minuto antes da queda. Confira também se o Prometheus alcança a porta de métricas. |
| <a id="cojamrpcerrors"></a>**CoJamRpcErrors** (aviso) | Mais de 5% das ações nas salas falham por culpa do servidor, por 10 minutos (mínimo de 5 falhas). | Em **erros**, "RPCs com erro do servidor por método" mostra o método; "Erros por mensagem" mostra o motivo. Suspeitos: banco fora, deploy recente, provedor caído. |
| <a id="cojamdrifthigh"></a>**CoJamDriftHigh** (aviso) | O p95 da dessincronia passou de 5 s por 10 minutos, com amostras chegando. | Em **sistema**, separe por Plataforma e Player para ver se é só mobile ou só um player. Se começou após um deploy, suspeite do sync do site (`useDriftCorrection`). |
| <a id="cojamyoutubequotaopen"></a>**CoJamYouTubeQuotaOpen** (info) | A cota do YouTube foi recusada e o freio está aberto há 15 minutos; buscas novas falham. | Nada a consertar: a cota diária zera às 04:00 de Brasília. Se repete todo dia, veja "Acerto do cache de busca" em **negócio** e peça mais cota. |
| <a id="cojameventsdropped"></a>**CoJamEventsDropped** (aviso) | Eventos de produto foram descartados (buffer cheio ou erro de banco) nos últimos 15 minutos. | Os painéis de **negócio** estão subcontando. Veja os logs de `events_writer` e o pool do Postgres em **sistema**. O motivo `disabled` não conta. |
| <a id="cojampanics"></a>**CoJamPanics** (crítico) | Uma rotina em segundo plano deu panic nos últimos 10 minutos; o servidor seguiu de pé. | É bug de código. Busque `goroutine_panic` em "Linhas de erro recentes" (o campo `where` diz qual rotina) e abra uma issue com a stack. |
| <a id="cojamplayingwithouttransport"></a>**CoJamPlayingWithoutTransport** (aviso) | Sala achada tocando sem relógio de sincronia nos últimos 30 minutos: regressão do #437. | Busque `transport_absent` e `stale_transport_advanced` nos logs, anote a sala (`room_id`) e verifique se o deploy trouxe o #437 de volta. |

O Watchdog e os alertas de host (memória, disco) vêm da configuração do homelab,
não deste repositório.

## O que depende de outros repositórios

- Os labels `service` e `environment` e o label `container_name` do Loki dependem
  do homelab#496. Os painéis e alertas usam só `job="cojam-server"` e
  `container_name="cojam-server"`.
- O datasource Postgres `cojam-postgres` e a tabela `product_events` chegam com
  o PR #444; sem eles os painéis de **negócio** ficam vazios.
