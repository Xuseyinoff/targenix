import { useState, useRef, useCallback, type ChangeEvent } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  resolveTemplate,
  makePreviewContext,
  FN_GROUPS,
  type TemplateContext,
  type FnDef,
} from "@/lib/expressionEngine";

interface ExpressionInputProps {
  value:          string;
  onChange:       (v: string) => void;
  placeholder?:   string;
  multiline?:     boolean;
  ctx?:           TemplateContext;
  /** Variable paths available in the context, e.g. ["trigger.name", "trigger.phone"] */
  variables?:     string[];
  className?:     string;
  rows?:          number;
}

// ─── Live preview ─────────────────────────────────────────────────────────────

function PreviewBadge({ value, ctx }: { value: string; ctx: TemplateContext }) {
  if (!value.includes("{{")) return null;
  try {
    const result = resolveTemplate(value, ctx);
    const display = result.length > 80 ? result.slice(0, 80) + "…" : result;
    return (
      <span className="inline-flex items-center gap-1 ml-1 px-1.5 py-0.5 rounded text-[10px] bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 font-mono max-w-full truncate">
        ↳ {display || "‹empty›"}
      </span>
    );
  } catch {
    return (
      <span className="inline-flex items-center gap-1 ml-1 px-1.5 py-0.5 rounded text-[10px] bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800 font-mono">
        ↳ error
      </span>
    );
  }
}

// ─── Variable chip ────────────────────────────────────────────────────────────

function VarChip({ path, onInsert }: { path: string; onInsert: (v: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onInsert(`{{${path}}}`)}
      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-mono bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-700 hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors"
    >
      {path}
    </button>
  );
}

// ─── Function card ────────────────────────────────────────────────────────────

function FnCard({ fn, onInsert }: { fn: FnDef; onInsert: (v: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onInsert(fn.example)}
      className="w-full text-left p-2 rounded-md hover:bg-muted/50 transition-colors group"
    >
      <div className="flex items-center gap-2">
        <code className="text-xs font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded">
          {fn.name}
        </code>
        <span className="text-xs text-muted-foreground truncate">{fn.desc}</span>
      </div>
      <div className="text-[10px] font-mono text-muted-foreground/70 mt-0.5 truncate">
        {fn.signature}
      </div>
    </button>
  );
}

// ─── Reference popover content ────────────────────────────────────────────────

function ReferencePopover({
  variables,
  ctx,
  onInsert,
}: {
  variables: string[];
  ctx:       TemplateContext;
  onInsert:  (v: string) => void;
}) {
  const groups = FN_GROUPS;
  const defaultTab = variables.length > 0 ? "vars" : groups[0].group.toLowerCase();

  return (
    <div className="w-[380px] max-h-[420px] flex flex-col">
      <div className="px-3 pt-3 pb-1 border-b border-border">
        <p className="text-xs font-semibold text-foreground">Expression Builder</p>
        <p className="text-[10px] text-muted-foreground mt-0.5">
          Click an item to insert it at cursor position
        </p>
      </div>

      <Tabs defaultValue={defaultTab} className="flex-1 overflow-hidden flex flex-col">
        <TabsList className="mx-3 mt-2 h-7 gap-0.5 flex-wrap justify-start bg-muted/50">
          {variables.length > 0 && (
            <TabsTrigger value="vars" className="text-[10px] h-5 px-2">Variables</TabsTrigger>
          )}
          {groups.map(g => (
            <TabsTrigger key={g.group} value={g.group.toLowerCase()} className="text-[10px] h-5 px-2">
              {g.group}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="flex-1 overflow-y-auto px-3 pb-3 mt-1">
          {variables.length > 0 && (
            <TabsContent value="vars" className="mt-0 space-y-1.5">
              <p className="text-[10px] text-muted-foreground pt-1">Available data paths:</p>
              <div className="flex flex-wrap gap-1">
                {variables.map(v => (
                  <VarChip key={v} path={v} onInsert={onInsert} />
                ))}
              </div>
              {/* Preview section */}
              <div className="mt-3 pt-2 border-t border-border">
                <p className="text-[10px] font-medium text-muted-foreground mb-1">Sample values:</p>
                <div className="space-y-0.5">
                  {variables.slice(0, 8).map(v => {
                    const val = resolveTemplate(`{{${v}}}`, ctx);
                    return (
                      <div key={v} className="flex items-center gap-2 text-[10px]">
                        <span className="font-mono text-blue-600 dark:text-blue-400 shrink-0">{v}</span>
                        <span className="text-muted-foreground truncate">= {val || "‹empty›"}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </TabsContent>
          )}

          {groups.map(g => (
            <TabsContent key={g.group} value={g.group.toLowerCase()} className="mt-0 space-y-0.5">
              {g.fns.map(fn => (
                <FnCard key={fn.name} fn={fn} onInsert={onInsert} />
              ))}
            </TabsContent>
          ))}
        </div>
      </Tabs>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ExpressionInput({
  value,
  onChange,
  placeholder,
  multiline = false,
  ctx,
  variables = [],
  className,
  rows = 3,
}: ExpressionInputProps) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const previewCtx = ctx ?? makePreviewContext();

  const hasExpression = value.includes("{{");

  const handleInsert = useCallback(
    (snippet: string) => {
      const el = inputRef.current;
      if (!el) { onChange(value + snippet); setOpen(false); return; }

      const start = el.selectionStart ?? value.length;
      const end   = el.selectionEnd   ?? value.length;
      const next  = value.slice(0, start) + snippet + value.slice(end);
      onChange(next);
      setOpen(false);

      // restore cursor after the inserted snippet
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + snippet.length;
        el.setSelectionRange(pos, pos);
      });
    },
    [value, onChange]
  );

  const fxButton = (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 rounded text-[10px] font-bold shrink-0 z-10",
            hasExpression
              ? "text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-900/30 hover:bg-violet-100 dark:hover:bg-violet-900/50"
              : "text-muted-foreground hover:text-foreground"
          )}
          title="Expression builder"
        >
          fx
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="p-0 border border-border shadow-xl" style={{ width: "auto" }}>
        <ReferencePopover
          variables={variables}
          ctx={previewCtx}
          onInsert={handleInsert}
        />
      </PopoverContent>
    </Popover>
  );

  return (
    <div className="flex flex-col gap-0.5 w-full">
      <div className="relative w-full">
        {multiline ? (
          <Textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            value={value}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
            placeholder={placeholder}
            rows={rows}
            className={cn("pr-8 font-mono text-xs resize-none", className)}
          />
        ) : (
          <Input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            value={value}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
            placeholder={placeholder}
            className={cn("pr-8 font-mono text-xs", className)}
          />
        )}
        {fxButton}
      </div>

      {hasExpression && (
        <div className="flex items-start gap-1 flex-wrap">
          <PreviewBadge value={value} ctx={previewCtx} />
        </div>
      )}
    </div>
  );
}

export default ExpressionInput;
