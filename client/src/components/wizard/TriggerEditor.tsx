/**
 * TriggerEditor — Step 1 of IntegrationWizardV2.
 *
 * Cascading Facebook account → page → lead-form picker. Each level only
 * appears once the level above is chosen. All selection state lives in the
 * parent wizard's WizardState; this component is a controlled view.
 *
 * Extracted from IntegrationWizardV2.tsx.
 */

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Facebook, FileText, User } from "lucide-react";
import { LoadingBar, EmptyHint } from "./wizardPrimitives";
import type { WizardState } from "@/pages/lead-routing/wizardTypes";

interface TriggerAccount {
  id: number;
  fbUserName: string;
  fbUserId: string;
}
interface TriggerPage {
  id: string;
  name: string;
}
interface TriggerForm {
  id: string;
  name: string;
  status?: string | null;
}

export interface TriggerEditorProps {
  accounts: ReadonlyArray<TriggerAccount>;
  loadingAccounts: boolean;
  pages: ReadonlyArray<TriggerPage>;
  loadingPages: boolean;
  forms: ReadonlyArray<TriggerForm>;
  loadingForms: boolean;
  state: WizardState;
  onPickAccount: (id: number, name: string) => void;
  onPickPage: (id: string, name: string) => void;
  onPickForm: (id: string, name: string) => void;
}

export function TriggerEditor({
  accounts,
  loadingAccounts,
  pages,
  loadingPages,
  forms,
  loadingForms,
  state,
  onPickAccount,
  onPickPage,
  onPickForm,
}: TriggerEditorProps) {
  return (
    <div className="space-y-4">
      {/* Account */}
      <div className="space-y-2">
        <Label className="text-[11px] font-bold uppercase tracking-widest text-slate-500 dark:text-muted-foreground flex items-center gap-1.5">
          <User className="h-3.5 w-3.5 text-primary" />
          Facebook account
        </Label>
        {loadingAccounts ? (
          <LoadingBar />
        ) : accounts.length === 0 ? (
          <EmptyHint
            message="No Facebook accounts connected yet."
            ctaLabel="Connect Facebook"
            href="/facebook-accounts"
          />
        ) : (
          <Select
            value={state.accountId ? String(state.accountId) : undefined}
            onValueChange={(v) => {
              const acc = accounts.find((a) => a.id === Number(v));
              if (acc) onPickAccount(acc.id, acc.fbUserName);
            }}
          >
            <SelectTrigger className="h-11 rounded-xl text-sm font-medium">
              <SelectValue placeholder="Select account" />
            </SelectTrigger>
            <SelectContent className="rounded-xl">
              {accounts.map((a) => (
                <SelectItem key={a.id} value={String(a.id)}>
                  {a.fbUserName || `Account #${a.id}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Page */}
      {state.accountId && (
        <div className="space-y-2">
          <Label className="text-[11px] font-bold uppercase tracking-widest text-slate-500 dark:text-muted-foreground flex items-center gap-1.5">
            <Facebook className="h-3.5 w-3.5 text-primary" />
            Page
          </Label>
          {loadingPages ? (
            <LoadingBar />
          ) : pages.length === 0 ? (
            <EmptyHint message="This account has no accessible pages." />
          ) : (
            <Select
              value={state.pageId || undefined}
              onValueChange={(v) => {
                const p = pages.find((x) => x.id === v);
                if (p) onPickPage(p.id, p.name);
              }}
            >
              <SelectTrigger className="h-11 rounded-xl text-sm font-medium">
                <SelectValue placeholder="Select page" />
              </SelectTrigger>
              <SelectContent className="rounded-xl">
                {pages.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {/* Form */}
      {state.pageId && (
        <div className="space-y-2">
          <Label className="text-[11px] font-bold uppercase tracking-widest text-slate-500 dark:text-muted-foreground flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5 text-primary" />
            Lead form
          </Label>
          {loadingForms ? (
            <LoadingBar />
          ) : forms.length === 0 ? (
            <EmptyHint message="No active lead forms on this page." />
          ) : (
            <Select
              value={state.formId || undefined}
              onValueChange={(v) => {
                const f = forms.find((x) => x.id === v);
                if (f) onPickForm(f.id, f.name);
              }}
            >
              <SelectTrigger className="h-11 rounded-xl text-sm font-medium">
                <SelectValue placeholder="Select form" />
              </SelectTrigger>
              <SelectContent className="rounded-xl">
                {forms.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}
    </div>
  );
}
