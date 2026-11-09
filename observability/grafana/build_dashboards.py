#!/usr/bin/env python3
"""Generate CoJam's Grafana dashboards into observability/grafana/dashboards/.

Run `python3 observability/grafana/build_dashboards.py` after editing and commit
the generated JSON with this file. `--check` regenerates in memory and fails if
the committed JSON differs (CI runs it). Stdlib only.

Prometheus and Loki are referenced through hidden datasource variables
(ds_prometheus, ds_loki) so the same JSON loads in any Grafana. Postgres uses
the fixed datasource uid `cojam-postgres` (role grafana_ro, table product_events).
"""
import json
import sys
from pathlib import Path

OUT = Path(__file__).parent / "dashboards"

P = {"type": "prometheus", "uid": "${ds_prometheus}"}
L = {"type": "loki", "uid": "${ds_loki}"}
PG = {"type": "grafana-postgresql-datasource", "uid": "cojam-postgres"}

JOB = 'job="cojam-server"'
SRV = '{container_name="cojam-server"}'
M = "music_jam_"
# Line filters first, parse second: json over 7 days of every line is slow.
ERR = '|= `"level":"ERROR"`'
WARN = '|= `"level":"WARN"`'
LVL = '|~ `"level":"(ERROR|WARN)"` | json msg="msg", level="level"'

RED, ORANGE, GREEN = "red", "orange", "green"
# Hora local do Brasil para "hoje".
DAY0 = "(date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')"


def thresholds(*steps):
    """steps: (color, value) pairs; the first value is ignored (base)."""
    return {"mode": "absolute", "steps": [{"color": c, "value": (None if i == 0 else v)} for i, (c, v) in enumerate(steps)]}


def prom(expr, legend="", instant=False):
    return {"datasource": P, "expr": expr, "legendFormat": legend, "instant": instant, "range": not instant}


def loki(expr, legend="", instant=False):
    return {"datasource": L, "expr": expr, "legendFormat": legend, "queryType": "instant" if instant else "range"}


def sql(raw, fmt="table"):
    return {"datasource": PG, "rawSql": raw, "format": fmt, "rawQuery": True, "editorMode": "code"}


def prom_var(name, label, query, desc):
    return {"name": name, "label": label, "description": desc, "type": "query", "datasource": P, "refresh": 2, "hide": 0,
            "definition": query, "query": {"query": query, "refId": "v"}, "includeAll": True, "multi": True, "allValue": ".*",
            "current": {"selected": True, "text": ["All"], "value": ["$__all"]}, "sort": 1, "options": []}


def custom_var(name, label, values, desc):
    csv = ",".join(values)
    return {"name": name, "label": label, "description": desc, "type": "custom", "hide": 0, "query": csv,
            "includeAll": True, "allValue": csv, "multi": True, "current": {"selected": True, "text": ["All"], "value": ["$__all"]},
            "options": []}


class Board:
    def __init__(self, uid, title, description, time_from="now-7d", tags=()):
        self.uid, self.title, self.description, self.time_from = uid, title, description, time_from
        self.tags = ["cojam", *tags]
        self.panels, self.vars, self.x, self.y, self.row_h = [], [], 0, 0, 0

    def _place(self, w, h):
        if self.x + w > 24:
            self.x, self.y, self.row_h = 0, self.y + self.row_h, 0
        pos = {"x": self.x, "y": self.y, "w": w, "h": h}
        self.x += w
        self.row_h = max(self.row_h, h)
        return pos

    def row(self, title):
        if self.x:
            self.x, self.y, self.row_h = 0, self.y + self.row_h, 0
        self.panels.append({"type": "row", "title": title, "collapsed": False, "panels": [], "gridPos": {"x": 0, "y": self.y, "w": 24, "h": 1}})
        self.y += 1

    def add(self, ptype, title, targets, w=6, h=6, desc="", unit=None, th=None, options=None,
            no_value=None, decimals=None, mappings=None, custom=None, overrides=None, transformations=None):
        defaults = {}
        if unit:
            defaults["unit"] = unit
        if th:
            defaults["thresholds"] = th
            defaults["color"] = {"mode": "thresholds"}
        if no_value is not None:
            defaults["noValue"] = no_value
        if decimals is not None:
            defaults["decimals"] = decimals
        if mappings:
            defaults["mappings"] = mappings
        if custom:
            defaults["custom"] = custom
        for i, t in enumerate(targets):
            t["refId"] = chr(65 + i)
        panel = {
            "type": ptype, "title": title, "description": desc, "gridPos": self._place(w, h),
            "datasource": targets[0]["datasource"] if targets else None, "targets": targets,
            "fieldConfig": {"defaults": defaults, "overrides": overrides or []},
            "options": options or {},
        }
        if transformations:
            panel["transformations"] = transformations
        self.panels.append(panel)

    def stat(self, title, target, desc="", unit=None, th=None, w=4, h=4, **kw):
        opts = {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                "colorMode": "background" if th else "value", "graphMode": "none", "textMode": "auto"}
        self.add("stat", title, [target], w=w, h=h, desc=desc, unit=unit, th=th, options=opts, **kw)

    def text(self, title, md, w=24, h=4):
        self.panels.append({"type": "text", "title": title, "gridPos": self._place(w, h), "options": {"mode": "markdown", "content": md}})

    def json(self):
        ds_vars = [("ds_prometheus", "prometheus", "/^Prometheus$/"), ("ds_loki", "loki", "")]
        templating = [{"name": n, "type": "datasource", "query": q, "regex": r, "hide": 2, "refresh": 1,
                       "current": {}, "options": [], "includeAll": False, "multi": False} for n, q, r in ds_vars]
        templating += self.vars
        for i, p in enumerate(self.panels, start=1):
            p["id"] = i
        return {
            "uid": self.uid, "title": self.title, "description": self.description, "tags": self.tags,
            "timezone": "browser", "editable": True, "graphTooltip": 1, "schemaVersion": 39,
            "time": {"from": self.time_from, "to": "now"}, "refresh": "5m",
            "templating": {"list": templating}, "annotations": {"list": []},
            "links": [{"type": "dashboards", "tags": ["cojam"], "asDropdown": False, "title": "Dashboards do CoJam",
                       "includeVars": False, "keepTime": True, "targetBlank": False, "icon": "external link"}],
            "panels": self.panels,
        }


