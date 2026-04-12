/** UI helpers for two-axis lead pipeline (data + delivery). */

export type LeadPipelineFields = {
  dataStatus: string;
  deliveryStatus: string;
};

export function leadIsRetryable(lead: LeadPipelineFields): boolean {
  return (
    lead.dataStatus === "ERROR" ||
    lead.deliveryStatus === "FAILED" ||
    lead.deliveryStatus === "PARTIAL"
  );
}

/** Single badge for list views — prioritise Graph failure, then delivery outcome. */
export function leadPipelineListBadge(lead: LeadPipelineFields): { key: string; label: string; className: string } {
  if (lead.dataStatus === "ERROR") {
    return {
      key: "GRAPH_ERROR",
      label: "Graph error",
      className:
        "bg-red-100 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400",
    };
  }
  switch (lead.deliveryStatus) {
    case "SUCCESS":
      return {
        key: "DELIVERED",
        label: "Delivered",
        className:
          "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-400",
      };
    case "PARTIAL":
      return {
        key: "PARTIAL",
        label: "Partial",
        className:
          "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-300",
      };
    case "FAILED":
      return {
        key: "FAILED",
        label: "Failed",
        className: "bg-red-100 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400",
      };
    case "PROCESSING":
      return {
        key: "PROCESSING",
        label: "Sending",
        className:
          "bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-950 dark:text-sky-300",
      };
    default:
      if (lead.dataStatus === "PENDING") {
        return {
          key: "QUEUED",
          label: "Queued",
          className:
            "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400",
        };
      }
      return {
        key: "PENDING",
        label: "Pending",
        className:
          "bg-muted text-muted-foreground border-border",
      };
  }
}
