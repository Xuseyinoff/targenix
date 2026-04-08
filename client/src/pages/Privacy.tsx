import { useState } from "react";
import { Link } from "wouter";

type Lang = "en" | "uz";

export default function Privacy() {
  const [lang, setLang] = useState<Lang>("en");

  return (
    <LegalPage lang={lang} setLang={setLang} title={{ en: "Privacy Policy", uz: "Maxfiylik Siyosati" }}>
      {lang === "en" ? <PrivacyEN /> : <PrivacyUZ />}
    </LegalPage>
  );
}

function PrivacyEN() {
  return (
    <div className="space-y-8">
      <p className="text-gray-700 leading-relaxed border-l-4 border-blue-500 pl-4 bg-blue-50 py-3 pr-4 rounded-r-lg">
        This Privacy Policy describes how <strong>Targenix.uz</strong> ("we", "our", or "us") collects,
        uses, stores, and protects personal data obtained through Facebook Lead Ads. By using our
        service, you agree to the practices described in this policy.
      </p>

      <Section title="1. What Data We Collect">
        <p>When a user submits a Facebook Lead Ad form connected to our service, we receive and store the following personal data:</p>
        <ul className="mt-3 space-y-2">
          {["Full name", "Phone number", "Email address (if included in the form)", "Facebook Lead ID (leadgen_id)", "Facebook Page ID and Form ID", "Submission timestamp"].map(i => <Li key={i} color="blue">{i}</Li>)}
        </ul>
        <Note>We do not collect any data beyond what is explicitly submitted through the Facebook Lead Ad form. We do not use cookies, tracking pixels, or any third-party analytics on this platform.</Note>
      </Section>

      <Section title="2. Purpose of Data Processing">
        <p>The collected data is used exclusively for the following purposes:</p>
        <ul className="mt-3 space-y-2">
          {[
            "Forwarding lead information to a designated Telegram bot for immediate operator notification",
            "Submitting lead data to an affiliate or CRM system as configured by the account owner",
            "Storing lead records for the account owner's review and management",
          ].map(i => <Li key={i} color="green">{i}</Li>)}
        </ul>
        <Note>We do not use your personal data for advertising, profiling, or any purpose beyond the above.</Note>
      </Section>

      <Section title="3. Data Retention Period">
        <p>Lead data is retained for a maximum of <strong>90 days</strong> from the date of collection, after which it is permanently deleted from our systems. Account owners may request earlier deletion at any time (see Section 5).</p>
      </Section>

      <Section title="4. No Sharing with Third Parties">
        <p>We do not sell, rent, or share your personal data with any third parties for commercial purposes. Data is only transmitted to:</p>
        <ul className="mt-3 space-y-2">
          {[
            "Telegram (via bot API) — for operator notification only",
            "The affiliate or CRM system configured by the account owner — for lead routing only",
          ].map(i => <Li key={i} color="orange">{i}</Li>)}
        </ul>
        <Note>Both transmissions occur over encrypted HTTPS connections. We do not share data with advertisers, data brokers, or any other parties.</Note>
      </Section>

      <Section title="5. Your Rights">
        <p>You have the following rights regarding your personal data:</p>
        <ul className="mt-3 space-y-2">
          {[
            "Right to access: request a copy of the data we hold about you",
            "Right to deletion: request permanent deletion of your data from our systems",
            "Right to objection: object to the processing of your data",
            "Right to rectification: request correction of inaccurate data",
          ].map(i => <Li key={i} color="purple">{i}</Li>)}
        </ul>
        <p className="mt-3">To exercise any of these rights, send an email to <a href="mailto:sitoramoxusenova@gmail.com" className="text-blue-600 underline">sitoramoxusenova@gmail.com</a> with your name, phone number, and the nature of your request. We will respond within <strong>30 days</strong>.</p>
      </Section>

      <Section title="6. Data Security">
        <p>All Facebook Page Access Tokens are stored encrypted using <strong>AES-256-CBC</strong> encryption. Data is transmitted exclusively over HTTPS. Access to lead data is restricted to authenticated account owners only.</p>
      </Section>

      <Section title="7. Facebook Platform Compliance">
        <p>This App uses the Facebook Platform and complies with the <a href="https://developers.facebook.com/policy/" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">Facebook Platform Policy</a>. We request only the minimum permissions required: <code className="bg-gray-100 px-1 rounded text-sm">pages_show_list</code>, <code className="bg-gray-100 px-1 rounded text-sm">leads_retrieval</code>, <code className="bg-gray-100 px-1 rounded text-sm">pages_read_engagement</code>, <code className="bg-gray-100 px-1 rounded text-sm">pages_manage_ads</code>, <code className="bg-gray-100 px-1 rounded text-sm">pages_manage_metadata</code>.</p>
        <p className="mt-2">You can revoke the App's access to your Facebook account at any time via <a href="https://www.facebook.com/settings?tab=applications" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">Facebook Settings → Apps and Websites</a>.</p>
      </Section>

      <Section title="8. Changes to This Policy">
        <p>We may update this Privacy Policy from time to time. Changes will be reflected by updating the "Last Updated" date at the top of this page. Continued use of the service after changes constitutes acceptance of the updated policy.</p>
      </Section>

      <Section title="9. Contact">
        <p>For any privacy-related questions or requests, contact us at:</p>
        <a href="mailto:sitoramoxusenova@gmail.com" className="inline-block mt-2 text-blue-600 hover:underline font-medium">
          sitoramoxusenova@gmail.com
        </a>
      </Section>
    </div>
  );
}