def top_table(title, expr, no_value, color, desc=""):
    """Grafana merges Loki instant frames into one table: Top N is a table sorted by count."""
    return dict(ptype="table", title=title, targets=[loki(expr, instant=True)], w=12, h=9, desc=desc,
                no_value=no_value, th=thresholds((color, 0)),
                options={"showHeader": True, "cellHeight": "sm", "footer": {"show": False}},
                transformations=[
                    {"id": "organize", "options": {"excludeByName": {"Time": True},
                                                   "renameByName": {"msg": "Mensagem", "Value #A": "Vezes"},
                                                   "indexByName": {"msg": 0, "Value #A": 1}}},
                    {"id": "sortBy", "options": {"sort": [{"field": "Vezes", "desc": True}]}}],
                overrides=[{"matcher": {"id": "byName", "options": "Vezes"},
                            "properties": [{"id": "custom.width", "value": 110}, {"id": "custom.cellOptions", "value": {"type": "color-text"}}]}])


UP_MAP = [{"type": "value", "options": {"0": {"text": "FORA", "color": RED}, "1": {"text": "NO AR", "color": GREEN}}}]
BARS = {"drawStyle": "bars", "fillOpacity": 80, "lineWidth": 1, "stacking": {"mode": "normal", "group": "A"}}
BARS_FLAT = {**BARS, "stacking": {"mode": "none"}}
LINES = {"drawStyle": "line", "fillOpacity": 10, "lineWidth": 2, "showPoints": "never"}
TS_OPTS = {"legend": {"displayMode": "list", "placement": "bottom", "showLegend": True}, "tooltip": {"mode": "multi", "sort": "desc"}}
STATE_OPTS = {"showValue": "never", "legend": {"showLegend": False}}

FIRING = 'count(ALERTS{alertstate="firing", alertname=~"CoJam.*"}) or vector(0)'


def quant(q, bucket, by="le", window="$__rate_interval", sel=""):
    return f"histogram_quantile({q}, sum by ({by}) (rate({M}{bucket}_bucket{{{JOB}{sel}}}[{window}])))"


def ev(name, extra=""):
    """SQL fragment: product_events rows of one event inside the dashboard time range."""
    return f"FROM product_events WHERE name = '{name}' AND $__timeFilter(at){extra}"


