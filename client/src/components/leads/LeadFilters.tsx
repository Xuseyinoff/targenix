import { Facebook, Instagram, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { LeadFilters } from "@/hooks/useLeadFilters";

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
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors border shrink-0",
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

export function LeadFilters({ filters, pageOptions, formOptions }: LeadFiltersProps) {
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
          placeholder="Search name, phone..."
          className="pl-9 h-9 md:max-w-[500px]"
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
        />
      </div>

      {/* Mobile: horizontal chip scroll */}
      <div className="flex gap-2 overflow-x-auto pb-1 md:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <Chip active={platformFilter === "ALL" && statusFilter === "ALL"} onClick={() => { handlePlatformChange("ALL"); handleStatusChange("ALL"); }}>
          All
        </Chip>
        <Chip active={platformFilter === "ig"} onClick={() => handlePlatformChange(platformFilter === "ig" ? "ALL" : "ig")}>
          <Instagram className="h-3 w-3" />Instagram
        </Chip>
        <Chip active={platformFilter === "fb"} onClick={() => handlePlatformChange(platformFilter === "fb" ? "ALL" : "fb")}>
          <Facebook className="h-3 w-3" />Facebook
        </Chip>
        <Chip active={statusFilter === "RECEIVED"} onClick={() => handleStatusChange(statusFilter === "RECEIVED" ? "ALL" : "RECEIVED")}>
          Received
        </Chip>
        <Chip active={statusFilter === "PENDING"} onClick={() => handleStatusChange(statusFilter === "PENDING" ? "ALL" : "PENDING")}>
          Pending
        </Chip>
        <Chip active={statusFilter === "FAILED"} onClick={() => handleStatusChange(statusFilter === "FAILED" ? "ALL" : "FAILED")}>
          Failed
        </Chip>
        {hasActiveFilters && (
          <Chip active={false} onClick={clearFilters}>
            <X className="h-3 w-3" />Clear
          </Chip>
        )}
      </div>

      {/* Desktop: dropdown selects */}
      <div className="hidden md:flex flex-wrap gap-2">
        <Select value={platformFilter} onValueChange={handlePlatformChange}>
          <SelectTrigger className="w-[130px] h-9">
            <SelectValue placeholder="Platform" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Platforms</SelectItem>
            <SelectItem value="fb">
              <span className="flex items-center gap-2">
                <Facebook className="h-3.5 w-3.5 text-blue-600" />Facebook
              </span>
            </SelectItem>
            <SelectItem value="ig">
              <span className="flex items-center gap-2">
                <Instagram className="h-3.5 w-3.5 text-pink-500" />Instagram
              </span>
            </SelectItem>
          </SelectContent>
        </Select>

        {pageOptions.length > 0 && (
          <Select value={pageIdFilter} onValueChange={handlePageIdChange}>
            <SelectTrigger className="w-[160px] h-9">
              <SelectValue placeholder="All Pages" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Pages</SelectItem>
              {pageOptions.map((p) => (
                <SelectItem key={p.pageId} value={p.pageId}>
                  <span className="flex items-center gap-2">
                    <PlatformIcon platform={p.platform} />
                    {p.pageName}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {formOptions.length > 0 && (
          <Select value={formIdFilter} onValueChange={handleFormIdChange}>
            <SelectTrigger className="w-[160px] h-9">
              <SelectValue placeholder="All Forms" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Forms</SelectItem>
              {formOptions.map((f) => (
                <SelectItem key={f.formId} value={f.formId}>{f.formName}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Select value={statusFilter} onValueChange={handleStatusChange}>
          <SelectTrigger className="w-[120px] h-9">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Status</SelectItem>
            <SelectItem value="PENDING">Pending</SelectItem>
            <SelectItem value="RECEIVED">Received</SelectItem>
            <SelectItem value="FAILED">Failed</SelectItem>
          </SelectContent>
        </Select>

        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 px-2 text-muted-foreground"
            onClick={clearFilters}
          >
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}
