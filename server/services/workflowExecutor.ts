/**
 * workflowExecutor.ts — Sequential step-by-step workflow runner.
 *
 * Each step executes in order. If a step fails and continueOnError=false,
 * remaining steps are skipped and execution is marked failed.
 *
 * Snapshots are written per-step in workflow_step_executions.
 *
 * SSRF protection: http_request step blocks private/internal IP ranges.
 */

import { eq, asc } from "drizzle-orm";
import type { DbClient } from "../db";
import {
  workflows,
  workflowSteps,
  workflowExecutions,
  workflowStepExecutions,
  type WorkflowStep,
} from "../../drizzle/schema";
import {
  resolveConfig,
  makeContext,
  type TemplateContext,
} from "./templateEngine";
import { evaluateFilter, type FilterOperator } from "./filterEngine";

// ─── SSRF guard ───────────────────────────────────────────────────────────────

const BLOCKED_HOSTS = /^(localhost|127\.|0\.0\.0\.0|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|::1|fc00:|fd[0-9a-f]{2}:|.*\.railway\.internal$|.*\.local$)/i;

function isSafeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (BLOCKED_HOSTS.test(u.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

// ─── Step result shape ────────────────────────────────────────────────────────

interface StepOutput {
  [key: string]: unknown;
}

interface StepResult {
  success: boolean;
  output: StepOutput;
  error?: string;
  durationMs: number;
}

// ─── Step executors ───────────────────────────────────────────────────────────

async function runHttpRequest(config: Record<string, unknown>): Promise<StepResult> {
  const t0 = Date.now();
  const url = String(config.url ?? "");
  const method = String(config.method ?? "POST").toUpperCase();
  const timeout = Math.min(Number(config.timeout ?? 10_000), 30_000);

  if (!url) return { success: false, output: {}, error: "URL required", durationMs: 0 };
  if (!isSafeUrl(url)) return { success: false, output: {}, error: `Blocked URL: ${url}`, durationMs: 0 };

  const headers: Record<string, string> = {};
  if (config.headers && typeof config.headers === "object") {
    for (const [k, v] of Object.entries(config.headers as Record<string, unknown>)) {
      headers[k] = String(v);
    }
  }
  if (!headers["Content-Type"] && method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] = "application/json";
  }

  let body: string | undefined;
  if (config.body && method !== "GET" && method !== "HEAD") {
    body = typeof config.body === "string" ? config.body : JSON.stringify(config.body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const durationMs = Date.now() - t0;
    const raw = await res.text();
    let parsedBody: unknown = raw;
    try { parsedBody = JSON.parse(raw); } catch { /* keep raw string */ }

    const output: StepOutput = {
      status:  res.status,
      ok:      res.ok,
      body:    parsedBody,
    };

    return { success: res.ok, output, durationMs };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: {}, error: msg, durationMs: Date.now() - t0 };
  }
}

async function runTelegram(config: Record<string, unknown>): Promise<StepResult> {
  const t0 = Date.now();
  const chatId = String(config.chatId ?? "");
  const message = String(config.message ?? "");
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken) return { success: false, output: {}, error: "TELEGRAM_BOT_TOKEN not set", durationMs: 0 };
  if (!chatId)   return { success: false, output: {}, error: "chatId required", durationMs: 0 };
  if (!message)  return { success: false, output: {}, error: "message required", durationMs: 0 };

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
    });
    const data = await res.json() as { ok: boolean; result?: { message_id?: number } };
    return {
      success: data.ok,
      output:  { sent: data.ok, messageId: data.result?.message_id ?? null },
      durationMs: Date.now() - t0,
      ...(!data.ok ? { error: "Telegram API returned ok=false" } : {}),
    };
  } catch (err) {
    return { success: false, output: {}, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - t0 };
  }
}

function runSetVariable(config: Record<string, unknown>): StepResult {
  const key   = String(config.key   ?? "");
  const value = config.value ?? "";
  if (!key) return { success: false, output: {}, error: "key required", durationMs: 0 };
  return { success: true, output: { [key]: value }, durationMs: 0 };
}

