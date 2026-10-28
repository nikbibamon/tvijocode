# Локальные MCP snapshots — opt-in пилот

Существующий `tvijo-dshrem-mcp` stdio сервер расширен тремя read-only tools.
Новый сервер, runtime, router и зависимости не создаются. Версия 0.1.1 сохранена.
Без opt-in список tools/list остаётся прежним: шесть инструментов, включая
удалённый `tvijo_task_status`.

Оператор локально задаёт ОБЕ переменные:

```
TVIJO_LOCAL_REPORTS=1
TVIJO_LOCAL_REPORT_ROOT=/absolute/authorized/snapshot-directory
```

Относительный корень, `/`, dot/dotdot, пустые компоненты, обратный слеш, NUL,
symlink корня или любого родителя запрещены. Linux `/proc/self/fd` используется
для последовательного O_DIRECTORY/O_NOFOLLOW открытия каждого родителя,
затем фиксированного файла с O_NOFOLLOW/O_NONBLOCK. Так родитель остаётся
привязанным к дескриптору во время чтения. Нерегулярные файлы, symlinks и
файлы больше 64KiB отклоняются. Изменение размера/mtime/ctime во время чтения
отклоняется. Ошибки не содержат сырого содержимого или системного пути.

Только фиксированные имена в корне, без рекурсивного чтения:

| Tool | Файл | Поля данных |
|---|---|---|
| tvijo_local_repositories | repositories.json | as_of, repositories[]: id, head, worktree, allowed |
| tvijo_local_test_results | test-results.json | as_of, results[]: repository, suite, status, passed, failed, skipped, not_run, total, duration_ms |
| tvijo_local_execution_budget | execution-budget.json | as_of, accounting, currency, limit_usd, settled_usd, held_usd, available_usd, reason |

Все инструменты принимают пустой strict object. Произвольные path, filename,
command и неизвестные параметры отклоняются. Tools имеют readOnlyHint=true,
destructiveHint=false, idempotentHint=true, openWorldHint=false. Новые handlers
не обращаются к API, token-store и shell; все результаты проходят существующий
redactor сервера.

Схемы strict на каждом уровне; неизвестные ключи отклоняются целиком. Нет
полей logs, token, password, arbitrary strings или произвольных абсолютных путей.
Repository/suite IDs: `[a-z][a-z0-9-]{0,63}`, с дополнительным отказом credential
shapes. head: null либо 40/64 lowercase hex; worktree: clean/dirty/unknown;
allowed только true. Максимум 100 строк в каждом массиве; дубли repository ID
запрещены. Оператор отвечает за выбор разрешённого snapshot-каталога и его
производителя; root не сканирует сам репозитории и не расширяет полномочия.

as_of: null либо действительный UTC ISO timestamp `YYYY-MM-DDTHH:mm:ss[.sss]Z`.
Будущая/невозможная дата отклоняется. Выход добавляет freshness=fresh/stale/unknown
(старше 15 минут — stale, as_of=null — unknown) и authority=evidence_only.
Старость не меняет суммы или исходный accounting. Источник обновляет snapshots
сам; сервер не пишет файлы и не выдаёт snapshot за live observation.

Числа счётчиков — целые от 0 до 1e9; total равен сумме четырёх счётчиков.
PASS требует passed>0, failed=not_run=0; FAIL требует failed>0; NOT_RUN требует
passed=failed=0 и not_run>0. duration_ms допускает null. Отказ guard не является
нулём пройденных проверок.

Бюджет: currency только USD, суммы — конечные числа 0..1e9 либо null.
accounting=unknown требует все четыре суммы null и ненулевую причину;
frozen требует available_usd=null и reason uncertain_spend/unreconciled.
known требует timestamp, все суммы, reason=none и согласованный available.
Допустимые reason: none, uncertain_spend, unreconciled, unavailable.
Сервер никогда не заменяет неизвестное нулём, не снимает freeze, не вычисляет
разрешение на расход и не меняет финансовый ledger. Snapshots — свидетельства,
не финансовая власть. Отсутствующий/битый файл — явный отказ, не фиктивный ноль.

Пример unknown execution-budget.json:

```json
{"as_of":null,"accounting":"unknown","currency":"USD","limit_usd":null,"settled_usd":null,"held_usd":null,"available_usd":null,"reason":"unavailable"}
```

Зависимости не устанавливались: перед новым symlink `mcp/node_modules` на
`/root/ai-os-workspaces/tvijocode/mcp/node_modules` все установленные версии
сверены с неизменённым lock. Исходный runtime и dependency tree не записывались.

Проверка 2026-10-25: через общий run_check.py выполнены только
`mcp/test/local-reports.test.mjs` и `mcp/test/client.test.mjs`, 42/42 PASS.
Реальный stdio: default tools/list=6 для трёх вариантов без полного opt-in;
с opt-in=9; три локальных чтения, frozen hold сохранён, available=null;
HTTP requests=0. Отдельные client tests используют исключительно fake loopback
API (включая имитацию платного маршрута), живой сервис не вызывался.
Первый прогон 41/42 выявил будущую дату в stdio-fixture; дата исправлена,
ошибочная квитанция сохранена. Квитанции находятся в
`workers/integration-sol/mcp-local-reports-v2.{json,log}` общего root fd0e8bd8.
Acceptance и релиз не выполнялись; review pending у supervisor.
