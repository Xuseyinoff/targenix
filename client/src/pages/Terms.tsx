import { useState } from "react";
import { Link } from "wouter";

type Lang = "en" | "uz";

export default function Terms() {
  const [lang, setLang] = useState<Lang>("en");

  return (
    <LegalPage lang={lang} setLang={setLang} title={{ en: "Terms of Service", uz: "Foydalanish Shartlari" }}>
      {lang === "en" ? <TermsEN /> : <TermsUZ />}
    </LegalPage>
  );
}

function TermsEN() {
  return (
    <div className="space-y-8">
      <p className="text-gray-700 leading-relaxed border-l-4 border-blue-500 pl-4 bg-blue-50 py-3 pr-4 rounded-r-lg">
        These Terms of Service ("Terms") govern your use of <strong>Targenix.uz</strong> ("the Service",
        "we", "us"). By accessing or using the Service, you agree to be bound by these Terms. If you
        do not agree, do not use the Service.
      </p>

      <Section title="1. Service Description">
        <p>Targenix.uz is a private integration platform that connects Facebook Lead Ads to downstream notification and CRM systems. The Service enables account owners to:</p>
        <ul className="mt-3 space-y-2">
          {[
            "Connect Facebook accounts and Pages via Facebook Login",
            "Receive lead data from Facebook Lead Ad forms via webhooks",
            "Route lead data to Telegram bots and configured target websites",
            "Monitor lead processing status and webhook health",
          ].map(i => <Li key={i} color="blue">{i}</Li>)}
        </ul>
        <p className="mt-3">The Service is intended for business operators managing their own Facebook advertising campaigns. It is not a consumer-facing product.</p>
      </Section>

      <Section title="2. User Obligations">
        <p>By using the Service, you agree to:</p>
        <ul className="mt-3 space-y-2">
          {[
            "Use the Service only for lawful purposes and in compliance with all applicable laws and regulations",
            "Comply with the Facebook Platform Policy and Meta's Terms of Service at all times",
            "Obtain all necessary consents from lead form respondents before collecting and processing their personal data",
            "Keep your access credentials (tokens, API keys) confidential and not share them with unauthorized parties",
            "Not attempt to reverse-engineer, decompile, or disrupt the Service",
            "Not use the Service to process data of minors under the age of 13",
          ].map(i => <Li key={i} color="green">{i}</Li>)}
        </ul>
      </Section>

      <Section title="3. Limitation of Liability">
        <p>To the maximum extent permitted by applicable law:</p>
        <ul className="mt-3 space-y-2">
          {[
            "The Service is provided \"as is\" without warranties of any kind, express or implied",
            "We are not liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of the Service",
            "We are not responsible for the accuracy, completeness, or legality of lead data received from Facebook",
            "We are not liable for any service interruptions caused by Facebook API changes, downtime, or policy updates",
            "Our total liability to you for any claim arising from the Service shall not exceed USD $100",
          ].map(i => <Li key={i} color="orange">{i}</Li>)}
        </ul>
      </Section>

      <Section title="4. Conditions of Use">
        <p>The following conditions apply to your use of the Service:</p>
        <ul className="mt-3 space-y-2">
          {[
            "You must be at least 18 years of age to use the Service",
            "You are responsible for all activity that occurs under your account",
            "You must not use the Service to send spam, unsolicited messages, or engage in fraudulent activities",
            "You must not overload or attempt to disrupt the Service's infrastructure",
            "The Service may be used only for processing leads from Facebook Lead Ad campaigns that you own or have explicit authorization to manage",
          ].map(i => <Li key={i} color="purple">{i}</Li>)}
        </ul>
      </Section>

      <Section title="5. Intellectual Property">
        <p>All intellectual property rights in the Service, including but not limited to software, design, and documentation, are owned by Targenix.uz. You are granted a limited, non-exclusive, non-transferable license to use the Service solely for its intended purpose. You may not copy, modify, distribute, or create derivative works based on the Service.</p>
      </Section>

      <Section title="6. Termination">
        <p>We reserve the right to suspend or terminate your access to the Service at any time, with or without notice, if we determine that you have violated these Terms or applicable law. Upon termination, your right to use the Service ceases immediately and we may delete your data in accordance with our Privacy Policy.</p>
      </Section>

      <Section title="7. Right to Modify Terms">
        <p>We reserve the right to modify these Terms at any time. Changes will be effective upon posting to this page with an updated "Last Updated" date. Your continued use of the Service after any changes constitutes your acceptance of the new Terms. We encourage you to review these Terms periodically.</p>
      </Section>

      <Section title="8. Governing Law">
        <p>These Terms shall be governed by and construed in accordance with applicable law. Any disputes arising from these Terms or your use of the Service shall be resolved through good-faith negotiation. If negotiation fails, disputes shall be submitted to the competent courts of the jurisdiction where the Service operator is located.</p>
      </Section>

      <Section title="9. Contact">
        <p>For any questions regarding these Terms of Service, contact us at:</p>
        <a href="mailto:sitoramoxusenova@gmail.com" className="inline-block mt-2 text-blue-600 hover:underline font-medium">
          sitoramoxusenova@gmail.com
        </a>
      </Section>
    </div>
  );
}

