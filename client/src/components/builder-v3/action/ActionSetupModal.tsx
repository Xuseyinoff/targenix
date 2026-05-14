/**
 * ActionSetupModal — 3-step Albato-style action wizard.
 *
 *   action-app    → Step1AppPicker     (full-bleed Apps + Tools picker)
 *   action-action → Step2ActionPicker  (manifest module dropdown)
 *   action-params → Step3Parameters    (combined connection + DynamicForm)
 *
 * Phase 1.2: Save on Step 3 logs the action draft and closes the modal.
 * Phase 1.3 will swap the log for the real createDestination +
 * createIntegration tRPC mutations.
 */
import * as React from "react";
import { useT } from "@/hooks/useT";
import {
  canContinue,
  nextActionStepOf,
  type BuilderV3Action,
  type BuilderV3State,
} from "@/state/builderV3State";
import { BuilderShellModal } from "../BuilderShellModal";
import { BuilderStepFooter } from "../BuilderStepFooter";
import { Step1AppPicker } from "./Step1AppPicker";
import { Step2ActionPicker } from "./Step2ActionPicker";
import { Step3Parameters } from "./Step3Parameters";

export interface ActionSetupModalProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  state: BuilderV3State;
  dispatch: React.Dispatch<BuilderV3Action>;
  /** Called when the user finishes Step 3. Phase 1.3 wires this to save. */
  onActionComplete: () => void;
}

export function ActionSetupModal({
  open,
  onOpenChange,
  state,
  dispatch,
  onActionComplete,
}: ActionSetupModalProps) {
  const t = useT();

  // Track action-params validation here so the footer can disable Save
  // until the manifest's required fields are filled.
  const [paramErrors, setParamErrors] = React.useState<Record<string, string>>(
    {},
  );
  const paramsValid = Object.keys(paramErrors).length === 0;

  // Reset error map when leaving the params step or switching modules — a
  // stale error from a previous module would otherwise block Save.
  React.useEffect(() => {
    if (state.step !== "action-params") {
      setParamErrors({});
    }
  }, [state.step, state.action.moduleKey]);

  const canGoBack = state.history.length > 0;
  const isLastActionStep = state.step === "action-params";
  const primaryLabel = isLastActionStep
    ? t("builderV3.save")
    : t("builderV3.continue");

  const handlePrimary = () => {
    if (!canContinue(state, { actionParamsValid: paramsValid })) return;
    if (isLastActionStep) {
      onActionComplete();
      return;
    }
    const next = nextActionStepOf(state.step);
    if (next) dispatch({ type: "GO_NEXT", next });
  };

  return (
    <BuilderShellModal
      open={open}
      onOpenChange={onOpenChange}
      title={t("builderV3.action.title")}
      helpUrl="https://help.albato.com/en/articles/9064890-action-setup"
      helpLabel={t("builderV3.help")}
      canGoBack={canGoBack}
      onBack={() => dispatch({ type: "GO_BACK" })}
      backLabel={t("builderV3.back")}
      // Step 1 (app picker) is full-bleed and auto-advances on click —
      // no Continue button needed. Steps 2-3 render the standard footer.
      footer={
        state.step === "action-app" ? null : (
          <BuilderStepFooter
            primaryLabel={primaryLabel}
            primaryDisabled={
              !canContinue(state, { actionParamsValid: paramsValid })
            }
            onPrimary={handlePrimary}
          />
        )
      }
    >
      {state.step === "action-app" && (
        <Step1AppPicker state={state} dispatch={dispatch} />
      )}
      {state.step === "action-action" && (
        <Step2ActionPicker state={state} dispatch={dispatch} />
      )}
      {state.step === "action-params" && (
        <Step3Parameters
          state={state}
          dispatch={dispatch}
          onErrorsChange={setParamErrors}
        />
      )}
    </BuilderShellModal>
  );
}