function PrivacyUZ() {
  return (
    <div className="space-y-8">
      <p className="text-gray-700 leading-relaxed border-l-4 border-blue-500 pl-4 bg-blue-50 py-3 pr-4 rounded-r-lg">
        Ushbu Maxfiylik Siyosati <strong>Targenix.uz</strong> ("biz", "bizning") Facebook Lead Ads orqali olingan
        shaxsiy ma'lumotlarni qanday yig'ishi, ishlatishi, saqlashi va himoya qilishini tavsiflaydi.
        Xizmatimizdan foydalanish orqali siz ushbu siyosatda tavsiflangan amaliyotlarga rozilik bildirasiz.
      </p>

      <Section title="1. Biz Yig'adigan Ma'lumotlar">
        <p>Foydalanuvchi bizning xizmatimizga ulangan Facebook Lead Ad formasini to'ldirganda, biz quyidagi shaxsiy ma'lumotlarni olamiz va saqlaymiz:</p>
        <ul className="mt-3 space-y-2">
          {["To'liq ism", "Telefon raqami", "Elektron pochta manzili (formada mavjud bo'lsa)", "Facebook Lead ID (leadgen_id)", "Facebook Sahifa ID va Forma ID", "Yuborish vaqti"].map(i => <Li key={i} color="blue">{i}</Li>)}
        </ul>
        <Note>Biz Facebook Lead Ad formasida aniq yuborilgan ma'lumotlardan tashqari hech qanday ma'lumot to'plamaymiz. Ushbu platformada cookie-fayllar, kuzatuv piksellari yoki uchinchi tomon tahlillari ishlatilmaydi.</Note>
      </Section>

      <Section title="2. Ma'lumotlarni Qayta Ishlash Maqsadi">
        <p>Yig'ilgan ma'lumotlar faqat quyidagi maqsadlar uchun ishlatiladi:</p>
        <ul className="mt-3 space-y-2">
          {[
            "Lead ma'lumotlarini operator xabardorligi uchun belgilangan Telegram botiga yuborish",
            "Hisob egasi tomonidan sozlangan affiliate yoki CRM tizimiga lead ma'lumotlarini yuborish",
            "Hisob egasining ko'rishi va boshqarishi uchun lead yozuvlarini saqlash",
          ].map(i => <Li key={i} color="green">{i}</Li>)}
        </ul>
        <Note>Biz shaxsiy ma'lumotlaringizni reklama, profillashtirish yoki yuqoridagilardan tashqari boshqa maqsadlar uchun ishlatmaymiz.</Note>
      </Section>

      <Section title="3. Ma'lumotlarni Saqlash Muddati">
        <p>Lead ma'lumotlari yig'ilgan sanadan boshlab maksimal <strong>90 kun</strong> saqlanadi, shundan so'ng tizimlarimizdan butunlay o'chiriladi. Hisob egalari istalgan vaqtda erta o'chirishni so'rashlari mumkin (5-bo'limga qarang).</p>
      </Section>

      <Section title="4. Uchinchi Tomonlar Bilan Ulashmaslik">
        <p>Biz shaxsiy ma'lumotlaringizni tijorat maqsadlarida hech qanday uchinchi shaxslarga sotmaymiz, ijaraga bermaymiz yoki ulashmaymiz. Ma'lumotlar faqat quyidagilarga uzatiladi:</p>
        <ul className="mt-3 space-y-2">
          {[
            "Telegram (bot API orqali) — faqat operator xabardorligi uchun",
            "Hisob egasi tomonidan sozlangan affiliate yoki CRM tizimi — faqat lead yo'naltirish uchun",
          ].map(i => <Li key={i} color="orange">{i}</Li>)}
        </ul>
        <Note>Ikkala uzatish ham shifrlangan HTTPS ulanishlari orqali amalga oshiriladi. Biz ma'lumotlarni reklama beruvchilar, ma'lumotlar brokerlari yoki boshqa tomonlar bilan ulashmaymiz.</Note>
      </Section>

      <Section title="5. Sizning Huquqlaringiz">
        <p>Shaxsiy ma'lumotlaringizga nisbatan quyidagi huquqlarga egasiz:</p>
        <ul className="mt-3 space-y-2">
          {[
            "Kirish huquqi: biz siz haqingizda saqlaydigan ma'lumotlar nusxasini so'rash",
            "O'chirish huquqi: ma'lumotlaringizni tizimlarimizdan butunlay o'chirishni so'rash",
            "E'tiroz huquqi: ma'lumotlaringizni qayta ishlashga e'tiroz bildirish",
            "Tuzatish huquqi: noto'g'ri ma'lumotlarni to'g'rilashni so'rash",
          ].map(i => <Li key={i} color="purple">{i}</Li>)}
        </ul>
        <p className="mt-3">Ushbu huquqlardan birini amalga oshirish uchun ism, telefon raqami va so'rovingizning mohiyatini ko'rsatib <a href="mailto:sitoramoxusenova@gmail.com" className="text-blue-600 underline">sitoramoxusenova@gmail.com</a> manziliga elektron pochta yuboring. Biz <strong>30 kun</strong> ichida javob beramiz.</p>
      </Section>

      <Section title="6. Ma'lumotlar Xavfsizligi">
        <p>Barcha Facebook Sahifa Kirish Tokenlari <strong>AES-256-CBC</strong> shifrlash yordamida shifrlangan holda saqlanadi. Ma'lumotlar faqat HTTPS orqali uzatiladi. Lead ma'lumotlariga kirish faqat autentifikatsiya qilingan hisob egalari bilan cheklangan.</p>
      </Section>

      <Section title="7. Facebook Platformasiga Muvofiqlik">
        <p>Ushbu ilova Facebook Platformasidan foydalanadi va <a href="https://developers.facebook.com/policy/" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">Facebook Platforma Siyosati</a>ga rioya qiladi. Biz faqat zarur minimal ruxsatlarni so'raymiz: <code className="bg-gray-100 px-1 rounded text-sm">pages_show_list</code>, <code className="bg-gray-100 px-1 rounded text-sm">leads_retrieval</code>, <code className="bg-gray-100 px-1 rounded text-sm">pages_read_engagement</code>, <code className="bg-gray-100 px-1 rounded text-sm">pages_manage_ads</code>, <code className="bg-gray-100 px-1 rounded text-sm">pages_manage_metadata</code>.</p>
        <p className="mt-2">Siz ilovaning Facebook hisobingizga kirishini istalgan vaqtda <a href="https://www.facebook.com/settings?tab=applications" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">Facebook Sozlamalari → Ilovalar va Veb-saytlar</a> orqali bekor qilishingiz mumkin.</p>
      </Section>

      <Section title="8. Siyosatdagi O'zgarishlar">
        <p>Biz ushbu Maxfiylik Siyosatini vaqti-vaqti bilan yangilashimiz mumkin. O'zgarishlar ushbu sahifaning yuqorisidagi "Oxirgi yangilanish" sanasini yangilash orqali aks ettiriladi. O'zgarishlardan so'ng xizmatdan foydalanishni davom ettirish yangilangan siyosatni qabul qilishni anglatadi.</p>
      </Section>

      <Section title="9. Aloqa">
        <p>Maxfiylikka oid savollar yoki so'rovlar uchun biz bilan bog'laning:</p>
        <a href="mailto:sitoramoxusenova@gmail.com" className="inline-block mt-2 text-blue-600 hover:underline font-medium">
          sitoramoxusenova@gmail.com
        </a>
      </Section>
    </div>
  );
}

// ─── Shared layout wrapper ────────────────────────────────────────────────────
function LegalPage({
  lang,
  setLang,
  title,
  children,
}: {
  lang: Lang;
  setLang: (l: Lang) => void;
  title: { en: string; uz: string };
  children: React.ReactNode;
}) {
  const updated = { en: "Last Updated: March 18, 2026", uz: "Oxirgi yangilanish: 18-mart, 2026" };
  const badge = { en: "Legal Document", uz: "Huquqiy hujjat" };
  const back = { en: "← Back to Home", uz: "← Bosh sahifaga qaytish" };
  const footer = { en: "© 2026 Targenix.uz. All rights reserved.", uz: "© 2026 Targenix.uz. Barcha huquqlar himoyalangan." };
  const links = {
    en: [["Privacy Policy", "/privacy"], ["Terms of Service", "/terms"], ["Data Deletion", "/data-deletion"]],
    uz: [["Maxfiylik Siyosati", "/privacy"], ["Foydalanish Shartlari", "/terms"], ["Ma'lumotlarni O'chirish", "/data-deletion"]],
  };

  return (
    <div className="min-h-screen bg-white text-gray-900">
      {/* Top bar */}
      <div className="border-b border-gray-200 bg-gray-50">
        <div className="max-w-4xl mx-auto px-6 py-3 flex items-center justify-between">
          <Link href="/" className="text-sm text-blue-600 hover:underline">
            {back[lang]}
          </Link>
          <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-lg p-1">
            {(["en", "uz"] as Lang[]).map((l) => (
              <button
                key={l}
                onClick={() => setLang(l)}
                className={`px-3 py-1 text-sm rounded-md font-medium transition-colors ${
                  lang === l ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-100"
                }`}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Header */}
      <div className="max-w-4xl mx-auto px-6 pt-10 pb-6">
        <span className="inline-block bg-blue-100 text-blue-700 text-xs font-semibold px-3 py-1 rounded-full uppercase tracking-wide mb-4">
          {badge[lang]}
        </span>
        <h1 className="text-4xl font-bold text-gray-900 mb-2">{title[lang]}</h1>
        <p className="text-sm text-gray-500">{updated[lang]}</p>
      </div>

      {/* Content */}
      <main className="max-w-4xl mx-auto px-6 pb-16">{children}</main>

      {/* Footer */}
      <footer className="border-t border-gray-200 bg-gray-50">
        <div className="max-w-4xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-sm text-gray-500">{footer[lang]}</p>
          <nav className="flex gap-4 flex-wrap justify-center">
            {links[lang].map(([label, path]) => (
              <Link key={path} href={path} className="text-sm text-blue-600 hover:underline">
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </footer>
    </div>
  );
}

// ─── Reusable sub-components ──────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-xl font-semibold text-gray-900 mb-3 pb-2 border-b border-gray-200">{title}</h2>
      <div className="space-y-3 text-gray-700 leading-relaxed">{children}</div>
    </section>
  );
}

function Li({ children, color }: { children: React.ReactNode; color: string }) {
  const colors: Record<string, string> = {
    blue: "bg-blue-500", green: "bg-green-500", orange: "bg-orange-500", purple: "bg-purple-500",
  };
  return (
    <li className="flex items-start gap-2">
      <span className={`mt-2 w-2 h-2 rounded-full ${colors[color] ?? "bg-gray-400"} flex-shrink-0`} />
      <span>{children}</span>
    </li>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 text-sm text-gray-600 bg-gray-50 p-3 rounded-lg border border-gray-200">
      {children}
    </p>
  );
}
