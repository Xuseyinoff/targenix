/**
 * TriggerSetupModal — 5-step Albato-style trigger wizard.
 *
 * Mounts as a child of IntegrationBuilderV3 and consumes (state, dispatch)
 * from the page-level reducer. Owns the modal chrome and per-step routing:
 *
 *   trigger-app       → Step1AppPicker        (full-bleed 2-column picker)
 *   trigger-event     → Step2EventPicker      (event dropdown)
 *   trigger-connection→ Step3ConnectionPicker (FB account list)
 *   trigger-params    → Step4Parameters       (Page + Form dropdowns)
 *   trigger-timing    → Step5Timing           (realtime/bulk radio + Save)
 *
 * The first step is full-bleed (the AppToolsPicker negates the modal's
 * padding so the sidebar can sit flush left). Step 2-5 use the shell's
 * default padded body.
 */
import { useT } from "@/hooks/useT";
import {
  canContinue,
  nextStepOf,
  type BuilderV3Action,
  type BuilderV3State,
} from "@/state/builderV3State";
import { BuilderShellModal } from "../BuilderShellModal";
import { BuilderStepFooter } from "../BuilderStepFooter";
import { Step1AppPicker } from "./Step1AppPicker";
import { Step2EventPicker } from "./Step2EventPicker";
import { Step3ConnectionPicker } from "./Step3ConnectionPicker";
import { Step4Parameters } from "./Step4Parameters";
import { Step5Timing } from "./Step5Timing";

export interface TriggerSetupModalProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  state: BuilderV3State;
  dispatch: React.Dispatch<BuilderV3Action>;
  /** Called when the user finishes Step 5. Parent advances to the action
   *  modal (or fires the save mutation in Phase 1.3). */
  onTriggerComplete: () => void;
}

export function TriggerSetupModal({
  open,
  onOpenChange,
  state,
  dispatch,
  onTriggerComplete,
}: TriggerSetupModalProps) {
  const t = useT();

  const canGoBack = state.history.length > 0;
  // Last trigger step renders "Save" instead of "Continue" — matches
  // Albato's label change when the step ends a section.
  const isLastTriggerStep = state.step === "trigger-timing";
  const primaryLabel = isLastTriggerStep
    ? t("builderV3.save")
    : t("builderV3.continue");

  const handlePrimary = () => {
    if (!canContinue(state)) return;
    if (isLastTriggerStep) {
      onTriggerComplete();
      return;
    }
    const next = nextStepOf(state.step);
    if (next) dispatch({ type: "GO_NEXT", next });
  };

  // Step 1 owns the entire modal body and provides its own padding/sidebar,
  // so we render the picker without the shell's normal padding wrapper.
  // The shell already centers via flexbox; passing the picker via children
  // is fine — AppToolsPicker uses negative margins to bleed to the edges.

  return (
    <BuilderShellModal
      open={open}
      onOpenChange={onOpenChange}
      title={
        state.step === "trigger-app"
          ? t("builderV3.trigger.title")
          : t("builderV3.trigger.title")
      }
      helpUrl="https://help.albato.com/en/articles/9064832-trigger-setup"
      helpLabel={t("builderV3.help")}
      canGoBack={canGoBack}
      onBack={() => dispatch({ type: "GO_BACK" })}
      backLabel={t("builderV3.back")}
      // Step 1's picker is full-bleed; the footer would only get in the
      // way (no Continue needed — clicking an app advances automatically).
      // Steps 2-5 show a Continue/Save button.
      footer={
        state.step === "trigger-app" ? null : (
          <BuilderStepFooter
            primaryLabel={primaryLabel}
            primaryDisabled={!canContinue(state)}
            onPrimary={handlePrimary}
          />
        )
      }
    >
      {state.step === "trigger-app" && (
        <Step1AppPicker state={state} dispatch={dispatch} />
      )}
      {state.step === "trigger-event" && (
        <Step2EventPicker state={state} dispatch={dispatch} />
      )}
      {state.step === "trigger-connection" && (
        <Step3ConnectionPicker state={state} dispatch={dispatch} />
      )}
      {state.step === "trigger-params" && (
        <Step4Parameters state={state} dispatch={dispatch} />
      )}
      {state.step === "trigger-timing" && (
        <Step5Timing state={state} dispatch={dispatch} />
      )}
    </BuilderShellModal>
  );
}
