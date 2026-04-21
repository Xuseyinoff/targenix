/**
 * DevFormPreview — standalone showcase of every dynamic-form field component.
 *
 * Purpose:
 *   - Visual regression / manual QA while iterating on fields in Commit 3a.
 *   - Reference for newcomers ("what does a field-mapping look like?").
 *   - Admin-only sanity-check against the real Google Sheets loader path
 *     (connection picker + async-select + field-mapping end-to-end).
 *
 * Scope:
 *   - Pure UI demo. No actual save logic.
 *   - Admin-gated so end-users don't stumble onto it via /dev/*.
 *   - No DynamicForm root yet (that ships in Commit 3b). We keep local state
 *     per section and wire the fields manually.
 */

import * as React from "react";
import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  TextField,
  PasswordField,
  TextareaField,
  NumberField,
  BooleanField,
  SelectField,
  MultiSelectField,
  AsyncSelectField,
  ConnectionPickerField,
  FieldMappingField,
  CodeField,
  HiddenField,
} from "@/components/dynamic-form/fields";
import type { ConfigField } from "@/components/dynamic-form/types";
import type { FieldMapping } from "@/components/dynamic-form/fields";

// ─── fake field defs — only the manifest shape is real, no adapter round-trip ─

const textField: ConfigField = {
  key: "chat_id",
  type: "text",
  label: "Chat ID",
  description: "The numeric id of the Telegram chat that will receive leads.",
  placeholder: "-1001234567890",
  required: true,
  validation: { maxLength: 64 },
};

const passwordField: ConfigField = {
  key: "api_key",
  type: "password",
  label: "API Key",
  description: "Stored encrypted — never visible after save.",
  required: true,
};

const textareaField: ConfigField = {
  key: "message_template",
  type: "textarea",
  label: "Message template",
  description: "Supports {{lead.full_name}}, {{lead.phone}} placeholders.",
  placeholder: "New lead: {{full_name}} ({{phone}})",
  validation: { maxLength: 4000 },
};

const numberField: ConfigField = {
  key: "retry_count",
  type: "number",
  label: "Retry count",
  description: "Max delivery attempts before marking failed.",
  validation: { min: 0, max: 10 },
};

const booleanField: ConfigField = {
  key: "silent",
  type: "boolean",
  label: "Silent delivery",
  description: "Send without a notification sound (Telegram only).",
};

const staticSelectField: ConfigField = {
  key: "parse_mode",
  type: "select",
  label: "Parse mode",
  description: "How Telegram formats the message body.",
  options: [
    { value: "HTML", label: "HTML" },
    { value: "Markdown", label: "Markdown" },
    { value: "MarkdownV2", label: "Markdown V2" },
  ],
};

const multiSelectField: ConfigField = {
  key: "notification_channels",
  type: "multi-select",
  label: "Notify channels",
  description: "Who gets pinged when a delivery fails.",
  options: [
    { value: "email", label: "Email" },
    { value: "telegram", label: "Telegram" },
    { value: "slack", label: "Slack" },
  ],
};

const asyncSelectField: ConfigField = {
  key: "spreadsheet",
  type: "async-select",
  label: "Spreadsheet",
  description: "Live-loaded via apps.loadOptions.",
  optionsSource: "listSpreadsheets",
  dependsOn: ["connectionId"],
};

const connectionField: ConfigField = {
  key: "connectionId",
  type: "connection-picker",
  label: "Google connection",
  description: "Pick a saved Google account.",
  required: true,
  connectionType: "google_sheets",
};

const mappingField: ConfigField = {
  key: "mapping",
  type: "field-mapping",
  label: "Column mapping",
  description: "Lead variable → destination column.",
  headersSource: "getSheetHeaders",
  dependsOn: ["connectionId", "spreadsheetId", "sheetName"],
};

const codeField: ConfigField = {
  key: "custom_payload",
  type: "code",
  label: "Custom payload",
  description: "Raw JSON sent to the webhook.",
  placeholder: "{\n  \"event\": \"lead.created\"\n}",
};

const hiddenField: ConfigField = {
  key: "adapter_version",
  type: "hidden",
  label: "(hidden)",
};

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function StateInspector({ state }: { state: unknown }) {
  return (
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer text-muted-foreground select-none">
        show value
      </summary>
      <pre className="mt-2 bg-muted rounded p-2 overflow-x-auto text-[11px] leading-snug">
        {JSON.stringify(state, null, 2)}
      </pre>
    </details>
  );
}

