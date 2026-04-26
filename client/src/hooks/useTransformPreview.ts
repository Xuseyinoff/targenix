/**
 * useTransformPreview — client-side real-time template evaluation.
 *
 * Runs entirely in the browser (no API call). The transform engine is a
 * pure TypeScript module with no Node.js dependencies, so it works as-is
 * in Vite/React.
 *
 * Usage:
 *   const { output, unknownVars, unknownFns, hasError } =
 *     useTransformPreview("{{upper(full_name)}}", sampleCtx);
 */

import { useMemo } from "react";
import { previewTemplate } from "@shared/transformEngine";
import type { EvalContext, PreviewResult } from "@shared/transformEngine";

export type { EvalContext, PreviewResult };

export interface TransformPreviewState extends PreviewResult {
  /** True when template references unknown variables or functions. */
  hasWarning: boolean;
  /** True when template is empty or has no {{ }} expressions. */
  isPlain: boolean;
}

export function useTransformPreview(
  template: string,
  ctx: EvalContext,
): TransformPreviewState {
  return useMemo(() => {
    if (!template || !template.includes("{{")) {
      return {
        output: template,
        unknownVars: [],
        unknownFns: [],
        hasWarning: false,
        isPlain: true,
      };
    }
    const result = previewTemplate(template, ctx);
    return {
      ...result,
      hasWarning: result.unknownVars.length > 0 || result.unknownFns.length > 0,
      isPlain: false,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, JSON.stringify(ctx)]);
}

/** Sample lead data used for real-time preview in the wizard. */
export const SAMPLE_LEAD_CONTEXT: EvalContext = {
  full_name:    "Alibek Yusupov",
  phone_number: "+998901234567",
  email:        "alibek@example.com",
  pageName:     "My Page",
  formName:     "Lead Form",
  campaignName: "Spring 2024",
  createdAt:    new Date().toISOString(),
  offer_id:     "12345",
  stream:       "main",
};
