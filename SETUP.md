# Быстрый старт

## Шаг 1: Установка Node.js

**Windows:**
1. Скачайте Node.js с https://nodejs.org/ (LTS версия)
2. Запустите установщик и следуйте инструкциям
3. Проверьте установку в PowerShell:

```powershell
node --version
npm --version
```

## Шаг 2: Создание Telegram бота

1. Откройте Telegram и найдите [@BotFather](https://t.me/botfather)
2. Отправьте команду `/newbot`
3. Следуйте инструкциям (имя бота, username)
4. Скопируйте токен (выглядит как `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

## Шаг 3: Получение Chat ID

**Вариант 1: Личные сообщения**

1. Напишите вашему боту `/start`
2. Откройте в браузере:
   ```
   https://api.telegram.org/bot<ВАШ_ТОКЕН>/getUpdates
   ```
3. Найдите `"chat":{"id":123456789,...}`
4. Скопируйте число после `"id":`

**Вариант 2: Канал (рекомендуется для публичных алертов)**

1. Создайте публичный или приватный канал
2. Добавьте бота в канал как администратора (Settings → Administrators → Add Administrator)
3. Отправьте любое сообщение в канал
4. Откройте в браузере:
   ```
   https://api.telegram.org/bot<ВАШ_ТОКЕН>/getUpdates
   ```
5. Найдите `"chat":{"id":-1001234567890,...}` (начинается с `-100`)
6. Скопируйте полное число включая `-`

## Шаг 4: Настройка проекта

1. Откройте PowerShell в папке проекта
2. Установите зависимости:

```powershell
npm install
```

3. Создайте `.env` файл (скопируйте `env.example`):

```powershell
copy env.example .env
```

4. Откройте `.env` в блокноте и заполните:

```env
TELEGRAM_BOT_TOKEN=ваш_токен_от_BotFather
TELEGRAM_CHAT_ID=ваш_chat_id

MIN_ORDER_SIZE_USD=2000000
MAX_DISTANCE_PERCENT=0.2

ALERT_COOLDOWN_MS=60000
LOG_LEVEL=info
```

## Шаг 5: Запуск

**Для разработки (с автоперезагрузкой):**

```powershell
npm run dev
```

**Для production:**

```powershell
npm run build
npm start
```

## Шаг 6: Проверка работы

После запуска вы должны увидеть:

```
============================================================
  Hyperliquid Large Order Screener
============================================================

[Main] Configuration validated successfully
[Telegram] Bot initialized: @your_bot
[Hyperliquid] Loaded 150 assets
[Hyperliquid] WebSocket connected
[Monitor] Starting orderbook monitor...
[Monitor] Min order size: $2,000,000
[Monitor] Max distance: 0.2%
[Monitor] Monitor started successfully
```

Теперь бот мониторит рынок и будет отправлять алерты в Telegram при обнаружении крупных заявок!

## Типичные проблемы

### "npm не является внутренней или внешней командой"

**Решение:** Node.js не установлен или не добавлен в PATH. Переустановите Node.js.

### "Cannot find module 'dotenv'"

**Решение:** Запустите `npm install`

### Бот не отправляет сообщения

**Решение:** 
1. Проверьте токен бота в `.env`
2. Убедитесь что бот добавлен в канал/чат
3. Проверьте Chat ID (для каналов начинается с `-100`)

### Нет алертов

**Решение для теста:** Уменьшите `MIN_ORDER_SIZE_USD` до `100000` и увеличьте `MAX_DISTANCE_PERCENT` до `1.0`

## Остановка бота

Нажмите `Ctrl+C` в PowerShell для остановки.

## Запуск в фоне (Windows)

Создайте файл `start.bat`:

```batch
@echo off
start /B npm start > logs.txt 2>&1
```

Для остановки найдите процесс node.exe в Task Manager и завершите его.