# --------------------------------------------------------------------------- comece aqui
def inicio():
    b = Board("cojam-inicio", "CoJam: comece aqui",
              "Resumo de uma tela: o CoJam está no ar, está sendo usado e está com erro?", "now-24h", ("inicio",))
    b.text("Como usar", (
        "**Tudo verde = nada a fazer.** Cada número tem uma explicação no ícone de informação do painel.\n\n"
        "- **[CoJam: negócio](/d/cojam-negocio)**: salas, quem entra, o que toca, pulos, retenção.\n"
        "- **[CoJam: erros](/d/cojam-erros)**: erros nos logs, RPCs que falharam, provedores, navegador, cota do YouTube.\n"
        "- **[CoJam: sistema](/d/cojam-sistema)**: latência, conexões, memória, banco, dessincronia, web vitals.\n\n"
        "Dúvida de como ler algo? Veja `docs/observability.md` (tabela \"Pergunta e onde olhar\")."), h=5)
    b.stat("Servidor no ar", prom(f"max(up{{{JOB}}}) or vector(0)", instant=True), mappings=UP_MAP,
           th=thresholds((RED, 0), (GREEN, 1)), w=4,
           desc="Normal: NO AR. Preocupante: FORA por mais de 5 minutos (o alerta CoJamServerDown dispara).")
    b.stat("Alertas disparando", prom(FIRING, instant=True), th=thresholds((GREEN, 0), (RED, 1)), w=4,
           desc="Normal: 0. Preocupante: qualquer valor acima de 0. Cada alerta tem um passo a passo em docs/observability.md.")
    b.stat("Erros no log (24 h)", loki(f"sum(count_over_time({SRV} {ERR} [24h])) or vector(0)", instant=True),
           th=thresholds((GREEN, 0), (ORANGE, 1), (RED, 20)), w=4,
           desc="Linhas de erro do servidor nas últimas 24 horas. Normal: 0 ou poucos. Preocupante: dezenas ou o mesmo erro se repetindo. Abra CoJam: erros.")
    b.stat("Pessoas conectadas agora", prom(f"sum({M}connections_active{{{JOB}}}) or vector(0)", instant=True), w=4,
           desc="Conexões abertas neste instante (uma pessoa com duas abas conta 2). 0 de madrugada é normal.")
    b.stat("Salas ativas agora", prom(f"sum({M}rooms_active{{{JOB}}}) or vector(0)", instant=True), w=4,
           desc="Salas carregadas na memória do servidor, inclusive vazias até o descarte automático.")
    b.stat("Salas criadas hoje", sql(f"SELECT count(*) AS \"Salas\" FROM product_events WHERE name = 'room_created' AND at >= {DAY0}"),
           w=4, no_value="0", desc="Desde a meia-noite de Brasília. Fonte: eventos de produto no Postgres.")
    b.stat("Dessincronia p95 (30 min)", prom(quant(0.95, "sync_drift_seconds", window="30m"), instant=True), unit="s", decimals=2,
           th=thresholds((GREEN, 0), (ORANGE, 1.5), (RED, 5)), w=6, no_value="sem amostras",
           desc="95% das pessoas estão com diferença menor que este valor entre o que ouvem e o que deveriam ouvir. Normal: abaixo de 1,5 s. Preocupante: acima de 5 s. Sem amostras = ninguém ouvindo ou telemetria desligada.")
    b.stat("Cota do YouTube", prom(f"max({M}youtube_quota_open{{{JOB}}}) or vector(0)", instant=True), w=6,
           mappings=[{"type": "value", "options": {"0": {"text": "OK", "color": GREEN}, "1": {"text": "ABERTA (busca bloqueada)", "color": ORANGE}}}],
           th=thresholds((GREEN, 0), (ORANGE, 1)),
           desc="Aberta = o YouTube recusou por cota e o servidor parou de buscar. A cota diária zera às 04:00 de Brasília. Veja CoJam: erros para o histórico.")
    return b


