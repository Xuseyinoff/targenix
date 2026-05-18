/**
 * IntegrationWizardV2 — Make.com-style stacked-card wizard for creating a
 * LEAD_ROUTING integration.
 *
 * Mounted at /integrations/new-v2 and /integrations/edit-v2/:id.
 * Old URLs `/integrations/new-routing` and `/integrations/edit-routing/:id`
 * redirect here (see App.tsx).
 *
 * The wizard persists two surfaces on each save:
 *   1. Top-level dedicated fields (preferred by the server for the matching
 *      columns): pageId, formId, pageName, formName, facebookAccountId,
 *      destinationId.
 *   2. integration.config JSON — fields that don't have dedicated columns:
 *      { fieldMappings, nameField, phoneField, targetWebsiteName,
 *        targetTemplateType, variableFields }
 *   The 6 dedicated keys are intentionally NOT echoed inside config, so the
 *   JSON stays free of duplicates and there is a single source of truth.
 *
 * 5b scope (this commit):
 *   - Trigger card: Facebook account / page / form
 *   - Destination card: pick an EXISTING destination (grouped by category)
 *   - Mapping card: auto-detected name/phone + extra fields (form | static)
 *   - Variables card: template-specific variables (sotuvchi, 100k, custom)
 *   - Name card: auto-generated, editable
 * 5c will bring multi-destination fan-out and inline destination creation.
 */

import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { ArrowLeft, ChevronRight, Facebook, Loader2, Plus, Zap } from "lucide-react";
import { DestinationCreatorInline } from "@/components/destinations/DestinationCreatorInline";
import { AppCatalogPicker } from "@/components/appCatalog/AppCatalogPicker";
import { ZapperStep } from "@/components/wizard/ZapperStep";
import { TriggerEditor } from "@/components/wizard/TriggerEditor";
import { DestinationEditor } from "@/components/wizard/DestinationEditor";
import { AppManifestMapper } from "@/components/wizard/AppManifestMapper";
import { useIntegrationWizardState } from "./lead-routing/useIntegrationWizardState";

// ─── Main component ──────────────────────────────────────────────────────────

