# HTTP Refactor Migration Plan

Bu hujjat **`http-request` universal app**'iga ko'chish bo'yicha sprint rejasi.

## Asos

Sizning kodbase'da 3 ta o'xshash app bor:
- **`plain-url`** (Custom HTTP Webhook) — alohida adapter (`plainUrlAdapter`)
- **`webhook-json`** (Webhook / JSON) — `httpApiKeyAdapter` ishlatadi
- **`crm-generic`** (Custom CRM / HTTP) — `httpApiKeyAdapter` ishlatadi

Make.com va Zapier'da bu **bitta universal modul** (HTTP Request). Bizning yo'limiz — refactor qilib bittasiga jamlash.

## Hozirgi holat (Phase 1 — TUGADI)

| ✅ Bajarilgan | Commit |
|---|---|
| Yangi `http-request` manifest yaratildi | (shu sprint) |
| Yangi `httpRequestAdapter` yozildi | (shu sprint) |
| Adapter va app `register.ts`/`apps/index.ts` ga ulandi | (shu sprint) |
| 11 ta unit test (auth schemes, body types, error handling) | (shu sprint) |
| Eski 3 app o'z joyida turibdi (zero downtime) | – |

Hozirgi prod ishlashida hech qanday o'zgarish yo'q. Yangi app **opt-in** — admin xohlasa, yangi destination yaratayotganda `http-request`'ni tanlashi mumkin.

## Qolgan ish (Phase 2-4)

### Phase 2 — Frontend ulanishi (2-3 soat)

1. **`AppCatalogPicker.tsx`'da yangi app ko'rinishini sozlash**
   - Yangi `http-request` app default ravishda manifest registry'dan keladi
   - Tekshirish: card preview, icon (Globe), category ("webhook")
   - Card ostida "Beta" badge ko'rsatish (availability: "beta")

2. **`DestinationCreatorInline.tsx` formada test**
   - Manifest'dagi field tree (URL, method, auth, body, advanced) DynamicForm bilan render bo'lishi
   - `showWhen` rules (method/contentType/scheme) to'g'ri yashirish
   - `mappable` fieldlarda variable picker ishlashi

3. **Preset chips qo'shish (ixtiyoriy)**
   ```
   Quick presets: [Plain JSON] [CRM Bearer] [Webhook]
   ```
   Har birini bosish formni preset value bilan to'ldiradi.

### Phase 3 — Migration script (TUGADI ✅, audit natija: 0 row)

**Audit kashfiyoti** ([`tooling/audit-http-destinations.mjs`](tooling/audit-http-destinations.mjs)):
prod'da `webhook-json`, `plain-url`, va `crm-generic` apps'lardan **hech qaysida active destination yo'q**. Apps catalog'da turardi lekin ishlatilmagan.

**Bajarilgan**:
- 3 ta app `availability: "deprecated"` ga o'tkazildi → catalog'dan darhol yashirildi
  ([`httpWebhook.ts`](server/integrations/apps/httpWebhook.ts), [`webhookJson.ts`](server/integrations/apps/webhookJson.ts), [`crmGeneric.ts`](server/integrations/apps/crmGeneric.ts))
- SDK `defineHttpApiKeyApp`'ga `availability` override qo'shildi
- Defensive migration script yozildi ([`tooling/migrate-to-http-request.mjs`](tooling/migrate-to-http-request.mjs)) — dry-run + apply rejimi bilan, agar kelajakda biror test row paydo bo'lsa avtomatik tarjima qilinadi

**crm-generic'ni ko'chirmaslik qarori**: Bearer token `connections.credentialsJson.apiKeyEncrypted` ichida encrypted saqlanadi. Universal manifest'da token plain templateConfig'da turadi — bu encryption-at-rest regression bo'lar edi. Phase 4a'da `httpRequestAdapter`'ga encrypted secrets qo'llab-quvvatlash qo'shilgach, crm-generic migratsiya xavfsiz bo'ladi. Hozir esa eski kod yo'lida turadi.

---

### (Eski Phase 3 plani — tarixiy yozuv)

Mavjud destinationlarni eski apps'dan `http-request`'ga ko'chirish:

