/**
 * Inline SVG flags for the language switcher.
 * Renders reliably on Windows (where emoji flags fall back to text codes).
 * Aspect ratio normalized to 4:3 with rounded corners so all three look balanced
 * in the dropdown — matches Wapi's flag tile style.
 */
import { SVGProps } from "react";

type FlagProps = SVGProps<SVGSVGElement> & { className?: string };

function FlagFrame({ children, className, ...rest }: FlagProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 18"
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMidYMid slice"
      className={`overflow-hidden rounded-[3px] shrink-0 ring-1 ring-black/5 ${className ?? ""}`}
      {...rest}
    >
      {children}
    </svg>
  );
}

export function FlagUZ(props: FlagProps) {
  return (
    <FlagFrame {...props}>
      {/* Sky blue / white / green horizontal stripes with thin red separators */}
      <rect width="24" height="6" fill="#1eb1e7" />
      <rect y="6" width="24" height="6" fill="#ffffff" />
      <rect y="12" width="24" height="6" fill="#1eb53a" />
      <rect y="5.5" width="24" height="1" fill="#ce1126" />
      <rect y="11.5" width="24" height="1" fill="#ce1126" />
      {/* Crescent + 3 simplified stars in the top blue band */}
      <circle cx="4.4" cy="3" r="1.55" fill="#ffffff" />
      <circle cx="4.95" cy="3" r="1.3" fill="#1eb1e7" />
      <circle cx="7.2" cy="2.4" r="0.32" fill="#ffffff" />
      <circle cx="8.4" cy="2.4" r="0.32" fill="#ffffff" />
      <circle cx="9.6" cy="2.4" r="0.32" fill="#ffffff" />
    </FlagFrame>
  );
}

export function FlagRU(props: FlagProps) {
  return (
    <FlagFrame {...props}>
      {/* White / blue / red horizontal stripes */}
      <rect width="24" height="6" fill="#ffffff" />
      <rect y="6" width="24" height="6" fill="#0039a6" />
      <rect y="12" width="24" height="6" fill="#d52b1e" />
    </FlagFrame>
  );
}

export function FlagGB(props: FlagProps) {
  return (
    <FlagFrame {...props}>
      {/* Union Jack — blue field with white-edged red cross + diagonal saltires */}
      <rect width="24" height="18" fill="#012169" />
      {/* White diagonals (saltire) */}
      <path d="M0 0 L24 18 M24 0 L0 18" stroke="#ffffff" strokeWidth="3.6" />
      {/* Red diagonals (offset to one side per heraldic rules — simplified for tiny sizes) */}
      <path d="M0 0 L24 18 M24 0 L0 18" stroke="#c8102e" strokeWidth="1.8" />
      {/* White cross */}
      <path d="M12 0 V18 M0 9 H24" stroke="#ffffff" strokeWidth="6" />
      {/* Red cross */}
      <path d="M12 0 V18 M0 9 H24" stroke="#c8102e" strokeWidth="3.6" />
    </FlagFrame>
  );
}

export type LocaleCode = "uz" | "ru" | "en";

export function Flag({ code, className }: { code: LocaleCode; className?: string }) {
  if (code === "uz") return <FlagUZ className={className} />;
  if (code === "ru") return <FlagRU className={className} />;
  return <FlagGB className={className} />;
}
