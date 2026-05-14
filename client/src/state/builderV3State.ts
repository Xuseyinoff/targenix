/**
 * builderV3State — reducer + selectors for the Albato-style builder wizard.
 *
 * Why a reducer over plain useState patchwork?
 *   - 9 steps × multiple sub-fields × Back navigation = a flat useState
 *     soup grows hairy fast.
 *   - Reducers are inspectable: every action is a single dispatch with a
 *     known shape, which makes the navigation history (used by the modal's
 *     Back link) and cascade-clear rules trivial to reason about.
 *
 * State lives in IntegrationBuilderV3.tsx. Children receive `(state,
 * dispatch)` as props. No Context, no Provider — only one consumer tree.
 */

// ─── Step IDs ────────────────────────────────────────────────────────────────

export type StepId =
  | "trigger-app"
  | "trigger-event"
  | "trigger-connection"
  | "trigger-params"
  | "trigger-timing"
  | "action-app"
  | "action-action"
  | "action-connection"
  | "action-params"
  | "done";

export const TRIGGER_STEPS: StepId[] = [
  "trigger-app",
  "trigger-event",
  "trigger-connection",
  "trigger-params",
  "trigger-timing",
];

/**
 * Action flow steps. We skip `action-connection` because targenix manifests
 * declare the connection as the first field of the parameters form
 * (`connection-picker` field type) — DynamicForm renders it inline. Keeping
 * the step id in the union for forward compatibility lets us re-introduce a
 * dedicated connection step later without changing types.
 */
export const ACTION_STEPS: StepId[] = [
  "action-app",
  "action-action",
  "action-params",
];

// ─── Drafts ──────────────────────────────────────────────────────────────────

export interface TriggerDraft {
  /** Phase 1: always "facebook" once Step 1 is picked. */
  appKey: string | null;
  /** Phase 1: "new_lead". */
  eventId: string | null;
  /** Selected Facebook Lead Ads account row id (`facebook_accounts.id`). */
  facebookAccountId: number | null;
  /** Page selection — both pieces stored because the server stores both. */
  pageId: string;
  pageName: string;
  /** Form selection — empty string = "All page forms". */
  formId: string;
  formName: string;
  timing: "realtime" | "bulk";
}

/** Action draft — Commit 1.3 fills this in. Defined now so the reducer's
 *  shape is stable. */
export interface ActionDraft {
  appKey: string | null;
  moduleKey: string | null;
  connectionId: number | null;
  values: Record<string, unknown>;
}

// ─── State ───────────────────────────────────────────────────────────────────

export interface BuilderV3State {
  step: StepId;
  /** Push-on-go-next, pop-on-back. Empty stack ⇒ Back link hidden. */
  history: StepId[];
  trigger: TriggerDraft;
  action: ActionDraft;
  integrationName: string;
  /** Was integrationName typed by the user? If false, we keep auto-deriving
   *  it from picks. */
  integrationNameTouched: boolean;
}

export const INITIAL_TRIGGER: TriggerDraft = {
  appKey: null,
  eventId: null,
  facebookAccountId: null,
  pageId: "",
  pageName: "",
  formId: "",
  formName: "",
  timing: "realtime",
};

export const INITIAL_ACTION: ActionDraft = {
  appKey: null,
  moduleKey: null,
  connectionId: null,
  values: {},
};

export const INITIAL_STATE: BuilderV3State = {
  step: "trigger-app",
  history: [],
  trigger: INITIAL_TRIGGER,
  action: INITIAL_ACTION,
  integrationName: "",
  integrationNameTouched: false,
};

// ─── Actions ─────────────────────────────────────────────────────────────────

export type BuilderV3Action =
  | { type: "GO_NEXT"; next: StepId }
  | { type: "GO_BACK" }
  | { type: "JUMP_TO"; step: StepId }
  | { type: "PATCH_TRIGGER"; patch: Partial<TriggerDraft> }
  | { type: "PATCH_ACTION"; patch: Partial<ActionDraft> }
  | { type: "SET_NAME"; name: string }
  | { type: "RESET" };

