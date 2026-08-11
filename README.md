# Бюджет — личный трекер (PWA)

**Прод:** https://babkopay.ru · **Репозиторий:** BabkoED/budget-app

## Состав

| Файл | Назначение |
|---|---|
| `index.html` | Всё приложение: HTML + CSS + JS в одном файле. Ключи Supabase вшиты. |
| `sw.js` | Service Worker v9. Network-first с таймаутом 2.5с — открывается офлайн/в лифте. |
| `manifest.json` | PWA-манифест, иконки PNG + SVG. |
| `icon-192.png` / `icon-512.png` | Иконки для домашнего экрана iOS. |
| `schema.sql` | Схема базы. Выполняется один раз при создании проекта Supabase. |
| `CNAME` | Домен для GitHub Pages (создаётся автоматически). |

## Обновление

```bash
cd ~/Documents/GitHub/budget-app
# заменить index.html на новую версию
git add .
git commit -m "описание правок"
git push origin main
```

GitHub Pages подхватит за 30–60 секунд. **PWA переустанавливать не нужно** — sw v9 сам тянет свежую версию.

### Если push не проходит

```bash
# прокси V2RayU перехватывает git
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY

# "fetch first" — на GitHub есть коммит, которого нет локально
git pull origin main --no-rebase
```

## Инфраструктура

- **База:** Supabase, таблица `user_state` (jsonb на пользователя), RLS `auth.uid() = user_id`
- **Хостинг:** GitHub Pages (Netlify не работал с мобильного интернета в РФ)
- **DNS на reg.ru:** 4 A-записи `@` → `185.199.108.153` … `185.199.111.153`, CNAME `www` → `babkoed.github.io`, TXT `_github-pages-challenge-BabkoED` для верификации домена
- **Сброс пароля:** Supabase → Authentication → Users → Send password recovery

## Восстановление с нуля

1. Создать проект Supabase, выполнить `schema.sql`
2. Authentication → Providers → Email → выключить Confirm email
3. Подставить свои `SUPA_URL` и `SUPA_KEY` в `index.html` (строки ~556)
4. Залить файлы в репозиторий, включить GitHub Pages (branch `main`, папка `/`)

## Известное ограничение

Изменение дохода или плановых расходов **в середине месяца** пересчитывает дневную норму задним числом — накопление за прошедшие дни меняется. Так же работала Sintra. Правки лучше делать в начале периода.
