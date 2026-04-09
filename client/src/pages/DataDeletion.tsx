import { useState } from "react";
import { Link } from "wouter";

type Lang = "en" | "uz";

export default function DataDeletion() {
  const [lang, setLang] = useState<Lang>("en");

  return (
    <LegalPage lang={lang} setLang={setLang} title={{ en: "Data Deletion Request", uz: "Ma'lumotlarni O'chirish So'rovi" }}>
      {lang === "en" ? <DataDeletionEN /> : <DataDeletionUZ />}
    </LegalPage>
  );
}

function DataDeletionEN() {
  return (
    <div className="space-y-8">
      <p className="text-gray-700 leading-relaxed border-l-4 border-red-500 pl-4 bg-red-50 py-3 pr-4 rounded-r-lg">
        You have the right to request deletion of your personal data that has been collected through
        Facebook Lead Ads and processed by <strong>Targenix.uz</strong>. This page explains how to
        submit a deletion request and what happens after you do.
      </p>

      {/* Quick action box */}
      <div className="bg-blue-600 text-white rounded-xl p-6">
        <h2 className="text-xl font-bold mb-2">Submit a Deletion Request</h2>
        <p className="text-blue-100 mb-4">Send an email with the subject line <strong>"Data Deletion Request"</strong> to:</p>
        <a
          href="mailto:sitoramoxusenova@gmail.com?subject=Data%20Deletion%20Request"
          className="inline-block bg-white text-blue-600 font-semibold px-5 py-2 rounded-lg hover:bg-blue-50 transition-colors"
        >
          sitoramoxusenova@gmail.com
        </a>
        <p className="text-blue-100 text-sm mt-3">Include your full name and phone number so we can locate your records.</p>
      </div>

      <Section title="1. Deletion Process">
        <p>To request deletion of your personal data, follow these steps:</p>
        <ol className="mt-3 space-y-3">
          {[
            { n: "1", text: "Send an email to sitoramoxusenova@gmail.com with the subject line \"Data Deletion Request\"" },
            { n: "2", text: "Include your full name and phone number (and email address if provided in the original form) so we can locate your records" },
            { n: "3", text: "We will send an acknowledgment email within 3 business days confirming receipt of your request" },
            { n: "4", text: "Your data will be permanently deleted within 30 days of receiving your request" },
            { n: "5", text: "You will receive a final confirmation email once the deletion is complete" },
          ].map(({ n, text }) => (
            <li key={n} className="flex items-start gap-3">
              <span className="w-7 h-7 rounded-full bg-blue-600 text-white text-sm font-bold flex items-center justify-center flex-shrink-0">{n}</span>
              <span className="text-gray-700 pt-0.5">{text}</span>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="2. Completion Deadline">
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-start gap-3">
          <span className="text-2xl">✓</span>
          <div>
            <p className="font-semibold text-green-800">30-Day Guarantee</p>
            <p className="text-green-700 text-sm mt-1">All deletion requests are processed and completed within <strong>30 calendar days</strong> of receipt. In most cases, deletion is completed within 7 business days.</p>
          </div>
        </div>
      </Section>

      <Section title="3. What Data Will Be Deleted">
        <p>Upon a valid deletion request, the following data associated with your submission will be permanently removed from our systems:</p>
        <ul className="mt-3 space-y-2">
          {[
            "Your full name",
            "Your phone number",
            "Your email address (if collected)",
            "Your Facebook Lead ID (leadgen_id)",
            "All raw form submission data",
            "Any associated order or routing records",
            "Application log entries referencing your lead",
          ].map(i => <Li key={i} color="red">{i}</Li>)}
        </ul>
        <Note>Deletion is permanent and irreversible. Once deleted, your data cannot be recovered.</Note>
      </Section>

      <Section title="4. Confirmation Process">
        <p>After submitting your request, you will receive two emails:</p>
        <ul className="mt-3 space-y-2">
          {[
            "Acknowledgment email (within 3 business days): confirms we received your request and provides a reference number",
            "Completion email (within 30 days): confirms your data has been permanently deleted from all our systems",
          ].map(i => <Li key={i} color="blue">{i}</Li>)}
        </ul>
        <p className="mt-3">If you do not receive an acknowledgment within 3 business days, please check your spam folder or resend your request.</p>
      </Section>

      <Section title="5. Scope of Deletion">
        <p>Please note the following limitations:</p>
        <ul className="mt-3 space-y-2">
          {[
            "We can only delete data stored in our systems. We cannot delete data that has already been forwarded to and stored by third-party systems (Telegram, affiliate networks, CRM platforms) configured by the account owner.",
            "We cannot delete data held directly by Facebook. To remove data from Facebook, visit facebook.com/help/contact/540977946302970.",
            "Anonymized or aggregated statistical data (e.g., total lead counts) that cannot be linked back to you is not subject to deletion.",
          ].map(i => <Li key={i} color="orange">{i}</Li>)}
        </ul>
      </Section>

      <Section title="6. Facebook Data Deletion Callback">
        <p>
          If you connected your Facebook account to Targenix.uz and later remove the app from your Facebook account via{" "}
          <a href="https://www.facebook.com/settings?tab=applications" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
            Facebook Settings → Apps and Websites
          </a>
          , Facebook will automatically notify us to delete your data. We will process this deletion within 30 days and provide a status URL at:
        </p>
        <code className="block mt-2 bg-gray-100 px-3 py-2 rounded text-sm text-gray-700">
          https://targenix.uz/data-deletion
        </code>
      </Section>

      <Section title="7. Contact">
        <p>For any questions about the data deletion process, contact us at:</p>
        <a href="mailto:sitoramoxusenova@gmail.com" className="inline-block mt-2 text-blue-600 hover:underline font-medium">
          sitoramoxusenova@gmail.com
        </a>
      </Section>
    </div>
  );
}

function DataDeletionUZ() {
  return (
    <div className="space-y-8">
      <p className="text-gray-700 leading-relaxed border-l-4 border-red-500 pl-4 bg-red-50 py-3 pr-4 rounded-r-lg">
        Siz Facebook Lead Ads orqali yig'ilgan va <strong>Targenix.uz</strong> tomonidan qayta ishlangan
        shaxsiy ma'lumotlaringizni o'chirishni so'rash huquqiga egasiz. Ushbu sahifa o'chirish so'rovini
        qanday yuborish va undan keyin nima bo'lishini tushuntiradi.
      </p>

      {/* Quick action box */}
      <div className="bg-blue-600 text-white rounded-xl p-6">
        <h2 className="text-xl font-bold mb-2">O'chirish So'rovini Yuboring</h2>
        <p className="text-blue-100 mb-4"><strong>"Ma'lumotlarni O'chirish So'rovi"</strong> mavzusi bilan quyidagi manzilga elektron pochta yuboring:</p>
        <a
          href="mailto:sitoramoxusenova@gmail.com?subject=Ma'lumotlarni%20O'chirish%20So'rovi"
          className="inline-block bg-white text-blue-600 font-semibold px-5 py-2 rounded-lg hover:bg-blue-50 transition-colors"
        >
          sitoramoxusenova@gmail.com
        </a>
        <p className="text-blue-100 text-sm mt-3">Yozuvlaringizni topishimiz uchun to'liq ism va telefon raqamingizni kiriting.</p>
      </div>

      <Section title="1. O'chirish Jarayoni">
        <p>Shaxsiy ma'lumotlaringizni o'chirishni so'rash uchun quyidagi amallarni bajaring:</p>
        <ol className="mt-3 space-y-3">
          {[
            { n: "1", text: "sitoramoxusenova@gmail.com manziliga \"Ma'lumotlarni O'chirish So'rovi\" mavzusi bilan elektron pochta yuboring" },
            { n: "2", text: "Yozuvlaringizni topishimiz uchun to'liq ism va telefon raqamingizni (va asl formada ko'rsatilgan bo'lsa elektron pochta manzilingizni) kiriting" },
            { n: "3", text: "Biz so'rovingizni qabul qilganimizni tasdiqlovchi 3 ish kuni ichida tasdiqlash elektron pochtasini yuboramiz" },
            { n: "4", text: "Ma'lumotlaringiz so'rovingizni olgandan 30 kun ichida butunlay o'chiriladi" },
            { n: "5", text: "O'chirish tugagach siz yakuniy tasdiqlash elektron pochtasini olasiz" },
          ].map(({ n, text }) => (
            <li key={n} className="flex items-start gap-3">
              <span className="w-7 h-7 rounded-full bg-blue-600 text-white text-sm font-bold flex items-center justify-center flex-shrink-0">{n}</span>
              <span className="text-gray-700 pt-0.5">{text}</span>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="2. Bajarish Muddati">
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-start gap-3">
          <span className="text-2xl">✓</span>
          <div>
            <p className="font-semibold text-green-800">30 Kunlik Kafolat</p>
            <p className="text-green-700 text-sm mt-1">Barcha o'chirish so'rovlari qabul qilinganidan <strong>30 kalendar kun</strong> ichida qayta ishlanadi va bajariladi. Ko'p hollarda o'chirish 7 ish kuni ichida bajariladi.</p>
          </div>
        </div>
      </Section>

      <Section title="3. Qanday Ma'lumotlar O'chiriladi">
        <p>Tegishli o'chirish so'rovi bo'yicha yuborishingiz bilan bog'liq quyidagi ma'lumotlar tizimlarimizdan butunlay o'chiriladi:</p>
        <ul className="mt-3 space-y-2">
          {[
            "To'liq ismingiz",
            "Telefon raqamingiz",
            "Elektron pochta manzilingiz (agar yig'ilgan bo'lsa)",
            "Facebook Lead ID (leadgen_id) ingiz",
            "Barcha xom forma yuborish ma'lumotlari",
            "Har qanday tegishli buyurtma yoki yo'naltirish yozuvlari",
            "Leadingizga havola qiluvchi ilova jurnal yozuvlari",
          ].map(i => <Li key={i} color="red">{i}</Li>)}
        </ul>
        <Note>O'chirish doimiy va qaytarib bo'lmaydi. O'chirilgandan so'ng ma'lumotlaringizni tiklash mumkin emas.</Note>
      </Section>

      <Section title="4. Tasdiqlash Jarayoni">
        <p>So'rovingizni yuborgandan so'ng siz ikkita elektron pochta olasiz:</p>
        <ul className="mt-3 space-y-2">
          {[
            "Tasdiqlash elektron pochtasi (3 ish kuni ichida): so'rovingizni qabul qilganimizni tasdiqlaydi va ma'lumotnoma raqamini taqdim etadi",
            "Bajarish elektron pochtasi (30 kun ichida): ma'lumotlaringiz barcha tizimlarimizdan butunlay o'chirilganligini tasdiqlaydi",
          ].map(i => <Li key={i} color="blue">{i}</Li>)}
        </ul>
        <p className="mt-3">Agar 3 ish kuni ichida tasdiqlash olmagan bo'lsangiz, spam papkangizni tekshiring yoki so'rovingizni qayta yuboring.</p>
      </Section>

      <Section title="5. O'chirish Doirasi">
        <p>Quyidagi cheklovlarga e'tibor bering:</p>
        <ul className="mt-3 space-y-2">
          {[
            "Biz faqat tizimlarimizda saqlangan ma'lumotlarni o'chira olamiz. Hisob egasi tomonidan sozlangan uchinchi tomon tizimlariga (Telegram, affiliate tarmoqlari, CRM platformalari) allaqachon yuborilgan va saqlangan ma'lumotlarni o'chira olmaymiz.",
            "Facebook da to'g'ridan-to'g'ri saqlanadigan ma'lumotlarni o'chira olmaymiz. Facebook dan ma'lumotlarni o'chirish uchun facebook.com/help/contact/540977946302970 saytiga tashrif buyuring.",
            "Sizga bog'lab bo'lmaydigan anonimlashtirилган yoki yig'ilgan statistik ma'lumotlar (masalan, umumiy lead soni) o'chirishga bo'ysunmaydi.",
          ].map(i => <Li key={i} color="orange">{i}</Li>)}
        </ul>
      </Section>

      <Section title="6. Facebook Ma'lumotlarini O'chirish Callback">
        <p>
          Agar siz Facebook hisobingizni Targenix.uz ga ulagan bo'lsangiz va keyinchalik{" "}
          <a href="https://www.facebook.com/settings?tab=applications" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
            Facebook Sozlamalari → Ilovalar va Veb-saytlar
          </a>{" "}
          orqali ilovani Facebook hisobingizdan olib tashlasangiz, Facebook bizga ma'lumotlaringizni o'chirish uchun avtomatik ravishda xabar beradi. Biz ushbu o'chirishni 30 kun ichida qayta ishlaymiz va holat URL manzilini quyidagi manzilda taqdim etamiz:
        </p>
        <code className="block mt-2 bg-gray-100 px-3 py-2 rounded text-sm text-gray-700">
          https://targenix.uz/data-deletion
        </code>
      </Section>

      <Section title="7. Aloqa">
        <p>Ma'lumotlarni o'chirish jarayoni haqida savollar uchun biz bilan bog'laning:</p>
        <a href="mailto:sitoramoxusenova@gmail.com" className="inline-block mt-2 text-blue-600 hover:underline font-medium">
          sitoramoxusenova@gmail.com
        </a>
      </Section>
    </div>
  );
}

// ─── Shared layout wrapper ────────────────────────────────────────────────────
function LegalPage({
  lang, setLang, title, children,
}: {
  lang: Lang; setLang: (l: Lang) => void; title: { en: string; uz: string }; children: React.ReactNode;
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
      <div className="border-b border-gray-200 bg-gray-50">
        <div className="max-w-4xl mx-auto px-6 py-3 flex items-center justify-between">
          <Link href="/" className="text-sm text-blue-600 hover:underline">{back[lang]}</Link>
          <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-lg p-1">
            {(["en", "uz"] as Lang[]).map((l) => (
              <button key={l} onClick={() => setLang(l)}
                className={`px-3 py-1 text-sm rounded-md font-medium transition-colors ${lang === l ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-100"}`}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="max-w-4xl mx-auto px-6 pt-10 pb-6">
        <span className="inline-block bg-blue-100 text-blue-700 text-xs font-semibold px-3 py-1 rounded-full uppercase tracking-wide mb-4">{badge[lang]}</span>
        <h1 className="text-4xl font-bold text-gray-900 mb-2">{title[lang]}</h1>
        <p className="text-sm text-gray-500">{updated[lang]}</p>
      </div>
      <main className="max-w-4xl mx-auto px-6 pb-16">{children}</main>
      <footer className="border-t border-gray-200 bg-gray-50">
        <div className="max-w-4xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-sm text-gray-500">{footer[lang]}</p>
          <nav className="flex gap-4 flex-wrap justify-center">
            {links[lang].map(([label, path]) => (
              <Link key={path} href={path} className="text-sm text-blue-600 hover:underline">{label}</Link>
            ))}
          </nav>
        </div>
      </footer>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-xl font-semibold text-gray-900 mb-3 pb-2 border-b border-gray-200">{title}</h2>
      <div className="space-y-3 text-gray-700 leading-relaxed">{children}</div>
    </section>
  );
}

function Li({ children, color }: { children: React.ReactNode; color: string }) {
  const colors: Record<string, string> = { blue: "bg-blue-500", green: "bg-green-500", orange: "bg-orange-500", purple: "bg-purple-500", red: "bg-red-500" };
  return (
    <li className="flex items-start gap-2">
      <span className={`mt-2 w-2 h-2 rounded-full ${colors[color] ?? "bg-gray-400"} flex-shrink-0`} />
      <span>{children}</span>
    </li>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 text-sm text-gray-600 bg-gray-50 p-3 rounded-lg border border-gray-200">{children}</p>
  );
}
