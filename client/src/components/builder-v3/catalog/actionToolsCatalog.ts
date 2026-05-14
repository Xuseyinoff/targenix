/**
 * actionToolsCatalog — the right-hand "Tools" column of the action picker.
 *
 * Mirrors Albato's tool list so the action modal layout matches 1:1:
 * Albato AI, JavaScript, Python, Branching, Filter (stop on condition),
 * Router, Iterator, Aggregator, Find&replace, Parse JSON, Phone formatting,
 * Date modification, Mathematical operation, …
 *
 * Phase 1: every entry is rendered disabled with a "Coming soon" tag.
 * Building any of these requires a separate per-tool implementation
 * (some are UI sugar, some need new server endpoints) so they're a
 * deliberate future-work hook, not a stub for an existing feature.
 */

import type { AppToolsItem } from "@/components/builder-v3/shared/AppToolsPicker";

export interface ActionTool extends AppToolsItem {
  category: ToolCategory;
}

export type ToolCategory =
  | "ai"
  | "logic"
  | "formatting"
  | "rows"
  | "advanced";

export const ACTION_TOOLS: ActionTool[] = [
  // AI ─────────────────────────────────────────────────────────────────────
  {
    id: "albato_ai",
    name: "Albato AI",
    icon: "Sparkles",
    description: "Ask AI to summarise, classify or enrich a lead.",
    available: false,
    category: "ai",
  },

  // Logic ──────────────────────────────────────────────────────────────────
  {
    id: "branching",
    name: "Branching",
    icon: "GitBranch",
    description: "Split the workflow into parallel paths.",
    available: false,
    category: "logic",
  },
  {
    id: "filter",
    name: "Stop on condition (Filter)",
    icon: "Filter",
    description: "Stop the automation when a condition is not met.",
    available: false,
    category: "logic",
  },
  {
    id: "router",
    name: "Router",
    icon: "Workflow",
    description: "Send to one path when matched, another when not.",
    available: false,
    category: "logic",
  },
  {
    id: "iterator",
    name: "Iterator",
    icon: "Repeat",
    description: "Process each array item separately.",
    available: false,
    category: "logic",
  },

  // Code / Advanced ────────────────────────────────────────────────────────
  {
    id: "javascript",
    name: "JavaScript",
    icon: "Braces",
    description: "Run a small JS snippet on the lead.",
    available: false,
    category: "advanced",
  },
  {
    id: "python",
    name: "Python",
    icon: "Code2",
    description: "Run a Python snippet (sandboxed).",
    available: false,
    category: "advanced",
  },
  {
    id: "delay",
    name: "Automation delay",
    icon: "Timer",
    description: "Wait N minutes before the next step.",
    available: false,
    category: "advanced",
  },

  // Formatting ─────────────────────────────────────────────────────────────
  {
    id: "phone_format",
    name: "Phone number formatting",
    icon: "Phone",
    description: "Normalise phones to E.164 / 998 prefix.",
    available: false,
    category: "formatting",
  },
  {
    id: "date_format",
    name: "Date and time modification",
    icon: "Calendar",
    description: "Reformat or shift timestamps.",
    available: false,
    category: "formatting",
  },
  {
    id: "find_replace",
    name: "Find & replace",
    icon: "Search",
    description: "Replace substrings inside a value.",
    available: false,
    category: "formatting",
  },
  {
    id: "regex_parse",
    name: "Value Parser (Regex)",
    icon: "Regex",
    description: "Extract a piece of a value with a regex.",
    available: false,
    category: "formatting",
  },

  // Rows / arrays ──────────────────────────────────────────────────────────
  {
    id: "aggregator",
    name: "Aggregator",
    icon: "Layers",
    description: "Collapse rows into one record.",
    available: false,
    category: "rows",
  },
  {
    id: "parse_json",
    name: "Parse JSON",
    icon: "FileJson",
    description: "Parse a JSON string into structured fields.",
    available: false,
    category: "rows",
  },
];

/** Tools filtered to a specific sidebar category. */
export function toolsByCategory(category: ToolCategory): ActionTool[] {
  return ACTION_TOOLS.filter((t) => t.category === category);
}
