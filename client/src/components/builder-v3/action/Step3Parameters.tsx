/**
 * action/Step3Parameters — last step before save. Renders the selected
 * manifest module's full DynamicForm.
 *
 * Note we combine "connection picker" and "parameters" into a single
 * step instead of mirroring Albato's separate Connection step. Reason:
 * targenix manifests declare the connection as the first field of type
 * `connection-picker`, and DynamicForm renders the whole thing inline
 * (with auto-Connect new flows wired to TelegramConnectDialog, OAuth
 * popups, ApiKeyConnectDialog). Splitting it across two steps would
 * require fragmenting the manifest field list — extra complexity for
 * no UX gain since the connection picker is already a single dropdown.
 *
 * The footer "Save" button validates fields via validateFields() and,
 * on success, fires onActionComplete (provided by the parent modal).
 * That callback decides whether to persist (Phase 1.3) or just log.
 */
import * as React from "react";
import { trpc } from "@/lib/trpc";
import {
  DynamicForm,
  seedInitialValues,
  validateFields,
  type ConfigField,
} from "@/components/dynamic-form";
import {
  AppIcon,
  appBrandIconTileClass,
} from "@/components/destinations/appIcons";
import { Loader2 } from "lucide-react";
import type {
  BuilderV3Action,
  BuilderV3State,
} from "@/state/builderV3State";
import type { FieldValues } from "@/components/dynamic-form/validation";

export interface ActionStep3Props {
  state: BuilderV3State;
  dispatch: React.Dispatch<BuilderV3Action>;
  /** Render-prop hook: parent sees per-field errors so it can disable
   *  "Save" until validation passes. */
  onErrorsChange?: (errors: Record<string, string>) => void;
}

export function Step3Parameters({
  state,
  dispatch,
  onErrorsChange,
}: ActionStep3Props) {
  const appKey = state.action.appKey;
  const moduleKey = state.action.moduleKey;

  const { data: app, isLoading } = trpc.apps.get.useQuery(
    appKey ? { key: appKey } : (undefined as never),
    {
      enabled: !!appKey,
      staleTime: 5 * 60 * 1000,
    },
  );

  const moduleData = app?.modules?.find((m) => m.key === moduleKey);
  const fields = moduleData?.fields ?? [];

  // Seed once when the module changes — subsequent edits live in state.
  React.useEffect(() => {
    if (!moduleData) return;
    if (Object.keys(state.action.values).length > 0) return;
    dispatch({
      type: "PATCH_ACTION",
      patch: { values: seedInitialValues(fields, undefined) },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleData?.key]);

  const [errors, setErrors] = React.useState<Record<string, string>>({});

  // Bubble errors up so the parent's "Save" button can disable on invalid
  // state — keeps the validation logic colocated with the manifest.
  React.useEffect(() => {
    onErrorsChange?.(errors);
  }, [errors, onErrorsChange]);

  if (isLoading || !app || !moduleData) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading parameters…
      </div>
    );
  }

  const values = state.action.values as FieldValues;

  return (
    <div className="space-y-5">
      <header className="flex items-center gap-3">
        <span className={appBrandIconTileClass("h-10 w-10")}>
          <AppIcon name={app.icon} className="h-6 w-6" />
        </span>
        <div className="min-w-0">
          <h3 className="text-base font-semibold leading-tight">
            {app.name} — {moduleData.name}
          </h3>
          <p className="text-xs text-muted-foreground">
            {moduleData.description ?? "Configure how this action runs."}
          </p>
        </div>
      </header>

      <DynamicForm
        fields={fields}
        appKey={appKey ?? ""}
        values={values}
        onChange={(next) =>
          dispatch({ type: "PATCH_ACTION", patch: { values: next } })
        }
        errors={errors}
      />

      {/* Hidden trigger for parent: validate on demand. We expose the
          callback by stashing it on the state object's `validate` shim
          via a ref — but the simplest path is to validate inside the
          parent's Save handler since it owns state anyway. We surface
          a small validate helper here for the parent's convenience. */}
      <ValidationRunner
        fields={fields}
        values={values}
        onErrors={setErrors}
      />
    </div>
  );
}

// ─── Validation runner ───────────────────────────────────────────────────────
// Memo runs validateFields whenever values change so the parent's Save
// button can read the latest error map via the onErrorsChange callback
// without imperative ref plumbing.

function ValidationRunner({
  fields,
  values,
  onErrors,
}: {
  fields: ConfigField[];
  values: FieldValues;
  onErrors: (errs: Record<string, string>) => void;
}) {
  React.useEffect(() => {
    const result = validateFields(fields, values);
    onErrors(result.isValid ? {} : result.errors);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, fields]);
  return null;
}
