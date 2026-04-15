import { Facebook, Instagram, Search, X, ChevronDown, Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { useState, useMemo } from "react";
import type { LeadFilters } from "@/hooks/useLeadFilters";
import { useT } from "@/hooks/useT";

export interface FormsIndexItem {
  pageId: string;
  pageName?: string | null;
  formId: string;
  formName?: string | null;
  platform?: string;
}

interface LeadFiltersProps {
  filters: LeadFilters;
  pageOptions: FormsIndexItem[];
  formOptions: FormsIndexItem[];
  allFormsIndex: FormsIndexItem[];
}

function PlatformIcon({ platform }: { platform?: string }) {
  if (platform === "ig") {
    return (
      <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-gradient-to-br from-purple-500 via-pink-500 to-orange-400 shrink-0">
        <Instagram className="h-2.5 w-2.5 text-white" />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-blue-600 shrink-0">
      <Facebook className="h-2.5 w-2.5 text-white" />
    </span>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors border shrink-0",
        active
          ? "bg-primary/20 text-foreground border-primary/40 hover:bg-primary/25"
          : "bg-muted/30 text-muted-foreground border-border/70 hover:border-border hover:text-foreground hover:bg-muted/45"
      )}
    >
      {children}
    </button>
  );
}

// ─── Searchable Pages Dropdown ────────────────────────────────────────────────

