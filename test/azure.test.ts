import assert from "node:assert/strict";
import test from "node:test";

import { polishTranscript, transcribeAudio } from "../src/azure";

const target = {
  endpoint: "https://test-resource.cognitiveservices.azure.com/",
  apiKey: "test-key",
  apiVersion: "2025-04-01-preview",
};

function makeTranscribeSpy(): {
  fetchSpy: typeof fetch;
  getBody: () => FormData;
  getUrl: () => string;
  getInit: () => RequestInit;
} {
  let capturedBody: FormData | undefined;
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const fetchSpy = async (url: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    capturedBody = init?.body as FormData;
    return {
      ok: true,
      async json() {
        return { text: "hello" };
      },
    } as unknown as Response;
  };
  return {
    fetchSpy: fetchSpy as typeof fetch,
    getBody: () => capturedBody!,
    getUrl: () => capturedUrl!,
    getInit: () => capturedInit!,
  };
}

test("transcribeAudio targets the Azure deployment URL with api-version", async () => {
  const { fetchSpy, getUrl } = makeTranscribeSpy();
  await transcribeAudio(Buffer.from("audio"), {
    ...target,
    deployment: "gpt-4o-transcribe",
    fetchImpl: fetchSpy,
  });
  assert.equal(
    getUrl(),
    "https://test-resource.cognitiveservices.azure.com/openai/deployments/gpt-4o-transcribe/audio/transcriptions?api-version=2025-04-01-preview",
  );
});

test("transcribeAudio authenticates with the api-key header and sends the file", async () => {
  const { fetchSpy, getBody, getInit } = makeTranscribeSpy();
  await transcribeAudio(Buffer.from("audio"), {
    ...target,
    deployment: "gpt-4o-transcribe",
    fetchImpl: fetchSpy,
  });
  const headers = getInit().headers as Record<string, string>;
  assert.equal(headers["api-key"], "test-key");
  assert.ok(getBody().get("file") !== null, "should send file part");
});

test("transcribeAudio sends no prompt when vocabularyPrompt is absent", async () => {
  const { fetchSpy, getBody } = makeTranscribeSpy();
  await transcribeAudio(Buffer.from("audio"), {
    ...target,
    deployment: "gpt-4o-transcribe",
    fetchImpl: fetchSpy,
  });
  assert.equal(getBody().get("prompt"), null);
});

test("transcribeAudio sends no prompt when vocabularyPrompt is null", async () => {
  const { fetchSpy, getBody } = makeTranscribeSpy();
  await transcribeAudio(Buffer.from("audio"), {
    ...target,
    deployment: "gpt-4o-transcribe",
    vocabularyPrompt: null,
    fetchImpl: fetchSpy,
  });
  assert.equal(getBody().get("prompt"), null);
});

test("transcribeAudio sends no prompt when vocabularyPrompt is blank", async () => {
  const { fetchSpy, getBody } = makeTranscribeSpy();
  await transcribeAudio(Buffer.from("audio"), {
    ...target,
    deployment: "gpt-4o-transcribe",
    vocabularyPrompt: "   ",
    fetchImpl: fetchSpy,
  });
  assert.equal(getBody().get("prompt"), null);
});

test("transcribeAudio sends prompt part when vocabularyPrompt is provided", async () => {
  const { fetchSpy, getBody } = makeTranscribeSpy();
  await transcribeAudio(Buffer.from("audio"), {
    ...target,
    deployment: "gpt-4o-transcribe",
    vocabularyPrompt: "Prefer these spellings: ProjectZephyr; ExampleCorp.",
    fetchImpl: fetchSpy,
  });
  assert.equal(
    getBody().get("prompt"),
    "Prefer these spellings: ProjectZephyr; ExampleCorp.",
  );
});

test("polishTranscript targets the Azure chat deployment and omits temperature", async () => {
  let capturedUrl: string | undefined;
  let capturedBody: Record<string, unknown> | undefined;

  await polishTranscript("hello world", {
    ...target,
    deployment: "gpt-5-mini",
    fetchImpl: async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init?.body as string);
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: "Hello, world." } }] };
        },
      } as unknown as Response;
    },
  });

  assert.equal(
    capturedUrl,
    "https://test-resource.cognitiveservices.azure.com/openai/deployments/gpt-5-mini/chat/completions?api-version=2025-04-01-preview",
  );
  assert.ok(capturedBody, "fetch was not called");
  assert.ok(
    !("temperature" in capturedBody!),
    "gpt-5 deployments reject non-default temperature; it must be omitted",
  );
});

test("polishTranscript system prompt never answers questions or responds to requests", async () => {
  let capturedBody: Record<string, unknown> | undefined;

  const fetchSpy = async (_url: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(init?.body as string);
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: "Can you do this?" } }] };
      },
    } as unknown as Response;
  };

  await polishTranscript("Can you do this?", {
    ...target,
    deployment: "gpt-5-mini",
    fetchImpl: fetchSpy,
  });

  assert.ok(capturedBody, "fetch was not called");
  const systemMessage = (
    capturedBody.messages as Array<{ role: string; content: string }>
  ).find((m) => m.role === "system");
  assert.ok(systemMessage, "no system message found");

  const content = systemMessage.content.toLowerCase();
  assert.ok(
    content.includes("never answer") || content.includes("do not answer"),
    `System prompt must forbid answering questions, got: ${systemMessage.content}`,
  );
  assert.ok(
    content.includes("question") || content.includes("request"),
    `System prompt must mention 'question' or 'request', got: ${systemMessage.content}`,
  );
});

test("polishTranscript includes vocabulary instruction in system prompt when provided", async () => {
  let capturedBody: Record<string, unknown> | undefined;

  await polishTranscript("hello world", {
    ...target,
    deployment: "gpt-5-mini",
    vocabularyInstruction: "Vocabulary correction context: preserve ExampleCorp.",
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: "Hello, world." } }] };
        },
      } as unknown as Response;
    },
  });

  const messages = capturedBody?.messages as Array<{ role: string; content: string }>;
  const systemMessage = messages.find((m) => m.role === "system");
  assert.ok(
    systemMessage?.content.includes("ExampleCorp"),
    "vocabulary instruction should appear in system prompt",
  );
});

test("polishTranscript omits vocabulary instruction when blank", async () => {
  let capturedBody: Record<string, unknown> | undefined;

  await polishTranscript("hello world", {
    ...target,
    deployment: "gpt-5-mini",
    vocabularyInstruction: "   ",
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: "Hello, world." } }] };
        },
      } as unknown as Response;
    },
  });

  const messages = capturedBody?.messages as Array<{ role: string; content: string }>;
  const systemMessage = messages.find((m) => m.role === "system");
  assert.ok(
    !systemMessage?.content.includes("Vocabulary correction context"),
    "blank vocabulary instruction should not appear in system prompt",
  );
});

test("polishTranscript passes the raw transcript as the user message", async () => {
  let capturedBody: Record<string, unknown> | undefined;

  await polishTranscript("hello world", {
    ...target,
    deployment: "gpt-5-mini",
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: "Hello, world." } }] };
        },
      } as unknown as Response;
    },
  });

  const messages = capturedBody?.messages as Array<{
    role: string;
    content: string;
  }>;
  const userMessage = messages.find((m) => m.role === "user");
  assert.equal(userMessage?.content, "hello world");
});
