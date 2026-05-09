import { defineHttpApiKeyApp, defineField } from "../sdk";

export const openAiApp = defineHttpApiKeyApp({
  key: "openai",
  name: "OpenAI",
  icon: "https://unpkg.com/simple-icons@14.15.0/icons/openai.svg",
  category: "other",
  description: "Run a GPT completion on each incoming lead — summarise, qualify, or route automatically.",
  endpoint: {
    url: "https://api.openai.com/v1/chat/completions",
    method: "POST",
    contentType: "application/json",
    authScheme: "bearer",
  },
  extraFields: [
    defineField({
      key: "model",
      type: "select",
      label: "Model",
      required: true,
      defaultValue: "gpt-4o-mini",
      options: [
        { value: "gpt-4o",       label: "GPT-4o" },
        { value: "gpt-4o-mini",  label: "GPT-4o mini (fast + cheap)" },
        { value: "gpt-4-turbo",  label: "GPT-4 Turbo" },
        { value: "gpt-3.5-turbo", label: "GPT-3.5 Turbo" },
      ],
    }),
    defineField({
      key: "system",
      type: "textarea",
      label: "System prompt",
      description: "Instructions for the model. Describe what to do with the lead data.",
      required: false,
      defaultValue: "You are a helpful assistant that processes sales leads.",
      validation: { maxLength: 2000 },
    }),
    defineField({
      key: "user",
      type: "textarea",
      label: "User message",
      description: "The prompt sent per lead. Use {{full_name}}, {{phone_number}}, {{email}}, etc.",
      required: true,
      defaultValue: "New lead received: {{full_name}}, phone {{phone_number}}, email {{email}}. Please summarize and classify.",
      showTransformPreview: true,
      validation: { maxLength: 4000 },
    }),
    defineField({
      key: "max_tokens",
      type: "number",
      label: "Max tokens",
      description: "Maximum tokens in the response. 0 = model default.",
      required: false,
      defaultValue: 256,
    }),
  ],
});