// ─── Reducer ─────────────────────────────────────────────────────────────────

export function builderV3Reducer(
  state: BuilderV3State,
  action: BuilderV3Action,
): BuilderV3State {
  switch (action.type) {
    case "GO_NEXT":
      return {
        ...state,
        step: action.next,
        history: [...state.history, state.step],
      };

    case "GO_BACK": {
      if (state.history.length === 0) return state;
      const prev = state.history[state.history.length - 1];
      return {
        ...state,
        step: prev,
        history: state.history.slice(0, -1),
      };
    }

    case "JUMP_TO":
      return { ...state, step: action.step };

    case "PATCH_TRIGGER": {
      const next = { ...state.trigger, ...action.patch };
      // Cascade clears: keep deeper selections from carrying stale parents.
      if (action.patch.appKey !== undefined && action.patch.appKey !== state.trigger.appKey) {
        next.eventId = null;
        next.facebookAccountId = null;
        next.pageId = "";
        next.pageName = "";
        next.formId = "";
        next.formName = "";
      }
      if (action.patch.facebookAccountId !== undefined && action.patch.facebookAccountId !== state.trigger.facebookAccountId) {
        next.pageId = "";
        next.pageName = "";
        next.formId = "";
        next.formName = "";
      }
      if (action.patch.pageId !== undefined && action.patch.pageId !== state.trigger.pageId) {
        next.formId = "";
        next.formName = "";
      }
      return { ...state, trigger: next };
    }

    case "PATCH_ACTION": {
      const next = { ...state.action, ...action.patch };
      if (action.patch.appKey !== undefined && action.patch.appKey !== state.action.appKey) {
        next.moduleKey = null;
        next.connectionId = null;
        next.values = {};
      }
      if (action.patch.moduleKey !== undefined && action.patch.moduleKey !== state.action.moduleKey) {
        next.values = {};
      }
      return { ...state, action: next };
    }

    case "SET_NAME":
      return { ...state, integrationName: action.name, integrationNameTouched: true };

    case "RESET":
      return INITIAL_STATE;
  }
}

// ─── Selectors ───────────────────────────────────────────────────────────────

/**
 * Validates whether the current step's required pickers are filled.
 * The action-params step has its own validator (DynamicForm + validateFields)
 * — callers pass `actionParamsValid` so we don't duplicate manifest logic
 * here.
 */
export function canContinue(
  state: BuilderV3State,
  opts: { actionParamsValid?: boolean } = {},
): boolean {
  switch (state.step) {
    case "trigger-app":
      return state.trigger.appKey !== null;
    case "trigger-event":
      return state.trigger.eventId !== null;
    case "trigger-connection":
      return state.trigger.facebookAccountId !== null;
    case "trigger-params":
      // formId === "" is intentionally allowed — empty string means "All
      // page forms", which is the most common pick and the existing wizard
      // (V2) treats it the same way.
      return !!state.trigger.pageId;
    case "trigger-timing":
      return true;
    case "action-app":
      return state.action.appKey !== null;
    case "action-action":
      return state.action.moduleKey !== null;
    case "action-params":
      // Validation comes from DynamicForm via the parent — if the parent
      // doesn't pass a verdict, default to true so the user isn't stuck.
      return opts.actionParamsValid ?? true;
    default:
      return true;
  }
}

/** Resolve the next step in the linear forward flow for the trigger
 *  half (steps 1-5). */
export function nextStepOf(step: StepId): StepId | null {
  const idx = TRIGGER_STEPS.indexOf(step);
  if (idx === -1 || idx === TRIGGER_STEPS.length - 1) return null;
  return TRIGGER_STEPS[idx + 1];
}

/** Forward navigation inside the action modal. Skips `action-connection`. */
export function nextActionStepOf(step: StepId): StepId | null {
  const idx = ACTION_STEPS.indexOf(step);
  if (idx === -1 || idx === ACTION_STEPS.length - 1) return null;
  return ACTION_STEPS[idx + 1];
}
