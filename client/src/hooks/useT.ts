import { useLocale } from "@/contexts/LocaleContext";
import en from "@/locales/en.json";
import uz from "@/locales/uz.json";
import ru from "@/locales/ru.json";

type DeepRecord = { [key: string]: string | DeepRecord };

const translations: Record<string, DeepRecord> = { en, uz, ru };

function getNestedValue(obj: DeepRecord, path: string): string | undefined {
  const parts = path.split(".");
  let current: string | DeepRecord = obj;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as DeepRecord)[part];
  }
  return typeof current === "string" ? current : undefined;
}

/**
 * Simple translation hook.
 * Usage: const t = useT();  then  t("leads.title")
 * Supports interpolation: t("leads.exportedLeads", { count: 5 })
 * Falls back to English if key missing in current locale.
 */
export function useT() {
  const { locale } = useLocale();

  return function t(key: string, vars?: Record<string, string | number>): string {
    const dict = translations[locale] ?? translations["en"];
    let value =
      getNestedValue(dict as DeepRecord, key) ??
      getNestedValue(translations["en"] as DeepRecord, key) ??
      key;

    if (vars) {
      Object.entries(vars).forEach(([k, v]) => {
        value = value.replace(`{{${k}}}`, String(v));
      });
    }

    return value;
  };
}