# --------------------------------------------------------------------------- negócio
def negocio():
    b = Board("cojam-negocio", "CoJam: negócio",
              "Uso real do CoJam: salas, entradas, o que toca, pulos e retenção. Fonte: tabela product_events (Postgres, somente leitura).",
              "now-30d", ("negocio",))
    b.vars.append(custom_var("provedor", "Provedor da faixa", ["youtube", "spotify", "other"],
                             "Filtra os painéis de faixas tocadas por provedor de origem da faixa."))
    b.text("Leia antes", (
        "Todos os números vêm de eventos anônimos gravados pelo servidor (sala e pessoa viram hash; não há IP, apelido nem texto de chat). "
        "**Visitante sem login conta como uma pessoa nova a cada conexão**, então retenção é piso, não valor exato. "
        "O período é o seletor de tempo no topo (padrão 30 dias)."), h=3)

    b.row("Salas e pessoas")
    b.stat("Salas criadas", sql("SELECT count(*) AS \"Salas\" " + ev("room_created")), w=4, no_value="0")
    b.stat("Entradas em salas", sql("SELECT count(*) AS \"Entradas\" " + ev("room_joined")), w=4, no_value="0",
           desc="Cada vez que alguém entra numa sala (inclui o criador).")
    b.stat("Salas que tiveram 2+ pessoas", sql("SELECT count(DISTINCT room_hash) AS \"Salas\" " + ev("listener_peak", " AND (props->>'n')::int >= 2")),
           w=4, no_value="0", desc="Salas com pico de ao menos 2 pessoas juntas numa hora. É o que separa \"abriu\" de \"usou de verdade\".")
    b.stat("Músicas tocadas", sql("SELECT count(*) AS \"Músicas\" " + ev("track_started")), w=4, no_value="0")
    b.stat("Curtidas", sql("SELECT count(*) AS \"Curtidas\" " + ev("track_liked")), w=4, no_value="0")
    b.stat("Horas-sala com 2+ pessoas", sql("SELECT count(*) AS \"Horas\" " + ev("listener_peak", " AND (props->>'n')::int >= 2")),
           w=4, no_value="0",
           desc="Aproximação do tempo ouvindo junto: cada linha listener_peak com n>=2 é uma hora em que a sala teve pico de 2 ou mais pessoas. Superestima salas que só encostaram no 2 e subestima quem ficou sozinho.")
    b.add("timeseries", "Salas criadas, entradas e salas com 2+ pessoas por dia", [
        sql("SELECT date_trunc('day', at) AS time, count(*) FILTER (WHERE name = 'room_created') AS \"Salas criadas\", "
            "count(*) FILTER (WHERE name = 'room_joined') AS \"Entradas\", "
            "count(DISTINCT room_hash) FILTER (WHERE name = 'listener_peak' AND (props->>'n')::int >= 2) AS \"Salas com 2+ pessoas\" "
            "FROM product_events WHERE name IN ('room_created','room_joined','listener_peak') AND $__timeFilter(at) GROUP BY 1 ORDER BY 1", "time_series")],
        w=12, h=8, custom=BARS_FLAT, options=TS_OPTS,
        desc="Normal: entradas maiores que salas criadas e algumas salas com 2+ pessoas. Preocupante: salas criadas sem entradas de outras pessoas (ninguém convida) ou nenhuma sala com 2+.")
    b.add("timeseries", "Horas-sala com 2+ pessoas por dia (tempo ouvindo junto)", [
        sql("SELECT date_trunc('day', at) AS time, count(*) AS \"Horas-sala\" " + ev("listener_peak", " AND (props->>'n')::int >= 2") + " GROUP BY 1 ORDER BY 1", "time_series")],
        w=12, h=8, custom=BARS_FLAT, options=TS_OPTS,
        desc="Aproximação: conta horas em que a sala teve pico de 2+ pessoas, não minutos exatos. Use para ver tendência, não para faturar.")

    b.row("Músicas")
    b.add("timeseries", "Músicas por sala por dia", [
        sql("SELECT date_trunc('day', at) AS time, round(count(*)::numeric / nullif(count(DISTINCT room_hash), 0), 1) AS \"Músicas por sala\" "
            + ev("track_started") + " GROUP BY 1 ORDER BY 1", "time_series")],
        w=8, h=8, custom={**LINES, "showPoints": "always"}, options=TS_OPTS,
        desc="Média de músicas iniciadas por sala que tocou algo no dia. Normal: acima de 3. Preocupante: perto de 1 (a sala toca uma música e acaba).")
    b.add("timeseries", "YouTube vs Spotify (origem da faixa)", [
        sql("SELECT date_trunc('day', at) AS time, coalesce(props->>'provider', 'other') AS metric, count(*) AS value "
            + ev("track_started", " AND coalesce(props->>'provider', 'other') = ANY(string_to_array('${provedor:csv}', ','))")
            + " GROUP BY 1, 2 ORDER BY 1", "time_series")],
        w=8, h=8, custom=BARS, options=TS_OPTS,
        desc="Provedor da faixa quando ela começa. A escolha de onde a pessoa ouve (Ouvir no) é do navegador e o servidor não vê. Dropdown Provedor filtra.")
    b.add("timeseries", "Origem da música (manual, autoplay, rádio, histórico)", [
        sql("SELECT date_trunc('day', at) AS time, coalesce(props->>'source', 'desconhecida') AS metric, count(*) AS value "
            + ev("track_started", " AND coalesce(props->>'provider', 'other') = ANY(string_to_array('${provedor:csv}', ','))")
            + " GROUP BY 1, 2 ORDER BY 1", "time_series")],
        w=8, h=8, custom=BARS, options=TS_OPTS,
        desc="manual = alguém escolheu; autoplay = veio depois de outra; rádio e histórico = vieram da origem da faixa. Muito autoplay e pouco manual = sala deixada tocando sozinha.")

    b.row("Pulos e curtidas")
    b.add("timeseries", "Pulos por voto, anfitrião e automático", [
        sql("SELECT date_trunc('day', at) AS time, CASE props->>'by' WHEN 'vote' THEN 'Por voto' WHEN 'host' THEN 'Anfitrião' WHEN 'auto' THEN 'Automático' ELSE 'Outro' END AS metric, "
            "count(*) AS value " + ev("track_skipped") + " GROUP BY 1, 2 ORDER BY 1", "time_series")],
        w=12, h=8, custom=BARS, options=TS_OPTS,
        desc="Automático = a faixa não tocou e o servidor pulou. Muito automático = problema de fonte (veja CoJam: erros). Por voto = a sala decidiu junta.")
    b.add("timeseries", "Curtidas por dia", [
        sql("SELECT date_trunc('day', at) AS time, count(*) AS \"Curtidas\" " + ev("track_liked") + " GROUP BY 1 ORDER BY 1", "time_series")],
        w=6, h=8, custom=BARS_FLAT, options=TS_OPTS)
    b.add("timeseries", "Pulos por voto (contador do servidor)", [
        prom(f"sum(increase({M}skips_by_vote_total{{{JOB}}}[$__rate_interval]))", "pulos por voto"),
        prom(f"sum(increase({M}skip_votes_total{{{JOB}}}[$__rate_interval]))", "votos para pular")],
        w=6, h=8, custom=BARS_FLAT, options=TS_OPTS, desc="Dados do Prometheus (reinicia a contagem quando o servidor reinicia). Votos muito acima de pulos = a sala vota e não chega ao limite.")

    b.row("Buscas e provedores")
    b.stat("Acerto do cache de busca", sql(
        "SELECT round(100.0 * count(*) FILTER (WHERE props->>'cache_hit' = 'true') / nullif(count(*), 0), 1) AS \"Acerto (%)\" "
        + ev("search", " AND props->>'provider' IN ('youtube','spotify')")),
        unit="percent", th=thresholds((RED, 0), (ORANGE, 30), (GREEN, 60)), w=6, no_value="sem buscas",
        desc="Das buscas por fonte (YouTube e Spotify), quantas foram respondidas sem gastar cota. Normal: acima de 60%. Baixo = cota do YouTube vai acabar cedo.")
    b.add("timeseries", "Buscas por dia", [
        sql("SELECT date_trunc('day', at) AS time, coalesce(props->>'provider', 'outro') || CASE WHEN props->>'cache_hit' = 'true' THEN ' (cache)' ELSE '' END AS metric, count(*) AS value "
            + ev("search") + " GROUP BY 1, 2 ORDER BY 1", "time_series")],
        w=9, h=8, custom=BARS, options=TS_OPTS,
        desc="catalog = busca digitada na tela; youtube e spotify = resolução de fonte. Para catalog o cache_hit não é medido.")
    b.add("timeseries", "Provedor conectado por dia", [
        sql("SELECT date_trunc('day', at) AS time, coalesce(props->>'provider', 'outro') AS metric, count(*) AS value "
            + ev("provider_connected") + " GROUP BY 1, 2 ORDER BY 1", "time_series")],
        w=9, h=8, custom=BARS, options=TS_OPTS, desc="Pessoas que conectaram a conta do Spotify. Zero por semanas = ninguém usa o Spotify ou o fluxo quebrou.")

    b.row("Retenção")
    b.add("table", "Retenção semanal por coorte (W1 e W4)", [sql(
        "WITH a AS (SELECT actor_hash, date_trunc('week', at) AS w FROM product_events WHERE actor_hash IS NOT NULL GROUP BY 1, 2), "
        "f AS (SELECT actor_hash, min(w) AS c FROM a GROUP BY 1) "
        "SELECT f.c::date AS \"Semana de entrada\", count(*) AS \"Pessoas\", "
        "round(100.0 * count(*) FILTER (WHERE f.c + interval '2 weeks' <= now() AND EXISTS "
        "(SELECT 1 FROM a x WHERE x.actor_hash = f.actor_hash AND x.w = f.c + interval '1 week')) "
        "/ nullif(count(*) FILTER (WHERE f.c + interval '2 weeks' <= now()), 0), 1) AS \"Voltou na semana 1 (%)\", "
        "round(100.0 * count(*) FILTER (WHERE f.c + interval '5 weeks' <= now() AND EXISTS "
        "(SELECT 1 FROM a x WHERE x.actor_hash = f.actor_hash AND x.w = f.c + interval '4 weeks')) "
        "/ nullif(count(*) FILTER (WHERE f.c + interval '5 weeks' <= now()), 0), 1) AS \"Voltou na semana 4 (%)\" "
        "FROM f WHERE f.c > now() - interval '16 weeks' GROUP BY 1 ORDER BY 1 DESC")],
        w=24, h=9, no_value="sem dados de coorte",
        desc="Coorte = semana (segunda a domingo, UTC) em que a pessoa apareceu pela primeira vez. W1 = % que voltou na semana seguinte; W4 = % que voltou 4 semanas depois. Vazio enquanto a semana ainda não fechou. Visitante sem login vira outra pessoa a cada conexão, então o número é um piso. Bom: W1 acima de 20%.",
        overrides=[{"matcher": {"id": "byRegexp", "options": "Voltou.*"},
                    "properties": [{"id": "unit", "value": "percent"}, {"id": "custom.cellOptions", "value": {"type": "color-background"}},
                                   {"id": "thresholds", "value": thresholds((RED, 0), (ORANGE, 10), (GREEN, 20))}]}])
    return b


