# Schema cleanup va modernizatsiya yo'l xaritasi

Bu hujjat — `targenix.uz` ma'lumotlar bazasi schema'sini professional SaaS standartlariga
moslashtirish bo'yicha sprint rejasi. 2026-05-11 dagi audit asosida tuzilgan.

---

## ✅ Bugungi yutuqlar (2026-05-11)

| # | Commit | Tavsif | Joy |
|---|--------|--------|-----|
| 1 | `f7861ae` | `google_oauth_states` zombie jadval drop | Prod'da bajarilgan ✓ |
| 2 | `d9f2d84` | `integrations.targetWebsiteId` backfill (115→1 NULL) | Prod'da bajarilgan ✓ |
| 3 | `5f73ba2` | `closeDb()` helper — CLI script exit | Deploy kutilmoqda |
| 4 | `c4c7302` | Bosqich 2: dedicated fields config JSON'dan ko'tarildi | Deploy kutilmoqda |
| 5 | `8c6c73f` | `fix`: testLead'da connection eager-load | Deploy kutilmoqda |

---

## 🟡 Hozirgi navbat: tasdiqlash bosqichi

### A. Test Lead tasdiqlash (5 daqiqa)
- Railway deploy bo'lgach, integration 600193 uchun "Test Lead" tugmasini qaytadan bosish
- Kutilgan natija: muvaffaqiyatli delivery (CONNECTION_REQUIRED yo'q)
- Agar bug bo'lsa — zudlik bilan tuzatish

### B. 1 hafta kuzatuv davri
- Real foydalanuvchilar yangi integrations yaratganini kuzatish
- Har biri tozami tekshirish:
  ```sh
  railway run --service targenix.uz node tooling/verify-integration-dedup.mjs <integration_id>
  ```
- Maqsad: Bosqich 4 (JSON strip) dan oldin yangi yozuvlar duplikatsiz ekanini tasdiqlash

---

## Sprint'lar (prioritet bo'yicha)

### 🟢 SPRINT A — `integrations.config` JSON cleanup
**Hozirgi Bosqich 1-2 ni yakunlash.** Eng past risk, eng katta foyda.

| Bosqich | Ish | Vaqt | Risk |
|---------|-----|------|------|
| 3 | 1 hafta kuzatuv + tasdiqlash | passiv | – |
| 4 | Eski 212 qatordan JSON keys strip | 30 daq | Past |
| 5 | 9 ta fallback kod sayti tozalanadi | 3 soat | Past |

**Bosqich 4 SQL:**
```sql
UPDATE integrations
SET config = JSON_REMOVE(config,
  '$.pageId', '$.formId', '$.pageName', '$.formName',
  '$.targetWebsiteId', '$.facebookAccountId')
WHERE type = 'LEAD_ROUTING';
```

**Bosqich 5 — olib tashlanadigan fallback'lar:**
- `server/services/leadService.ts` (4 sayt): `?? cfg.pageId`, `?? cfg.facebookAccountId`, `?? cfg.targetWebsiteId`
- `server/routers/adminBackfillRouter.ts` (3 sayt): xuddi shu pattern
- `server/routers/integrationsRouter.ts` (2 sayt): list enrichment
- `server/db.ts` createIntegration/updateIntegration: cfg fallback'larni olib tashlash

**Boshlash sharti**: Bosqich 2 deploy + 1 hafta tasdiqlash.

---

### 🟡 SPRINT B — `facebook_oauth_states` Strangler Fig
**To'liq Expand-Contract mashqi.** Google'ning yo'lini takrorlash, kichik ko'lamda.

| Bosqich | Ish | Vaqt |
|---------|-----|------|
| 1 | 3 fayl yangilanadi: `emailAuthRouter.ts`, `facebookLoginOAuth.ts`, `facebookOAuthCallback.ts` — `oauthStates` ga ko'chirish (provider='facebook') | 4 soat |
| 2 | Dual-write 3 kun | passiv |
| 3 | Backfill shart emas (10 daq TTL — stale qatorlar o'zi expire) | 0 daq |
| 4 | Read switch + 1 hafta kuzatuv | passiv |
| 5 | `DROP TABLE facebook_oauth_states` migration | 30 daq |

**Risk**: O'rta — FB OAuth juda hot-path (login flow). Lekin Strangler Fig zero-downtime.

**Ish hajmi**: ~1-2 kun aktiv ish + 1 hafta kutish.

---

### 🟠 SPRINT C — `target_websites.templateType` DROP
**Sprint 4 (`39e812f`) ning to'liq tugatilishi.**

Prod ma'lumot: 29 ta qator, hammasi `"custom"` (uniform — ma'lumot tomondan xavfsiz).
Kod tomondan: 6 WRITE + 10+ READ sayti hali ham bog'liq.

| Faza | Ish | Vaqt |
|------|-----|------|
| 1 | Client `createPayload.ts` — `templateType` ni `appKey`'dan derive | 2 soat |
| 2 | Server input validation — `templateType` dan voz kechib `appKey` ishlatish | 3 soat |
| 3 | `targetWebsitesRouter.ts` — 6 WRITE + 10+ READ branching → `appKey` | 5 soat |
| 4 | Dispatch + adapter — `templateType` ni input/log'dan olib tashlash | 2 soat |
| 5 | `testIntegration` — `tw.templateType` checklarini `tw.appKey` ga | 1 soat |
| 6 | UI category — `categoryFromTemplateType()` o'rniga default fallback | 1 soat |
| 7 | `ALTER TABLE target_websites DROP COLUMN templateType` migration | 30 daq |
| 8 | Tests, types, comments cleanup | 2 soat |

**Vaqt**: ~2 hafta (aktiv + verification window'lar).

**Risk**: O'rta — kod refactor katta.

---

### 🔴 SPRINT D — `target_websites` → `destinations` rename
**Eng katta. Asosiy professional SaaS makeover.**

Audit natijasi:
- 17 server fayl + 34 client tRPC chaqiruvi
- 2 FK constraint (`integration_destinations` CASCADE + `integrations` soft FK)
- 15 migration SQL fayl literal nom bilan
- 85KB asosiy UI sahifa (`TargetWebsites.tsx`)

| Bosqich | Ish | Vaqt | Verifikatsiya |
|---------|-----|------|---------------|
| 0 | Plan + ko'lam | 1 kun | — |
| 1 | `destinations` jadval yaratish (parallel, bo'sh) | 0.5 kun | 1 kun |
| 2 | Dual-write (transactional) | 2-3 kun | 3-7 kun |
| 3 | Backfill + verify | 1 kun | 1 kun |
| 4 | Read switch (feature flag) | 2 kun | 7 kun |
| 5 | tRPC alias (`targetWebsites` + `destinations` ikkalasi) | 1 kun | 7 kun |
| 6 | FK rewire + DROP eski | 1 kun | (alias 3 oy turadi) |

**Jami**: ~10 kun ish + ~4 hafta verifikatsiya = ~5 hafta.

**Risk**: Yuqori. Hot-path. Lekin Expand-Contract bilan zero-downtime.

**Tavsiya**: faqat SPRINT C tugagach boshlang. `templateType` bilan birga refactor qilingan
kodni keyinroq qayta yozish ortiqcha bo'ladi.

**Rollback**: Har bosqichdan keyin alohida rollback yo'li bor (`_deprecated_target_websites_YYYYMMDD` 1 oy backup).

---

## Tavsiya qilingan tartib

```
Hafta 0 (hozir):   Bosqich 2 tasdiqlash + 1 hafta kuzatuv
↓
Hafta 1:           SPRINT A (JSON strip + fallback cleanup)
↓
Hafta 2:           SPRINT B (facebook_oauth_states) — to'liq mashq
↓
Hafta 3-4:         SPRINT C (templateType DROP)
↓
Hafta 5-9:         SPRINT D (destinations rename) — eng katta makeover
↓
Hafta 10+:         Boshqa cleanup
```

---

## 🔵 Backlog (low-priority)

### `*_cache` jadvallar → Redis
**Sabab**: MySQL'da cache 2015-yil hidi keladi. Modern SaaS Redis/Upstash ishlatadi.

Affected:
- `ad_accounts_cache` (58 ref)
- `campaigns_cache` (28 ref)
- `ad_sets_cache` (12 ref)
- `campaign_insights_cache` (31 ref)

**Vaqt**: 1 hafta.

### `crm_connections` → `connections` ga birlashtirish
**Sabab**: Generic `connections` jadval bor turib alohida CRM tabel saqlash duplikatsiya.

**Yo'l**: `connections.type = 'crm'` + `appKey` orqali ajratish.

**Vaqt**: 3 kun.

### `app_logs` → Sentry/Datadog
**Sabab**: DB'da log saqlash anti-pattern. Modern SaaS observability platformasiga yo'naltiradi.

**Vaqt**: 2 kun.

### `leads` rename → `submissions`
**Sabab**: "leads" — Salesforce-davri CRM termini. Modern SaaS uchun:
- Submissions
- Form responses
- Contacts

**Shart**: faqat SPRINT D tugagach. Birgalikda hot-path rename xavfli.

**Vaqt**: 1 hafta.

---

## Audit kashfiyotlari (kontekst uchun)

### Aniqlangan zombie jadvallar
- ✅ `google_oauth_states` — drop qilingan
- `facebookOauthStates` — LIVE (SPRINT B nomzodi, Strangler Fig kerak)

### Aniqlangan zombie ustunlar (kelajakdagi cleanup)
- `target_websites.templateType` — SPRINT C
- `integrations.config.{pageId, formId, pageName, formName, targetWebsiteId, facebookAccountId}` — SPRINT A

### "Live lekin legacy" jadvallar
- `target_websites` — asosiy rename nomzodi (SPRINT D)
- `integrations` + `connections` — ikkalasi mavjudligi yarim qolgan refactor signali
- `crm_connections` — generic `connections` bilan duplikatsiya

### Schema drift (boshqalar tomonidan boshlangan, tugatilmagan)
- `leads.dataStatus` ustuni — Drizzle introspect savol berdi (snapshot 0034 dan keyin manual migrationlar)
- `connection_app_specs` — `0054_drop_connection_app_specs.sql` da olib tashlangan

---

## Process bo'yicha eslatmalar

### Har bir migration uchun standart workflow
1. **Audit avval, kod keyin** — usage to'liq tekshiriladi
2. **Manual migration SQL** (bu repo'da auto-generate emas, manual yoziladi — 0035'dan beri)
3. **Journal entry manual qo'shiladi** (idx + timestamp)
4. **Type-check** — `pnpm run check`
5. **Conventional commit + push** — har bir o'zgarish uchun
6. **Prod state pre-check** — inspect script yozish
7. **`pnpm run db:railway:migrate`** — backfill skript idempotent, drizzle-kit migrate atomic
8. **Prod state post-check** — tasdiqlash

### Expand-Contract pattern (3 qadam)
```
1. Yangi joyga yozish (Expand)     — additive, hech narsa buzilmaydi
2. Eski joyga yozishni TO'XTATISH  — yangi yozuvlar tozalanadi
3. Eski ma'lumotni tozalash         — bir martalik UPDATE
```

**Tartibni buzish xavfli**: 3 dan oldin 2 ni qilmasangiz, eski ma'lumot qaytadan paydo bo'ladi.

### Risk darajalari
- **Past risk**: zombie jadval drop, JSON key strip (backfilldan keyin), izolyatsiya qilingan ustun drop
- **O'rta risk**: hot-path code refactor, schema rename uzun verification bilan
- **Yuqori risk**: FK migration, multi-tenant data migration, atomic deploy talab qiluvchi o'zgarishlar