function PagesDropdown({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: FormsIndexItem[];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const selected = options.find((p) => p.pageId === value);
  const label = selected ? (selected.pageName ?? selected.pageId) : t("leads.filters.pagesAll");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "flex h-9 items-center justify-between gap-1.5 rounded-md border bg-background px-3 text-sm transition-colors",
            "hover:bg-accent hover:text-accent-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            "min-w-[140px] max-w-[200px]",
            value !== "ALL" ? "border-primary/40 text-foreground" : "text-muted-foreground"
          )}
        >
          {selected && <PlatformIcon platform={selected.platform} />}
          <span className="flex-1 text-left truncate">{label}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[220px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search pages..." />
          <CommandList>
            <CommandEmpty>No pages found.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="ALL"
                onSelect={() => { onChange("ALL"); setOpen(false); }}
                className="gap-2"
              >
                <Check className={cn("h-4 w-4 shrink-0", value === "ALL" ? "opacity-100" : "opacity-0")} />
                <span className="text-sm">{t("leads.filters.pagesAll")}</span>
              </CommandItem>
              {options.map((p) => (
                <CommandItem
                  key={p.pageId}
                  value={`${p.pageName ?? ""} ${p.pageId}`}
                  onSelect={() => { onChange(p.pageId); setOpen(false); }}
                  className="gap-2"
                >
                  <Check className={cn("h-4 w-4 shrink-0", value === p.pageId ? "opacity-100" : "opacity-0")} />
                  <PlatformIcon platform={p.platform} />
                  <span className="truncate">{p.pageName ?? p.pageId}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ─── Searchable Forms Dropdown (grouped by page) ──────────────────────────────

function FormsDropdown({
  value,
  onChange,
  options,
  allFormsIndex,
}: {
  value: string;
  onChange: (v: string) => void;
  options: FormsIndexItem[];
  allFormsIndex: FormsIndexItem[];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  // Find selected form label from full index (not just filtered options)
  const selected = allFormsIndex.find((f) => f.formId === value);
  const label = selected ? (selected.formName ?? selected.formId) : t("leads.filters.formsAll");

  // Group options by page
  const groups = useMemo(() => {
    const map = new Map<string, { pageName: string; platform?: string; forms: FormsIndexItem[] }>();
    for (const f of options) {
      const key = f.pageId;
      if (!map.has(key)) {
        map.set(key, { pageName: f.pageName ?? f.pageId, platform: f.platform, forms: [] });
      }
      map.get(key)!.forms.push(f);
    }
    return Array.from(map.entries());
  }, [options]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "flex h-9 items-center justify-between gap-1.5 rounded-md border bg-background px-3 text-sm transition-colors",
            "hover:bg-accent hover:text-accent-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            "min-w-[140px] max-w-[220px]",
            value !== "ALL" ? "border-primary/40 text-foreground" : "text-muted-foreground"
          )}
        >
          <span className="flex-1 text-left truncate">{label}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search forms..." />
          <CommandList className="max-h-[320px]">
            <CommandEmpty>No forms found.</CommandEmpty>
            {/* All Forms option */}
            <CommandGroup>
              <CommandItem
                value="ALL"
                onSelect={() => { onChange("ALL"); setOpen(false); }}
                className="gap-2"
              >
                <Check className={cn("h-4 w-4 shrink-0", value === "ALL" ? "opacity-100" : "opacity-0")} />
                <span className="text-sm">{t("leads.filters.formsAll")}</span>
              </CommandItem>
            </CommandGroup>

            {/* Grouped by page */}
            {groups.map(([pageId, group]) => (
              <CommandGroup
                key={pageId}
                heading={
                  <span className="flex items-center gap-1.5">
                    <PlatformIcon platform={group.platform} />
                    <span className="font-semibold text-foreground">{group.pageName}</span>
                  </span>
                }
              >
                {group.forms.map((f) => (
                  <CommandItem
                    key={f.formId}
                    value={`${group.pageName} ${f.formName ?? ""} ${f.formId}`}
                    onSelect={() => { onChange(f.formId); setOpen(false); }}
                    className="gap-2 pl-4"
                  >
                    <Check className={cn("h-4 w-4 shrink-0", value === f.formId ? "opacity-100" : "opacity-0")} />
                    <span className="truncate text-muted-foreground">{f.formName ?? f.formId}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function LeadFilters({ filters, pageOptions, formOptions, allFormsIndex }: LeadFiltersProps) {
  const t = useT();
  const {
    search, platformFilter, statusFilter, hasActiveFilters,
    pageIdFilter, formIdFilter,
    handleSearchChange, handlePlatformChange, handleStatusChange,
    handlePageIdChange, handleFormIdChange, clearFilters,
  } = filters;

  return (
    <div className="space-y-2">
      {/* Search — always visible */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          placeholder={t("leads.filters.searchPlaceholder")}
          className="pl-9 h-9 md:max-w-[500px]"
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
        />
      </div>

      {/* Mobile: horizontal chip scroll */}
      <div className="flex gap-2 overflow-x-auto pb-1 md:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <Chip
          active={platformFilter === "ALL" && statusFilter === "ALL"}
          onClick={() => { handlePlatformChange("ALL"); handleStatusChange("ALL"); }}
        >
          {t("leads.filters.all")}
        </Chip>
        <Chip
          active={platformFilter === "ig"}
          onClick={() => handlePlatformChange(platformFilter === "ig" ? "ALL" : "ig")}
        >
          <Instagram className="h-3 w-3" />{t("leads.filters.instagram")}
        </Chip>
        <Chip
          active={platformFilter === "fb"}
          onClick={() => handlePlatformChange(platformFilter === "fb" ? "ALL" : "fb")}
        >
          <Facebook className="h-3 w-3" />{t("leads.filters.facebook")}
        </Chip>
        <Chip
          active={statusFilter === "RECEIVED"}
          onClick={() => handleStatusChange(statusFilter === "RECEIVED" ? "ALL" : "RECEIVED")}
        >
          {t("leads.filters.delivered")}
        </Chip>
        <Chip
          active={statusFilter === "PENDING"}
          onClick={() => handleStatusChange(statusFilter === "PENDING" ? "ALL" : "PENDING")}
        >
          {t("leads.filters.pending")}
        </Chip>
        <Chip
          active={statusFilter === "FAILED"}
          onClick={() => handleStatusChange(statusFilter === "FAILED" ? "ALL" : "FAILED")}
        >
          {t("leads.filters.issues")}
        </Chip>
        {hasActiveFilters && (
          <Chip active={false} onClick={clearFilters}>
            <X className="h-3 w-3" />{t("leads.filters.clear")}
          </Chip>
        )}
      </div>

      {/* Desktop: dropdown selects */}
      <div className="hidden md:flex flex-wrap gap-2 items-center">
        {/* Platform — simple 3-item select, no search needed */}
        <Select value={platformFilter} onValueChange={handlePlatformChange}>
          <SelectTrigger className="w-[130px] h-9">
            <SelectValue placeholder={t("leads.filters.platformPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t("leads.filters.allPlatforms")}</SelectItem>
            <SelectItem value="fb">
              <span className="flex items-center gap-2">
                <Facebook className="h-3.5 w-3.5 text-blue-600" />{t("leads.filters.facebook")}
              </span>
            </SelectItem>
            <SelectItem value="ig">
              <span className="flex items-center gap-2">
                <Instagram className="h-3.5 w-3.5 text-pink-500" />{t("leads.filters.instagram")}
              </span>
            </SelectItem>
          </SelectContent>
        </Select>

        {/* Pages — searchable */}
        {pageOptions.length > 0 && (
          <PagesDropdown
            value={pageIdFilter}
            onChange={handlePageIdChange}
            options={pageOptions}
          />
        )}

        {/* Forms — searchable, grouped by page */}
        {formOptions.length > 0 && (
          <FormsDropdown
            value={formIdFilter}
            onChange={handleFormIdChange}
            options={formOptions}
            allFormsIndex={allFormsIndex}
          />
        )}

        {/* Status — simple 4-item select */}
        <Select value={statusFilter} onValueChange={handleStatusChange}>
          <SelectTrigger className="w-[120px] h-9">
            <SelectValue placeholder={t("leads.filters.statusPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t("leads.filters.allStatus")}</SelectItem>
            <SelectItem value="PENDING">{t("leads.filters.pending")}</SelectItem>
            <SelectItem value="RECEIVED">{t("leads.filters.delivered")}</SelectItem>
            <SelectItem value="FAILED">{t("leads.filters.issues")}</SelectItem>
          </SelectContent>
        </Select>

        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 px-2 text-muted-foreground"
            onClick={clearFilters}
          >
            {t("leads.filters.clear")}
          </Button>
        )}
      </div>
    </div>
  );
}
