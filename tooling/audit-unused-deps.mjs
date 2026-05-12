/**
 * Verify each "unused" dependency from knip is actually unused.
 *
 * For each package name, grep ALL .ts, .tsx, .js, .mjs, .cjs, .config.*
 * files for any of:
 *   - `from "<pkg>"` or `from '<pkg>'`
 *   - `from "<pkg>/...something"` (subpath imports)
 *   - `require("<pkg>")`
 *   - `import("<pkg>")`
 *
 * Also check config files (vite/postcss/tailwind/drizzle/tsconfig) that
 * often reference deps as plugins/strings.
 */
import { readdirSync, readFileSync, existsSync } from "fs";
import { join, relative, extname } from "path";

const ROOT = process.cwd();

const CANDIDATES = [
  // 29 dependencies
  "@ai-sdk/react",
  "@aws-sdk/client-s3",
  "@aws-sdk/s3-request-presigner",
  "@hookform/resolvers",
  "@radix-ui/react-accordion",
  "@radix-ui/react-aspect-ratio",
  "@radix-ui/react-context-menu",
  "@radix-ui/react-hover-card",
  "@radix-ui/react-menubar",
  "@radix-ui/react-navigation-menu",
  "@radix-ui/react-progress",
  "@radix-ui/react-radio-group",
  "@radix-ui/react-slider",
  "@radix-ui/react-toggle",
  "@radix-ui/react-toggle-group",
  "@streamdown/code",
  "@streamdown/mermaid",
  "cors",
  "date-fns",
  "embla-carousel-react",
  "framer-motion",
  "input-otp",
  "node-telegram-bot-api",
  "react-day-picker",
  "react-hook-form",
  "react-resizable-panels",
  "streamdown",
  "tailwindcss-animate",
  "vaul",
  // 6 devDependencies
  "@tailwindcss/typography",
  "autoprefixer",
  "pnpm",
  "postcss",
  "tailwindcss",
  "tw-animate-css",
];

const FILE_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".html", ".css"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".claude"]);

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      walk(p, out);
    } else if (FILE_EXTS.has(extname(e.name)) || e.name === "package.json") {
      out.push(p);
    }
  }
  return out;
}

const allFiles = walk(ROOT);
const fileCache = new Map();
function read(f) {
  if (!fileCache.has(f)) {
    try { fileCache.set(f, readFileSync(f, "utf8")); } catch { fileCache.set(f, ""); }
  }
  return fileCache.get(f);
}

console.log(`Scanning ${allFiles.length} files for ${CANDIDATES.length} package references...\n`);

const results = {};

for (const pkg of CANDIDATES) {
  // Escape package name for regex
  const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Patterns to match — capture file:line for each
  const patterns = [
    new RegExp(`from\\s+["']${esc}(?:["']|/)`, "g"),
    new RegExp(`require\\(\\s*["']${esc}(?:["']|/)`, "g"),
    new RegExp(`import\\(\\s*["']${esc}(?:["']|/)`, "g"),
  ];
  // For config-style references (plugins arrays, css references), package
  // may appear as a string literal anywhere.
  const stringPattern = new RegExp(`["']${esc}(?:["']|/)`, "g");

  const hits = [];
  for (const f of allFiles) {
    // Skip the package.json itself and the lockfile
    const rel = relative(ROOT, f).replace(/\\/g, "/");
    if (rel === "package.json" || rel.endsWith("/package.json") || rel === "pnpm-lock.yaml") continue;
    // Skip this very audit script
    if (rel.includes("tooling/audit-unused-deps")) continue;

    const content = read(f);
    if (!content) continue;

    // 1. Import-style hits (definitive)
    let importHit = false;
    for (const re of patterns) {
      re.lastIndex = 0;
      if (re.test(content)) { importHit = true; break; }
    }

    // 2. Config-style string references (only for config / non-source files)
    let stringHit = false;
    const isConfig = /\.config\.(ts|js|mjs|cjs)$/.test(rel) ||
                     /postcss|tailwind|drizzle|vite|tsconfig/.test(rel.split("/").pop() || "") ||
                     /\.(css|html|json)$/.test(rel);
    if (!importHit && isConfig) {
      stringPattern.lastIndex = 0;
      if (stringPattern.test(content)) stringHit = true;
    }

    if (importHit || stringHit) {
      hits.push({ file: rel, kind: importHit ? "import" : "string-in-config" });
    }
  }

  results[pkg] = hits;
}

// ── Report ─────────────────────────────────────────────────────────────────
const unused = [];
const used = [];
for (const pkg of CANDIDATES) {
  if (results[pkg].length === 0) {
    unused.push(pkg);
  } else {
    used.push({ pkg, hits: results[pkg] });
  }
}

console.log("=".repeat(80));
console.log("DEPENDENCY USAGE AUDIT");
console.log("=".repeat(80));

console.log(`\n🟢 SAFELY UNUSED (zero imports / config refs): ${unused.length}`);
for (const p of unused) console.log(`   ${p}`);

console.log(`\n🔴 STILL REFERENCED — keep these: ${used.length}`);
for (const u of used) {
  console.log(`   ${u.pkg}:`);
  for (const h of u.hits.slice(0, 5)) {
    console.log(`      [${h.kind}] ${h.file}`);
  }
  if (u.hits.length > 5) console.log(`      ... and ${u.hits.length - 5} more`);
}

console.log("\n" + "=".repeat(80));
console.log(`Summary: ${unused.length} safe to remove, ${used.length} still referenced`);
