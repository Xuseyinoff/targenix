/**
 * Step4Parameters — additional parameters for the chosen trigger event.
 *
 * For Facebook Lead Ads this is the Page + Form pair. Both dropdowns
 * support search and a manual "Update" refresh — the same UX Albato
 * uses for cascading dependent selects.
 *
 * Cascade behaviour (enforced by the reducer):
 *   - changing Page clears Form
 *   - changing facebookAccountId (Step 3) clears both
 */
import { trpc } from "@/lib/trpc";
import { DependentSelect } from "@/components/builder-v3/shared/DependentSelect";
import type {
  BuilderV3Action,
  BuilderV3State,
} from "@/state/builderV3State";

export interface Step4ParametersProps {
  state: BuilderV3State;
  dispatch: React.Dispatch<BuilderV3Action>;
}

export function Step4Parameters({
  state,
  dispatch,
}: Step4ParametersProps) {
  const accountId = state.trigger.facebookAccountId;

  // Pages depend on the selected FB account.
  const pagesQuery = trpc.facebookAccounts.listPages.useQuery(
    accountId ? { accountId } : (undefined as never),
    {
      enabled: accountId !== null,
      staleTime: 30_000,
    },
  );

  // Forms depend on the selected FB page. We skip the query until the
  // user picks a page — running it sooner just wastes round trips.
  const formsQuery = trpc.facebookAccounts.listForms.useQuery(
    accountId && state.trigger.pageId
      ? { accountId, pageId: state.trigger.pageId }
      : (undefined as never),
    {
      enabled: accountId !== null && !!state.trigger.pageId,
      staleTime: 30_000,
    },
  );

  return (
    <div className="space-y-5">
      <header>
        <h3 className="text-base font-semibold leading-tight">
          Additional parameters
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Pick the page and form Albato should listen to.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <DependentSelect
          label="Page"
          required
          value={state.trigger.pageId}
          onChange={(id, name) =>
            dispatch({
              type: "PATCH_TRIGGER",
              patch: { pageId: id, pageName: name },
            })
          }
          options={(pagesQuery.data ?? []).map((p) => ({
            id: p.id,
            name: p.name,
          }))}
          placeholder="Select"
          disabled={!accountId}
          loading={pagesQuery.isLoading}
          onRefresh={() => {
            void pagesQuery.refetch();
          }}
          refreshing={pagesQuery.isFetching}
        />

        <DependentSelect
          label="Form"
          required
          value={state.trigger.formId}
          onChange={(id, name) =>
            dispatch({
              type: "PATCH_TRIGGER",
              patch: { formId: id, formName: name },
            })
          }
          options={(formsQuery.data ?? []).map((f) => ({
            id: String(f.id),
            name: f.name,
          }))}
          placeholder="Select"
          // Special row — same convention the V2 wizard uses. Empty id
          // signals "fire on every form for this page".
          allOption={{ id: "", name: "All page forms" }}
          disabled={!state.trigger.pageId}
          loading={formsQuery.isLoading}
          onRefresh={() => {
            void formsQuery.refetch();
          }}
          refreshing={formsQuery.isFetching}
        />
      </div>
    </div>
  );
}
