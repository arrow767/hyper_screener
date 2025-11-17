# Миграция конфигурации Policy на YAML

## 📋 Что изменилось

Начиная с текущей версии, все правила контекстного управления (Спринт 9) настраиваются через **YAML файл** вместо ENV переменных. Это обеспечивает гибкость, читаемость и возможность создавать сложные правила.

## ❌ Удалённые ENV переменные

Следующие параметры больше не используются и **удалены** из конфигурации:

```env
POLICY_MAX_WINS_PER_ANCHOR
POLICY_SHOCK_30M_LEVEL
POLICY_SHOCK_30M_SIZE_MULT
POLICY_SHOCK_60M_LEVEL
POLICY_SHOCK_60M_SIZE_MULT
POLICY_SHOCK_60M_TP_MULT
POLICY_RETEST_MIN_AGO_MIN
POLICY_RETEST_SIZE_MULT
POLICY_RETEST_TP_MULT
POLICY_TIME_IN_ZONE_MIN
POLICY_TIME_IN_ZONE_TP_MULT
```

## ✅ Новые ENV переменные

Остались только 3 основные переменные:

```env
POLICY_ENABLED=false                              # Включить/выключить систему
POLICY_RULES_FILE=./policy.yaml                   # Путь к YAML с правилами
POLICY_ANCHOR_MEMORY_FILE=./data/anchor_memory.json  # Файл статистики
```

## 🔄 Как мигрировать

### Шаг 1: Создать policy.yaml

Скопируйте пример конфигурации:

```bash
cp policy.example.yaml policy.yaml
```

### Шаг 2: Перенести ваши настройки

**Было в .env:**
```env
POLICY_MAX_WINS_PER_ANCHOR=5
POLICY_SHOCK_60M_LEVEL=12
POLICY_SHOCK_60M_SIZE_MULT=2.0
POLICY_SHOCK_60M_TP_MULT=1.2
```

**Стало в policy.yaml:**
```yaml
rules:
  # Блокировка после 5 винов
  - name: too_many_wins_on_anchor
    priority: 1
    scope: new_entry
    when:
      anchorWinCountGte: 5
    then:
      allowTrade: false

  # Увеличение при шоке 60м
  - name: shock_60m_strong
    priority: 9
    scope: new_entry
    when:
      shock60mNatrGte: 12
    then:
      sizeMultiplier: 2.0
      tpNatrMultiplier: 1.2
```

### Шаг 3: Обновить .env

Удалите все старые `POLICY_*` переменные, кроме трёх основных:

```env
POLICY_ENABLED=true
POLICY_RULES_FILE=./policy.yaml
POLICY_ANCHOR_MEMORY_FILE=./data/anchor_memory.json
```

### Шаг 4: Проверить работу

```bash
npm run build
npm start
```

Система загрузит правила из YAML и выведет в лог:

```
[PolicyRulesParser] Загружено 5 правил из ./policy.yaml
[PositionPolicy] Загружено 5 правил из ./policy.yaml
```

## 📝 Таблица соответствия

| Старая ENV переменная | Новое место в YAML | Пример |
|-----------------------|-------------------|--------|
| `POLICY_MAX_WINS_PER_ANCHOR=5` | `when.anchorWinCountGte: 5` + `then.allowTrade: false` | См. правило `too_many_wins_on_anchor` |
| `POLICY_SHOCK_30M_LEVEL=6` | `when.shock30mNatrGte: 6` | См. правило `shock_30m_normal` |
| `POLICY_SHOCK_30M_SIZE_MULT=1.0` | `then.sizeMultiplier: 1.0` | См. правило `shock_30m_normal` |
| `POLICY_SHOCK_60M_LEVEL=12` | `when.shock60mNatrGte: 12` | См. правило `shock_60m_strong` |
| `POLICY_SHOCK_60M_SIZE_MULT=2.0` | `then.sizeMultiplier: 2.0` | См. правило `shock_60m_strong` |
| `POLICY_SHOCK_60M_TP_MULT=1.2` | `then.tpNatrMultiplier: 1.2` | См. правило `shock_60m_strong` |
| `POLICY_RETEST_MIN_AGO_MIN=180` | `when.anchorLastTradeAgoMinGte: 180` | См. правило `anchor_retest_smaller` |
| `POLICY_RETEST_SIZE_MULT=0.5` | `then.sizeMultiplier: 0.5` | См. правило `anchor_retest_smaller` |
| `POLICY_RETEST_TP_MULT=0.7` | `then.tpNatrMultiplier: 0.7` | См. правило `anchor_retest_smaller` |
| `POLICY_TIME_IN_ZONE_MIN=40` | `when.timeInAnchorZoneMinGte: 40` | См. правило `long_time_near_anchor` |
| `POLICY_TIME_IN_ZONE_TP_MULT=0.5` | `then.tpNatrMultiplier: 0.5` | См. правило `long_time_near_anchor` |

## 🎯 Преимущества новой системы

1. **Гибкость** — можно создавать неограниченное количество правил
2. **Читаемость** — YAML намного понятнее, чем куча ENV переменных
3. **Комбинирование условий** — несколько `when` в одном правиле (логическое И)
4. **Приоритеты** — явное управление порядком применения правил
5. **Версионность** — легко переключаться между разными конфигами:
   ```bash
   POLICY_RULES_FILE=./policy-aggressive.yaml
   # или
   POLICY_RULES_FILE=./policy-conservative.yaml
   ```

## 🆘 Помощь

Если возникли проблемы с миграцией:

1. Сверьтесь с `policy.example.yaml` — там есть все базовые правила с комментариями
2. Проверьте логи при запуске — парсер выведет понятные ошибки при неправильном YAML
3. Начните с копии `policy.example.yaml` и постепенно модифицируйте

## 📚 Дополнительная информация

- `README.md` — полная документация по YAML правилам
- `CONFIG_EXAMPLES.md` — 3 готовых примера конфигураций (агрессивная, консервативная, сбалансированная)
- `policy.example.yaml` — базовый шаблон с 5 правилами