# --------------------------------------------------------------------------- erros
def erros():
    b = Board("cojam-erros", "CoJam: erros",
              "O que deu errado, onde e quantas vezes. Logs do servidor (Loki) e contadores (Prometheus).", "now-7d", ("erros",))
    b.vars.append(prom_var("metodo", "Método RPC", f"label_values({M}rpc_duration_seconds_count{{{JOB}}}, method)",
                           "Filtra o painel de RPCs com erro por método."))
    b.vars.append(prom_var("provedor", "Provedor", f"label_values({M}provider_requests_total{{{JOB}}}, provider)",
                           "Filtra o painel de falhas por provedor (youtube, spotify, deezer...)."))
    b.stat("Erros no log", loki(f"sum(count_over_time({SRV} {ERR} [$__range])) or vector(0)", instant=True),
           th=thresholds((GREEN, 0), (ORANGE, 1), (RED, 20)), w=4, desc="Linhas de erro do servidor no período. Normal: 0. Preocupante: dezenas ou crescendo.")
    b.stat("Avisos no log", loki(f"sum(count_over_time({SRV} {WARN} [$__range])) or vector(0)", instant=True),
           th=thresholds((GREEN, 0), (ORANGE, 50)), w=4, desc="Avisos não quebram nada, mas o mesmo aviso em volume indica algo a corrigir.")
    b.stat("Panics", prom(f"sum(increase({M}goroutine_panics_total{{{JOB}}}[$__range])) or vector(0)", instant=True), decimals=0,
           th=thresholds((GREEN, 0), (RED, 1)), w=4, desc="Normal: 0 sempre. Qualquer valor acima de 0 é bug de código: veja a linha goroutine_panic nos logs.")
    b.stat("RPCs com erro do servidor", prom(f"sum(increase({M}rpc_duration_seconds_count{{{JOB},status=\"error\"}}[$__range])) or vector(0)", instant=True),
           decimals=0, th=thresholds((GREEN, 0), (ORANGE, 1), (RED, 50)), w=4,
           desc="Falhas causadas pelo servidor (não conta erro de uso, como pedir algo sem permissão).")
    b.stat("Eventos descartados", prom(f"sum(increase({M}events_dropped_total{{{JOB},reason!=\"disabled\"}}[$__range])) or vector(0)", instant=True),
           decimals=0, th=thresholds((GREEN, 0), (ORANGE, 1)), w=4,
           desc="Eventos de produto perdidos (buffer cheio ou erro de banco). Normal: 0. Se subir, os painéis de negócio estão subcontando.")
    b.stat("Alertas disparando", prom(FIRING, instant=True), th=thresholds((GREEN, 0), (RED, 1)), w=4)

    b.row("Logs")
    b.add("timeseries", "Erros e avisos no log por minuto", [
        loki(f"sum(count_over_time({SRV} {ERR} [$__auto]))", "erro"),
        loki(f"sum(count_over_time({SRV} {WARN} [$__auto]))", "aviso")],
        w=24, h=7, custom=BARS, options=TS_OPTS,
        overrides=[{"matcher": {"id": "byName", "options": "erro"}, "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": RED}}]},
                   {"matcher": {"id": "byName", "options": "aviso"}, "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": ORANGE}}]}],
        desc="Normal: quase vazio. Preocupante: pico que não passa ou barras todo minuto.")
    t = top_table("Erros por mensagem (Top 15)", f"topk(15, sum by (msg) (count_over_time({SRV} {LVL} | level=\"ERROR\" [$__range])))",
                  "Nenhum erro no período", RED,
                  "Mensagem do log e quantas vezes apareceu. msg conhecidas: rpc, store_save_failed, publish_failed, goroutine_panic, youtube_quota_exhausted.")
    b.add(t.pop("ptype"), t.pop("title"), t.pop("targets"), **t)
    t = top_table("Avisos por mensagem (Top 15)", f"topk(15, sum by (msg) (count_over_time({SRV} {LVL} | level=\"WARN\" [$__range])))",
                  "Nenhum aviso no período", ORANGE,
                  "transport_absent e stale_transport_advanced indicam sala tocando sem relógio de sincronia (veja alerta CoJamPlayingWithoutTransport).")
    b.add(t.pop("ptype"), t.pop("title"), t.pop("targets"), **t)
    b.add("logs", "Linhas de erro recentes (mais novas primeiro)", [loki(f"{SRV} {ERR}")], w=24, h=11,
          options={"showTime": True, "wrapLogMessage": True, "sortOrder": "Descending", "enableLogDetails": True, "prettifyLogMessage": True},
          desc="Clique numa linha para ver request_id e room_id e procurar o mesmo request_id nos outros logs.")

    b.row("RPCs e provedores")
    b.add("timeseries", "RPCs com erro do servidor por método", [prom(
        f"sum by (method) (increase({M}rpc_duration_seconds_count{{{JOB},status=\"error\",method=~\"$metodo\"}}[$__rate_interval]))", "{{method}}")],
        w=12, h=8, custom=BARS, options=TS_OPTS, no_value="0",
        desc="Só status=error (falha do servidor). Normal: vazio. Preocupante: um método concentrando as falhas. Dropdown Método RPC filtra.")
    b.add("timeseries", "Falhas por provedor (status diferente de ok)", [prom(
        f"sum by (provider, op, status) (increase({M}provider_requests_total{{{JOB},status!=\"ok\",provider=~\"$provedor\"}}[$__rate_interval]))",
        "{{provider}} {{op}} {{status}}")],
        w=12, h=8, custom=BARS, options=TS_OPTS, no_value="0",
        desc="quota = cota esgotada; ratelimit = pedimos demais; timeout = provedor lento; error = resposta ruim. Normal: poucas. Preocupante: uma série dominando por horas.")
    b.add("timeseries", "Cota do YouTube: vezes que o freio abriu", [
        prom(f"sum by (kind) (increase({M}youtube_quota_trips_total{{{JOB}}}[$__rate_interval]))", "{{kind}}")],
        w=12, h=7, custom=BARS, options=TS_OPTS, no_value="0",
        desc="daily = cota do dia acabou (volta às 04:00 de Brasília); transient = pausa curta. Normal: zero.")
    b.add("state-timeline", "Cota do YouTube aberta", [prom(f"max({M}youtube_quota_open{{{JOB}}})", "cota")],
          w=12, h=7, mappings=[{"type": "value", "options": {"0": {"text": "ok", "color": GREEN}, "1": {"text": "aberta", "color": ORANGE}}}],
          options=STATE_OPTS, desc="Faixa laranja = o servidor parou de buscar no YouTube. Enquanto estiver aberta, buscas novas falham.")

    b.row("Navegador e telemetria")
    b.add("timeseries", "Erros do navegador por tipo", [prom(
        f"sum by (name) (increase({M}client_errors_total{{{JOB}}}[$__rate_interval]))", "{{name}}")],
        w=12, h=8, custom=BARS, options=TS_OPTS, no_value="0",
        desc="Erros que o site reportou (por exemplo playback_failed, ws_terminal). Normal: poucos. Preocupante: salto logo após um deploy.")
    b.add("timeseries", "Telemetria rejeitada pelo servidor", [prom(
        f"sum by (reason) (increase({M}telemetry_rejected_total{{{JOB}}}[$__rate_interval]))", "{{reason}}")],
        w=12, h=8, custom=BARS, options=TS_OPTS, no_value="0",
        desc="Normal: zero. rate_limited ou malformed em volume = navegador mandando demais ou versão antiga do site.")
    b.add("timeseries", "Falhas de banco e de publicação", [
        prom(f"sum by (op) (increase({M}store_errors_total{{{JOB}}}[$__rate_interval]))", "banco {{op}}"),
        prom(f"sum(increase({M}publish_errors_total{{{JOB}}}[$__rate_interval]))", "publicação")],
        w=24, h=7, custom=BARS, options=TS_OPTS, no_value="0",
        desc="Normal: zero. Falha de banco ao salvar sala = a sala pode voltar atrás depois de reiniciar.")
    return b