function runCondition(config: Record<string, unknown>): StepResult {
  const field    = String(config.field    ?? "");
  const operator = String(config.operator ?? "eq") as FilterOperator;
  const value    = String(config.value    ?? "");

  const matched = evaluateFilter(
    { enabled: true, logic: "AND", conditions: [{ field: "_val", operator, value }] },
    { fullName: null, phone: null, email: null, pageId: "", formId: "", extraFields: { _val: field } },
  );

  return {
    success: true,
    output:  { matched, field, operator, value },
    durationMs: 0,
  };
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

async function executeStep(
  step: WorkflowStep,
  ctx: TemplateContext,
): Promise<StepResult> {
  const resolvedConfig = resolveConfig(step.config, ctx) as Record<string, unknown>;

  switch (step.type) {
    case "http_request":  return runHttpRequest(resolvedConfig);
    case "telegram":      return runTelegram(resolvedConfig);
    case "set_variable":  return runSetVariable(resolvedConfig);
    case "condition":     return runCondition(resolvedConfig);
    default:
      return { success: false, output: {}, error: `Unknown step type: ${step.type}`, durationMs: 0 };
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export interface ExecuteWorkflowOptions {
  db:          DbClient;
  workflowId:  number;
  userId:      number;
  triggerData: Record<string, unknown>;
}

export interface ExecuteWorkflowResult {
  executionId: number;
  status:      "success" | "failed";
  stepResults: Array<{ stepId: number; name: string; status: string; durationMs: number | null; error?: string }>;
  error?:      string;
}

export async function executeWorkflow({
  db,
  workflowId,
  userId,
  triggerData,
}: ExecuteWorkflowOptions): Promise<ExecuteWorkflowResult> {
  // Load workflow + verify ownership
  const [wf] = await db
    .select()
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .limit(1);

  if (!wf || wf.userId !== userId) {
    throw new Error("Workflow not found");
  }
  if (!wf.isActive) {
    throw new Error("Workflow is inactive");
  }

  // Load steps sorted by position
  const steps = await db
    .select()
    .from(workflowSteps)
    .where(eq(workflowSteps.workflowId, workflowId))
    .orderBy(asc(workflowSteps.position), asc(workflowSteps.id));

  // Create execution record
  const [execInsert] = await db
    .insert(workflowExecutions)
    .values({
      workflowId,
      userId,
      status:      "running",
      triggerData,
      contextJson: {},
      startedAt:   new Date(),
    })
    .$returningId();

  const executionId = execInsert.id;

  // Build shared context
  const ctx: TemplateContext = makeContext(triggerData);
  const stepResults: ExecuteWorkflowResult["stepResults"] = [];
  let executionFailed = false;
  let executionError: string | undefined;

  // Execute steps sequentially
  for (const step of steps) {
    if (executionFailed) {
      // Mark remaining steps as skipped
      await db.insert(workflowStepExecutions).values({
        executionId,
        stepId:     step.id,
        position:   step.position,
        status:     "skipped",
        executedAt: new Date(),
      });
      stepResults.push({ stepId: step.id, name: step.name, status: "skipped", durationMs: null });
      continue;
    }

    // Create running snapshot
    const [stepExecInsert] = await db
      .insert(workflowStepExecutions)
      .values({
        executionId,
        stepId:    step.id,
        position:  step.position,
        status:    "running",
        inputJson: resolveConfig(step.config, ctx) as Record<string, unknown>,
        executedAt: new Date(),
      })
      .$returningId();

    const stepExecId = stepExecInsert.id;

    let result: StepResult;
    try {
      result = await executeStep(step, ctx);
    } catch (err) {
      result = {
        success: false,
        output: {},
        error: err instanceof Error ? err.message : String(err),
        durationMs: 0,
      };
    }

    // Update step snapshot with result
    await db
      .update(workflowStepExecutions)
      .set({
        status:     result.success ? "success" : "failed",
        outputJson: result.output,
        error:      result.error ?? null,
        durationMs: result.durationMs,
      })
      .where(eq(workflowStepExecutions.id, stepExecId));

    // Accumulate context: index by position and by step name
    ctx.steps[step.position] = { output: result.output, status: result.success ? "success" : "failed" };
    ctx.steps[step.name]     = { output: result.output, status: result.success ? "success" : "failed" };

    // Propagate set_variable outputs into ctx.vars
    if (step.type === "set_variable") {
      Object.assign(ctx.vars, result.output);
    }

    // condition step: if onFail=stop and not matched → stop
    if (step.type === "condition" && !result.output.matched) {
      const cfg = step.config as Record<string, unknown>;
      if ((cfg.onFail ?? "stop") === "stop") {
        executionFailed = true;
        executionError = `Condition not matched at step "${step.name}"`;
      }
    }

    // Any failed step that doesn't have continueOnError → stop
    if (!result.success && !step.continueOnError) {
      executionFailed = true;
      executionError = result.error ?? `Step "${step.name}" failed`;
    }

    stepResults.push({
      stepId:    step.id,
      name:      step.name,
      status:    result.success ? "success" : "failed",
      durationMs: result.durationMs,
      error:     result.error,
    });
  }

  const finalStatus: "success" | "failed" = executionFailed ? "failed" : "success";

  // Update execution record
  await db
    .update(workflowExecutions)
    .set({
      status:      finalStatus,
      contextJson: ctx as unknown as Record<string, unknown>,
      completedAt: new Date(),
      error:       executionError ?? null,
    })
    .where(eq(workflowExecutions.id, executionId));

  console.log(`[WorkflowExecutor] wf=${workflowId} exec=${executionId} status=${finalStatus} steps=${steps.length}`);

  return { executionId, status: finalStatus, stepResults, error: executionError };
}