function TermsUZ() {
  return (
    <div className="space-y-8">
      <p className="text-gray-700 leading-relaxed border-l-4 border-blue-500 pl-4 bg-blue-50 py-3 pr-4 rounded-r-lg">
        Ushbu Foydalanish Shartlari ("Shartlar") <strong>Targenix.uz</strong> ("Xizmat", "biz", "bizning")
        dan foydalanishingizni tartibga soladi. Xizmatga kirish yoki foydalanish orqali siz ushbu
        Shartlarga rioya qilishga rozilik bildirasiz. Agar rozi bo'lmasangiz, Xizmatdan foydalanmang.
      </p>

      <Section title="1. Xizmat Tavsifi">
        <p>Targenix.uz — Facebook Lead Ads ni bildirishnoma va CRM tizimlari bilan bog'laydigan xususiy integratsiya platformasi. Xizmat hisob egalariga quyidagilarga imkon beradi:</p>
        <ul className="mt-3 space-y-2">
          {[
            "Facebook Login orqali Facebook hisoblari va Sahifalarini ulash",
            "Webhook orqali Facebook Lead Ad formalaridan lead ma'lumotlarini qabul qilish",
            "Lead ma'lumotlarini Telegram botlari va sozlangan maqsadli veb-saytlarga yo'naltirish",
            "Lead qayta ishlash holati va webhook sog'lig'ini kuzatish",
          ].map(i => <Li key={i} color="blue">{i}</Li>)}
        </ul>
        <p className="mt-3">Xizmat o'zlarining Facebook reklama kampaniyalarini boshqaradigan biznes operatorlari uchun mo'ljallangan. Bu iste'molchilarga yo'naltirilgan mahsulot emas.</p>
      </Section>

      <Section title="2. Foydalanuvchi Majburiyatlari">
        <p>Xizmatdan foydalanish orqali siz quyidagilarga rozilik bildirasiz:</p>
        <ul className="mt-3 space-y-2">
          {[
            "Xizmatni faqat qonuniy maqsadlar uchun va barcha qo'llaniladigan qonun va qoidalarga muvofiq ishlatish",
            "Har doim Facebook Platforma Siyosati va Meta Foydalanish Shartlariga rioya qilish",
            "Shaxsiy ma'lumotlarini yig'ish va qayta ishlashdan oldin lead forma respondentlaridan barcha zarur rozilikni olish",
            "Kirish ma'lumotlarini (tokenlar, API kalitlari) maxfiy saqlash va ruxsatsiz shaxslar bilan ulashmaslik",
            "Xizmatni teskari muhandislik qilishga, dekompilatsiya qilishga yoki buzishga urinmaslik",
            "Xizmatni 13 yoshdan kichik bolalar ma'lumotlarini qayta ishlash uchun ishlatmaslik",
          ].map(i => <Li key={i} color="green">{i}</Li>)}
        </ul>
      </Section>

      <Section title="3. Javobgarlikni Cheklash">
        <p>Qo'llaniladigan qonun tomonidan ruxsat etilgan maksimal darajada:</p>
        <ul className="mt-3 space-y-2">
          {[
            "Xizmat har qanday aniq yoki nazarda tutilgan kafolatlarsiz \"bor holida\" taqdim etiladi",
            "Biz Xizmatdan foydalanishingizdan kelib chiqadigan bilvosita, tasodifiy, maxsus, oqibatli yoki jazo zararlar uchun javobgar emasmiz",
            "Biz Facebook dan olingan lead ma'lumotlarining aniqligi, to'liqligi yoki qonuniyligi uchun javobgar emasmiz",
            "Biz Facebook API o'zgarishlari, ishlamay qolish yoki siyosat yangilanishlari natijasida yuzaga keladigan xizmat uzilishlari uchun javobgar emasmiz",
            "Xizmatdan kelib chiqadigan har qanday da'vo uchun sizga bo'lgan umumiy javobgarligimiz 100 AQSh dollaridan oshmasligi kerak",
          ].map(i => <Li key={i} color="orange">{i}</Li>)}
        </ul>
      </Section>

      <Section title="4. Foydalanish Shartlari">
        <p>Xizmatdan foydalanishingizga quyidagi shartlar qo'llaniladi:</p>
        <ul className="mt-3 space-y-2">
          {[
            "Xizmatdan foydalanish uchun kamida 18 yoshda bo'lishingiz kerak",
            "Hisobingiz ostida sodir bo'ladigan barcha faoliyat uchun siz javobgarsiz",
            "Xizmatni spam, so'ralmagan xabarlar yuborish yoki firibgarlik faoliyatida ishlatmaslik kerak",
            "Xizmat infratuzilmasini haddan tashqari yuklashga yoki buzishga urinmaslik kerak",
            "Xizmat faqat o'zingizga tegishli yoki boshqarish uchun aniq vakolatingiz bor Facebook Lead Ad kampaniyalaridan leadlarni qayta ishlash uchun ishlatilishi mumkin",
          ].map(i => <Li key={i} color="purple">{i}</Li>)}
        </ul>
      </Section>

      <Section title="5. Intellektual Mulk">
        <p>Dasturiy ta'minot, dizayn va hujjatlar bilan cheklanmagan holda Xizmattagi barcha intellektual mulk huquqlari Targenix.uz ga tegishli. Sizga Xizmatni faqat mo'ljallangan maqsad uchun ishlatish uchun cheklangan, eksklyuziv bo'lmagan, o'tkazib bo'lmaydigan litsenziya beriladi. Xizmat asosida nusxa ko'chirish, o'zgartirish, tarqatish yoki hosilaviy asarlar yaratish mumkin emas.</p>
      </Section>

      <Section title="6. Tugatish">
        <p>Biz sizning Shartlarni yoki qo'llaniladigan qonunni buzganligingizni aniqlaganimizda, bildirishnoma bilan yoki bildirishnomasiz istalgan vaqtda Xizmatga kirishingizni to'xtatib qo'yish yoki tugatish huquqini saqlab qolamiz. Tugatilgandan so'ng, Xizmatdan foydalanish huquqingiz darhol to'xtaydi va biz Maxfiylik Siyosatimizga muvofiq ma'lumotlaringizni o'chirishimiz mumkin.</p>
      </Section>

      <Section title="7. Shartlarni O'zgartirish Huquqi">
        <p>Biz ushbu Shartlarni istalgan vaqtda o'zgartirish huquqini saqlab qolamiz. O'zgarishlar yangilangan "Oxirgi yangilanish" sanasi bilan ushbu sahifaga joylashtirilgandan so'ng kuchga kiradi. Har qanday o'zgarishlardan so'ng Xizmatdan foydalanishni davom ettirishingiz yangi Shartlarni qabul qilishingizni anglatadi. Ushbu Shartlarni vaqti-vaqti bilan ko'rib chiqishingizni tavsiya qilamiz.</p>
      </Section>

      <Section title="8. Qo'llaniladigan Qonun">
        <p>Ushbu Shartlar qo'llaniladigan qonunga muvofiq boshqariladi va talqin qilinadi. Ushbu Shartlardan yoki Xizmatdan foydalanishingizdan kelib chiqadigan har qanday nizolar yaxshi niyatli muzokaralar orqali hal qilinadi. Muzokaralar muvaffaqiyatsiz bo'lsa, nizolar Xizmat operatori joylashgan yurisdiktsiyaning vakolatli sudlariga topshiriladi.</p>
      </Section>

      <Section title="9. Aloqa">
        <p>Ushbu Foydalanish Shartlari bo'yicha savollar uchun biz bilan bog'laning:</p>
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
  const colors: Record<string, string> = { blue: "bg-blue-500", green: "bg-green-500", orange: "bg-orange-500", purple: "bg-purple-500" };
  return (
    <li className="flex items-start gap-2">
      <span className={`mt-2 w-2 h-2 rounded-full ${colors[color] ?? "bg-gray-400"} flex-shrink-0`} />
      <span>{children}</span>
    </li>
  );
}