export default function DevFormPreview() {
  const { user, loading } = useAuth();

  // Local state for each demo field.
  const [textValue, setTextValue] = React.useState("");
  const [passwordValue, setPasswordValue] = React.useState("");
  const [textareaValue, setTextareaValue] = React.useState("");
  const [numberValue, setNumberValue] = React.useState<number | null>(null);
  const [boolValue, setBoolValue] = React.useState(false);
  const [selectValue, setSelectValue] = React.useState<string | null>(null);
  const [multiValue, setMultiValue] = React.useState<string[]>([]);
  const [codeValue, setCodeValue] = React.useState('{\n  "hello": "world"\n}');

  // Google Sheets live section (async-select + mapping depend on a real
  // connection). The full chain only activates once an admin clicks through.
  const [connectionId, setConnectionId] = React.useState<number | null>(null);
  const [spreadsheetId, setSpreadsheetId] = React.useState<string | null>(null);
  const [sheetName, setSheetName] = React.useState<string | null>(null);
  const [mappingValue, setMappingValue] = React.useState<FieldMapping>({});

  // Admin gate — this page touches live tRPC calls and exposes an internal
  // layer, so we keep it off the public surface.
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }
  if (!user || user.role !== "admin") {
    return (
      <DashboardLayout>
        <div className="max-w-2xl mx-auto py-12">
          <Card>
            <CardHeader>
              <CardTitle>Not available</CardTitle>
              <CardDescription>
                This dev preview is only accessible to admin accounts.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="max-w-3xl mx-auto py-8 space-y-6">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link to="/overview">
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Link>
          </Button>
          <div>
            <h1 className="text-xl font-semibold">Dynamic Form — field preview</h1>
            <p className="text-sm text-muted-foreground">
              Commit 3a / Phase 4. Each section renders ONE field component in
              isolation so we can verify styling, validation UX, and loader
              wiring before assembling the full DynamicForm.
            </p>
          </div>
        </div>

        <Separator />

        <Section title="TextField" description="Single-line string input.">
          <TextField field={textField} value={textValue} onChange={setTextValue} />
          <StateInspector state={textValue} />
        </Section>

        <Section
          title="TextField — with error"
          description="Same component, error prop forced for visual check."
        >
          <TextField
            field={textField}
            value={textValue}
            onChange={setTextValue}
            error="Chat ID is required."
          />
        </Section>

        <Section title="PasswordField" description="Masked input with reveal toggle.">
          <PasswordField field={passwordField} value={passwordValue} onChange={setPasswordValue} />
          <StateInspector state={{ length: passwordValue.length }} />
        </Section>

        <Section title="TextareaField" description="Multi-line, max-length enforced.">
          <TextareaField field={textareaField} value={textareaValue} onChange={setTextareaValue} />
          <StateInspector state={textareaValue} />
        </Section>

        <Section title="NumberField" description="Accepts empty (mapped to null).">
          <NumberField field={numberField} value={numberValue} onChange={setNumberValue} />
          <StateInspector state={numberValue} />
        </Section>

        <Section title="BooleanField" description="Inline switch, label on the right.">
          <BooleanField field={booleanField} value={boolValue} onChange={setBoolValue} />
          <StateInspector state={boolValue} />
        </Section>

        <Section title="SelectField" description="Static options from manifest.">
          <SelectField field={staticSelectField} value={selectValue} onChange={setSelectValue} />
          <StateInspector state={selectValue} />
        </Section>

        <Section title="MultiSelectField" description="Checkbox list, static options.">
          <MultiSelectField field={multiSelectField} value={multiValue} onChange={setMultiValue} />
          <StateInspector state={multiValue} />
        </Section>

        <Section title="CodeField" description="Raw JSON editor (monospace).">
          <CodeField field={codeField} value={codeValue} onChange={setCodeValue} />
          <StateInspector state={codeValue} />
        </Section>

        <Section
          title="HiddenField"
          description="Renders nothing; the input below is a <input type=hidden />."
        >
          <HiddenField field={hiddenField} value="v1" />
          <p className="text-xs text-muted-foreground mt-1">
            (Check DevTools → Elements to see the hidden node.)
          </p>
        </Section>

        <Separator />

        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Live Google Sheets chain</h2>
          <p className="text-sm text-muted-foreground">
            The three fields below hit the real{" "}
            <code className="text-xs">apps.loadOptions</code> endpoint. You need
            a Google connection on your account. Picking a spreadsheet enables
            the sheet dropdown, which in turn enables the mapping.
          </p>
        </div>

        <Section title="ConnectionPickerField" description="google_sheets">
          <ConnectionPickerField
            field={connectionField}
            value={connectionId}
            onChange={setConnectionId}
          />
          <StateInspector state={{ connectionId }} />
        </Section>

        <Section
          title="AsyncSelectField — spreadsheet"
          description="Loads via loadOptions once a connection is picked."
        >
          <AsyncSelectField
            field={asyncSelectField}
            appKey="google_sheets"
            connectionId={connectionId}
            value={spreadsheetId}
            onChange={(v) => {
              setSpreadsheetId(v);
              setSheetName(null);
              setMappingValue({});
            }}
          />
          <StateInspector state={{ spreadsheetId }} />
        </Section>

        <Section
          title="AsyncSelectField — sheet tab"
          description="Depends on spreadsheetId."
        >
          <AsyncSelectField
            field={{
              ...asyncSelectField,
              key: "sheetName",
              label: "Sheet tab",
              optionsSource: "listSheetTabs",
              dependsOn: ["connectionId", "spreadsheetId"],
            }}
            appKey="google_sheets"
            connectionId={connectionId}
            params={{ spreadsheetId }}
            value={sheetName}
            onChange={(v) => {
              setSheetName(v);
              setMappingValue({});
            }}
          />
          <StateInspector state={{ sheetName }} />
        </Section>

        <Section
          title="FieldMappingField — sheet columns"
          description="Depends on connectionId + spreadsheetId + sheetName."
        >
          <FieldMappingField
            field={mappingField}
            appKey="google_sheets"
            connectionId={connectionId}
            params={{ spreadsheetId, sheetName }}
            value={mappingValue}
            onChange={setMappingValue}
            availableVariables={[
              { key: "full_name", label: "Full name" },
              { key: "phone_number", label: "Phone number" },
              { key: "email", label: "Email" },
              { key: "created_time", label: "Created at" },
            ]}
          />
          <StateInspector state={mappingValue} />
        </Section>
      </div>
    </DashboardLayout>
  );
}