# --------------------------------------------------------------------------- sistema
def sistema():
    b = Board("cojam-sistema", "CoJam: sistema",
              "Saúde técnica do servidor: latência, conexões, memória, banco, dessincronia e web vitals.", "now-24h", ("sistema",))
    b.vars.append(prom_var("metodo", "Método RPC", f"label_values({M}rpc_duration_seconds_count{{{JOB}}}, method)",
                           "Filtra os painéis de RPC e de limite de taxa por método."))
    b.vars.append(prom_var("plataforma", "Plataforma", f"label_values({M}sync_drift_seconds_bucket{{{JOB}}}, platform)",
                           "mobile ou desktop: filtra os painéis de dessincronia."))
    b.vars.append(prom_var("player", "Player", f"label_values({M}sync_drift_seconds_bucket{{{JOB}}}, player)",
                           "youtube ou spotify: filtra os painéis de dessincronia."))
    b.stat("Servidor", prom(f"max(up{{{JOB}}}) or vector(0)", instant=True), mappings=UP_MAP, th=thresholds((RED, 0), (GREEN, 1)), w=4)
    b.stat("Ligado há", prom(f"time() - max(process_start_time_seconds{{{JOB}}})", instant=True), unit="s", w=4, th=thresholds(("text", 0)),
           desc="Tempo desde o último início do processo (deploy ou reinício). Reinícios em sequência indicam crash.")
    b.stat("Pessoas conectadas", prom(f"sum({M}connections_active{{{JOB}}}) or vector(0)", instant=True), w=4)
    b.stat("Salas ativas", prom(f"sum({M}rooms_active{{{JOB}}}) or vector(0)", instant=True), w=4)
    b.stat("Goroutines", prom(f"sum(go_goroutines{{{JOB}}})", instant=True), w=4, desc="Normal: estável. Preocupante: subindo sem parar (vazamento).")
    b.stat("Memória do processo", prom(f"sum(process_resident_memory_bytes{{{JOB}}})", instant=True), unit="bytes", w=4)

    b.row("Latência das chamadas")
    b.add("timeseries", "RPC: p50 e p95 por método", [
        prom(quant(0.5, "rpc_duration_seconds", "le, method", sel=',method=~"$metodo"'), "p50 {{method}}"),
        prom(quant(0.95, "rpc_duration_seconds", "le, method", sel=',method=~"$metodo"'), "p95 {{method}}")],
        w=24, h=9, unit="s", custom=LINES, options=TS_OPTS,
        desc="Tempo de cada ação na sala. Normal: p95 abaixo de 100 ms. Preocupante: p95 acima de 1 s (banco lento ou servidor sobrecarregado). Dropdown Método RPC filtra.")
    b.add("timeseries", "Salvar sala no banco (p50 e p95)", [
        prom(quant(0.5, "store_save_duration_seconds"), "p50"), prom(quant(0.95, "store_save_duration_seconds"), "p95")],
        w=12, h=8, unit="s", custom=LINES, options=TS_OPTS, desc="Normal: p95 abaixo de 50 ms. Preocupante: acima de 500 ms.")
    b.add("timeseries", "Publicar na sala (p50 e p95)", [
        prom(quant(0.5, "publish_duration_seconds"), "p50"), prom(quant(0.95, "publish_duration_seconds"), "p95")],
        w=12, h=8, unit="s", custom=LINES, options=TS_OPTS, desc="Tempo para enviar uma atualização a todos da sala. Normal: poucos ms. Preocupante: acima de 500 ms.")

    b.row("Conexões e recursos")
    b.add("timeseries", "Pessoas conectadas e salas ativas", [
        prom(f"sum({M}connections_active{{{JOB}}})", "conexões"), prom(f"sum({M}rooms_active{{{JOB}}})", "salas")],
        w=12, h=8, custom=LINES, options=TS_OPTS)
    b.add("timeseries", "Goroutines", [prom(f"sum(go_goroutines{{{JOB}}})", "goroutines")], w=6, h=8, custom=LINES, options=TS_OPTS,
          desc="Linha que só sobe por horas = vazamento.")
    b.add("timeseries", "Memória", [
        prom(f"sum(process_resident_memory_bytes{{{JOB}}})", "processo (RSS)"), prom(f"sum(go_memstats_heap_inuse_bytes{{{JOB}}})", "heap em uso")],
        w=6, h=8, unit="bytes", custom=LINES, options=TS_OPTS, desc="Subida contínua sem queda após picos = vazamento.")

    b.row("Banco de dados")
    b.add("timeseries", "Pool do Postgres", [
        prom(f"sum({M}db_pool_acquired_conns{{{JOB}}})", "em uso"), prom(f"sum({M}db_pool_idle_conns{{{JOB}}})", "ociosas"),
        prom(f"sum({M}db_pool_max_conns{{{JOB}}})", "limite")],
        w=12, h=8, custom=LINES, options=TS_OPTS, desc="Normal: em uso bem abaixo do limite. Preocupante: em uso colado no limite.")
    b.add("timeseries", "Esperas por conexão livre no pool", [
        prom(f"sum(increase({M}db_pool_empty_acquire_total{{{JOB}}}[$__rate_interval]))", "esperas")],
        w=12, h=8, custom=BARS_FLAT, options=TS_OPTS, no_value="0",
        desc="Cada barra é alguém que precisou esperar o banco. Normal: zero. Preocupante: constante = pool pequeno demais.")

    b.row("Sincronia de reprodução")
    sel = ',player=~"$player",platform=~"$plataforma"'
    b.add("timeseries", "Dessincronia p50 e p95 por plataforma e player", [
        prom(quant(0.5, "sync_drift_seconds", "le, platform, player", "15m", sel), "p50 {{platform}} {{player}}"),
        prom(quant(0.95, "sync_drift_seconds", "le, platform, player", "15m", sel), "p95 {{platform}} {{player}}")],
        w=16, h=9, unit="s", custom=LINES, options=TS_OPTS, no_value="sem amostras",
        desc="Diferença entre o que a pessoa ouve e o que deveria ouvir. Normal: p95 abaixo de 1,5 s. Preocupante: acima de 5 s por 10 minutos (alerta CoJamDriftHigh). Compare mobile e desktop com o dropdown Plataforma. Os buckets chegam até 120 s, então valores acima de 30 s ficam imprecisos.")
    b.add("timeseries", "Amostras de dessincronia (sinal de que há dado)", [
        prom(f"sum by (platform, hidden) (rate({M}sync_drift_samples_total{{{JOB},player=~\"$player\",platform=~\"$plataforma\"}}[$__rate_interval]))",
             "{{platform}} aba oculta={{hidden}}")],
        w=8, h=9, unit="ops", custom=LINES, options=TS_OPTS, no_value="0",
        desc="Se estiver em zero, a telemetria do site está desligada (COJAM_FEATURE_TELEMETRY) ou ninguém ouve. Aba oculta costuma dessincronizar por conta do navegador.")

    b.row("Experiência no navegador")
    b.add("timeseries", "Web vitals (p75)", [prom(quant(0.75, "web_vitals", "le, name"), "{{name}}")],
          w=12, h=8, custom=LINES, options=TS_OPTS, no_value="sem amostras",
          desc="LCP e INP em milissegundos, CLS sem unidade. Bom: LCP abaixo de 2500, INP abaixo de 200, CLS abaixo de 0,1. Preocupante: acima de 4000, 500 e 0,25.")
    b.add("timeseries", "Pedidos barrados por limite de taxa", [
        prom(f"sum by (method) (increase({M}rate_limit_rejected_total{{{JOB},method=~\"$metodo\"}}[$__rate_interval]))", "{{method}}")],
        w=12, h=8, custom=BARS, options=TS_OPTS, no_value="0",
        desc="Normal: zero ou raro. Preocupante: um método barrando muito (cliente em laço ou abuso).")
    return b


BUILDERS = (inicio, negocio, erros, sistema)


def render():
    out = {}
    for build in BUILDERS:
        board = build()
        out[OUT / f"{board.uid}.json"] = json.dumps(board.json(), ensure_ascii=False, indent=2) + "\n"
    return out


if __name__ == "__main__":
    files = render()
    if "--check" in sys.argv:
        bad = [p.name for p, txt in files.items() if not p.exists() or p.read_text(encoding="utf-8") != txt]
        if bad:
            sys.exit(f"dashboards desatualizados: {', '.join(bad)}. Rode python3 observability/grafana/build_dashboards.py e faça commit.")
        print(f"ok: {len(files)} dashboards em dia")
    else:
        OUT.mkdir(exist_ok=True)
        for p, txt in files.items():
            p.write_text(txt, encoding="utf-8")
            print(f"wrote {p} ({txt.count(chr(34) + 'gridPos' + chr(34))} panels)")