export default function IntegrationWizardV2() {
  const {
    navigate,
    isEditMode,
    editIntegration,
    stateInitialized,
    activeStep,
    setActiveStep,
    triggerFilled,
    state,
    accounts,
    loadingAccounts,
    pages,
    loadingPages,
    forms,
    loadingForms,
    setAccount,
    setPage,
    setForm,
    step2Icon,
    step2IconColor,
    destinationFilled,
    primaryDestName,
    canSave,
    inlineCreatorAppKey,
    setInlineCreatorAppKey,
    addDestination,
    triggerVariableGroups,
    setActionPickerOpen,
    destinations,
    loadingTargets,
    removeDestination,
    handleOpenCreatorForApp,
    primaryManifest,
    primaryDest,
    formFields,
    loadingFields,
    connectionConfig,
    updateLeadField,
    updateStaticValue,
    updateCustomMapping,
    addCustomMappingFormRow,
    addCustomMappingStaticRow,
    removeCustomMapping,
    patch,
    isSaving,
    handleSave,
    actionPickerOpen,
    editId,
    markDestinationPrivate,
  } = useIntegrationWizardState();

  // Destinations Cleanup Sprint, PR 2/4 — only the universal HTTP module
  // (the make.com-style "HTTP Request") is private-by-default when invoked
  // from the wizard. Other apps (Telegram/Sheets/CRMs) keep their existing
  // shared semantics: their credentials live on the connection row and are
  // legitimately reusable across integrations.
  const isPrivateHttpFlow = inlineCreatorAppKey === "http-request";

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <DashboardLayout>
      {/* ── Sticky page header (Wapi pattern) ── */}
      <div className="sticky top-16 z-30 -mx-6 -mt-6 mb-6 bg-background/85 backdrop-blur-md border-b border-slate-200/70 dark:border-border">
        <div className="max-w-3xl mx-auto px-6 py-4">
          <button
            type="button"
            onClick={() => navigate("/integrations")}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-primary transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Integrations
            <ChevronRight className="h-3 w-3 opacity-50" />
            <span>{isEditMode ? "Edit integration" : "New integration"}</span>
          </button>
          <h1 className="text-2xl font-bold tracking-tight text-primary mt-1">
            {isEditMode ? (editIntegration?.name ?? "Edit integration") : "New integration"}
          </h1>
        </div>
      </div>

      <div className="max-w-3xl mx-auto pb-16">
        {/* Loading state in edit mode while data is being fetched */}
        {isEditMode && !stateInitialized && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading integration…
          </div>
        )}

        {/* ── Zapier-style vertical flow ── */}
        <div>
          {/* ─ Step 1: Trigger ─ */}
          <ZapperStep
            icon={Facebook}
            iconColor="text-blue-600"
            label="Trigger"
            appName="Facebook Lead Ads"
            isActive={activeStep === 1}
            isDone={triggerFilled}
            isOpen={activeStep === 1}
            isLast={false}
            summary={
              triggerFilled
                ? `${state.pageName} / ${state.formName}`
                : undefined
            }
            onHeaderClick={() => setActiveStep(1)}
          >
            <TriggerEditor
              accounts={accounts ?? []}
              loadingAccounts={loadingAccounts}
              pages={pages ?? []}
              loadingPages={loadingPages}
              forms={forms ?? []}
              loadingForms={loadingForms}
              state={state}
              onPickAccount={setAccount}
              onPickPage={setPage}
              onPickForm={setForm}
            />

            {/* Continue — field mapping lives in Step 2 per destination */}
            {triggerFilled && (
              <div className="flex justify-end pt-4 mt-2 border-t border-slate-200/70 dark:border-border">
                <Button
                  onClick={() => setActiveStep(2)}
                  className="wapi-button-hover rounded-full h-10 px-5 bg-primary hover:bg-primary/90 text-primary-foreground font-medium"
                >
                  Continue
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            )}
          </ZapperStep>

          {/* ─ Step 2: Action ─ */}
          <ZapperStep
            icon={step2Icon}
            iconColor={step2IconColor}
            label="Action"
            appName={
              destinationFilled
                ? state.destinations.length === 1
                  ? primaryDestName
                  : `${primaryDestName} +${state.destinations.length - 1} more`
                : "Choose destination"
            }
            isActive={activeStep === 2}
            isDone={canSave}
            isLocked={!triggerFilled}
            /* Only opens after Continue on the trigger (activeStep=2).
               Keeping it closed while the trigger is still active matches
               the Zapier/Make flow the user asked for: trigger → Continue
               → downward connector → "+ Add action" revealed. */
            isOpen={activeStep === 2}
            isLast={true}
            summary={canSave ? state.integrationName : undefined}
            onHeaderClick={() => triggerFilled && setActiveStep(2)}
          >
            {inlineCreatorAppKey !== undefined ? (
              /* ── Inline destination creator (Zapier-style, no drawer) ── */
              <DestinationCreatorInline
                initialAppKey={inlineCreatorAppKey ?? undefined}
                /* PR 2/4 — HTTP-Request is private-by-default when invoked
                   from the wizard (make.com-style). In edit mode the
                   integration id already exists and is sent inline so the
                   create call sets parentIntegrationId atomically. In
                   create mode we mark the new destination as pending-private
                   and the wizard's handleSave attaches it after Publish. */
                privateMode={isPrivateHttpFlow}
                parentIntegrationId={
                  isPrivateHttpFlow && editId ? editId : undefined
                }
                onCreated={({ id, name, templateType }) => {
                  addDestination(id, name, templateType);
                  if (isPrivateHttpFlow && !editId) {
                    markDestinationPrivate(id);
                  }
                  setInlineCreatorAppKey(undefined);
                }}
                onCancel={() => setInlineCreatorAppKey(undefined)}
                triggerVariables={triggerVariableGroups}
              />
            ) : !destinationFilled ? (
              /* ── Empty Action step: one big "+ Add action" CTA ──
                   Matches the Zapier/Make.com pattern the user approved:
                   after Continue on the trigger, step 2 just shows this
                   button — the full app picker lives inside the modal so
                   the wizard stays uncluttered. */
              <div className="flex flex-col items-center justify-center py-6">
                <button
                  type="button"
                  onClick={() => setActionPickerOpen(true)}
                  className={cn(
                    "flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-primary/30 bg-primary/5 px-10 py-8 transition-all",
                    "hover:border-primary/60 hover:bg-primary/10 active:scale-[0.99]",
                  )}
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Plus className="h-5 w-5" strokeWidth={2.5} />
                  </span>
                  <span className="text-sm font-semibold text-foreground">
                    Add action
                  </span>
                  <span className="max-w-[220px] text-center text-[11px] leading-snug text-muted-foreground">
                    Choose where each new Facebook lead should go
                  </span>
                </button>
              </div>
            ) : (
              /* ── Destination selected → chip view + mapping + publish ── */
              <>
                {/* Destination chip list (picker UI lives in the modal now) */}
                <div>
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                    Destination
                  </div>
                  <DestinationEditor
                    destinations={destinations ?? []}
                    loading={loadingTargets}
                    selectedIds={state.destinations.map((d) => d.id)}
                    onToggle={(id, name, templateType) => {
                      if (state.destinations.some((d) => d.id === id)) {
                        removeDestination(id);
                      } else {
                        addDestination(id, name, templateType);
                      }
                    }}
                    onOpenCreatorForApp={handleOpenCreatorForApp}
                    onAddAnother={() => setActionPickerOpen(true)}
                  />
                </div>

                {/* AppManifest-driven field mapping (Make.com / Zapier level) */}
                {destinationFilled && primaryManifest && (
                  <AppManifestMapper
                    manifest={primaryManifest}
                    destEntry={primaryDest!}
                    formFields={formFields ?? []}
                    loadingFields={loadingFields}
                    connectionConfig={connectionConfig}
                    onUpdateLeadField={(key, formField) =>
                      updateLeadField(primaryDest!.id, key, formField)
                    }
                    onUpdateStaticValue={(key, value) =>
                      updateStaticValue(primaryDest!.id, key, value)
                    }
                    onUpdateCustomMapping={(i, p) =>
                      updateCustomMapping(primaryDest!.id, i, p)
                    }
                    onAddCustomFormRow={() => addCustomMappingFormRow(primaryDest!.id)}
                    onAddCustomStaticRow={() => addCustomMappingStaticRow(primaryDest!.id)}
                    onRemoveCustomMapping={(i) => removeCustomMapping(primaryDest!.id, i)}
                  />
                )}

                {/* Integration name + Publish (shown once destination is picked) */}
                {destinationFilled && (
                  <div className="border-t mt-5 pt-5 space-y-4">
                    <div className="space-y-1.5">
                      <Label
                        htmlFor="integration-name"
                        className="text-xs font-semibold text-muted-foreground uppercase tracking-wide"
                      >
                        Integration name
                      </Label>
                      <Input
                        id="integration-name"
                        value={state.integrationName}
                        onChange={(e) =>
                          patch({
                            integrationName: e.target.value,
                            integrationNameTouched: true,
                          })
                        }
                        placeholder={
                          state.pageName && primaryDestName
                            ? `${state.pageName} → ${primaryDestName}`
                            : "My integration"
                        }
                      />
                      {state.integrationNameTouched && (
                        <button
                          type="button"
                          onClick={() =>
                            patch({
                              integrationName: "",
                              integrationNameTouched: false,
                            })
                          }
                          className="text-[11px] text-muted-foreground hover:text-primary"
                        >
                          Reset to auto-generated name
                        </button>
                      )}
                    </div>

                    {/* Publish / Save row */}
                    <div className="flex items-center justify-between pt-1 gap-3 flex-wrap">
                      <p className="text-xs text-muted-foreground">
                        {canSave
                          ? isEditMode
                            ? "Ready to save changes."
                            : "Ready to publish — activates immediately."
                          : "Fill in Name and Phone fields to continue."}
                      </p>
                      <div className="flex items-center gap-2 shrink-0">
                        <Button
                          variant="ghost"
                          onClick={() => navigate("/integrations")}
                          disabled={isSaving}
                          className="wapi-button-hover rounded-full h-10 px-4 font-medium"
                        >
                          Cancel
                        </Button>
                        <Button
                          onClick={handleSave}
                          disabled={!canSave || isSaving}
                          className="wapi-button-hover rounded-full h-10 px-5 bg-primary hover:bg-primary/90 text-primary-foreground font-medium"
                        >
                          {isSaving ? (
                            <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                          ) : (
                            <Zap className="h-4 w-4 mr-1.5" />
                          )}
                          {isEditMode ? "Save changes" : "Publish"}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </ZapperStep>
        </div>
      </div>

      {/* Zapier-style app picker modal. Mounted once at the page level so
          opening/closing it preserves all wizard state (trigger choices,
          mapping edits, etc.). */}
      <AppCatalogPicker
        open={actionPickerOpen}
        onOpenChange={setActionPickerOpen}
        mode="destination"
        onDestinationReady={(id, name, templateType) => {
          addDestination(id, name, templateType);
          setActiveStep(2);
        }}
        onPickManifestApp={(appKey) => {
          // Sheets / Telegram / Custom HTTP still need the multi-step inline
          // creator (OAuth popup, bot token form, webhook builder). Hand off
          // to the existing flow instead of duplicating those forms inside
          // the picker.
          setInlineCreatorAppKey(appKey);
          setActiveStep(2);
        }}
      />
    </DashboardLayout>
  );
}