```typescript
// tooling/migrate-to-http-request.mjs

// FROM webhook-json (no auth, fixed JSON)
{ appKey: 'webhook-json' }
   →
{
  appKey: 'http-request',
  templateConfig: {
    url: <endpointUrl from current config>,
    method: 'POST',
    authentication: { scheme: 'none' },
    bodyGroup: {
      contentType: 'json',
      bodyTemplate: '{"name":"{{full_name}}",...}',
    },
  },
}

// FROM plain-url (no auth, full flexibility)
{ appKey: 'plain-url' }
   →
{
  appKey: 'http-request',
  templateConfig: { /* copy existing config */ },
}

// FROM crm-generic (Bearer auth)
{ appKey: 'crm-generic' }
   →
{
  appKey: 'http-request',
  templateConfig: {
    url: <endpointUrl>,
    method: 'POST',
    authentication: {
      scheme: 'bearer',
      bearerToken: <connection's apiKey decrypted, OR null if not yet linked>,
    },
    bodyGroup: { contentType: 'json', bodyTemplate: <user config> },
  },
}
```

**Xavfsizlik**:
- Dry-run + apply rejimi (avvalgi backfill skriptlari kabi)
- Faqat ACTIVE destinations migratsiya qilinadi
- INACTIVE destinations va orphan rows tegmaydi
- Har biri transaction ichida
- Verify: migratsiya'dan keyin har destination uchun Test Lead muvaffaqiyatli bo'lishi kerak

### Phase 4 — Eski apps'ni o'chirish (1 soat)

Phase 3 tugagandan keyin **1-2 hafta tasdiqlash davri**. Yangi destinations'lar 100% `http-request` ishlatayotganini ko'rib (warning log yoki audit script orqali), keyin:

1. `server/integrations/apps/index.ts`'dan eski 3 ta `registerApp(...)`'ni o'chirish:
   - `registerApp(webhookJsonApp)` → o'chirish
   - `registerApp(httpWebhookApp)` (plain-url) → o'chirish
   - `registerApp(crmGenericApp)` → o'chirish

2. `server/integrations/register.ts`'dan `plainUrlAdapter`'ni o'chirish

3. Eski fayllarni `git rm`:
   - `server/integrations/apps/webhookJson.ts`
   - `server/integrations/apps/httpWebhook.ts`
   - `server/integrations/apps/crmGeneric.ts`
   - `server/integrations/adapters/plainUrlAdapter.ts`

4. `appRegistry.test.ts`'da apps ro'yxatini yangilash (3 ta apps olib tashlash)

5. **Hujjat yangilash**: README, ROADMAP

## Phase ketma-ketligi (jami ~6-8 soat)

```
✅ Phase 1: scaffold        (Done)
⏳ Phase 2: frontend test    (2-3 soat)
⏳ Phase 3: migration script (1-2 soat + tasdiqlash window)
⏳ Phase 4: cleanup          (1 soat, 1-2 hafta tasdiqlovdan keyin)
```

## Risklar

| Risk | Yumshatish |
|------|-----------|
| Mavjud destinations buzilishi | Migration transactional + dry-run + per-row verify |
| Variable rendering edge case | 11 ta unit test (auth, body types, query, error) |
| Frontend showWhen rules ishlamasligi | Manual test har bir preset uchun |
| Connection-backed Bearer tokens (crm-generic) | Phase 3'da migratsiya paytida decrypted → templateConfig'ga |
| Live test paytida prod traffic | Beta flag yashirish opsiyasi |

## Eslatmalar

- Phase 1 zero-risk — yangi app qo'shildi, eski hech narsa o'zgarmadi
- Phase 3 paytida 5 daqiqalik downtime EHTIMOLI bor (transactional migration)
- Phase 4'dan keyin 3 ta fayl o'chiriladi, code base 600+ qator kamayadi

## Sinov rejasi (Phase 2'da)

Quyidagi 4 ta senariya har biri uchun yangi `http-request`'ni AdminTemplates orqali yarating va Test Lead yuboring:

1. **Webhook / JSON ekvivalenti**
   - URL: `https://webhook.site/...`
   - Method: POST
   - Auth: None
   - Body: JSON with `{{full_name}}`, `{{phone_number}}`
   - Kutilgan: 200 OK

2. **Custom HTTP Webhook ekvivalenti**
   - URL: `https://hooks.zapier.com/...`
   - Method: POST
   - Auth: None
   - Headers: `X-Custom-Header: foo`
   - Body: form-urlencoded
   - Kutilgan: 200 OK

3. **CRM / HTTP ekvivalenti**
   - URL: `https://api.bitrix24.com/...`
   - Method: POST
   - Auth: Bearer token
   - Body: JSON
   - Kutilgan: 200 OK with Authorization header

4. **API key (header) ekvivalenti** (yangi imkoniyat!)
   - URL: `https://api.example.com/...`
   - Method: POST
   - Auth: API key header, name="X-Api-Key"
   - Body: JSON
   - Kutilgan: 200 OK with X-Api-Key header
