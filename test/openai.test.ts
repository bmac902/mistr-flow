import assert from "node:assert/strict";
import test from "node:test";

import { polishTranscript, transcribeAudio } from "../src/openai";


function makeTranscribeSpy(): { fetchSpy: typeof fetch; getBody: () => FormData } {
  let capturedBody: FormData | undefined;
  const fetchSpy = async (_url: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = init?.body as FormData;
    return {
      ok: true,
      async json() {
        return { text: "hello" };
      },
    } as unknown as Response;
  };
  return { fetchSpy: fetchSpy as typeof fetch, getBody: () => capturedBody! };
}

test("transcribeAudio sends model and file parts", async () => {
  const { fetchSpy, getBody } = makeTranscribeSpy();
  await transcribeAudio(Buffer.from("audio"), { apiKey: "test-key", fetchImpl: fetchSpy });
  assert.equal(getBody().get("model"), "whisper-1");
  assert.ok(getBody().get("file") !== null, "should send file part");
});

test("transcribeAudio sends no prompt when vocabularyPrompt is absent", async () => {
  const { fetchSpy, getBody } = makeTranscribeSpy();
  await transcribeAudio(Buffer.from("audio"), { apiKey: "test-key", fetchImpl: fetchSpy });
  assert.equal(getBody().get("prompt"), null);
});

test("transcribeAudio sends no prompt when vocabularyPrompt is null", async () => {
  const { fetchSpy, getBody } = makeTranscribeSpy();
  await transcribeAudio(Buffer.from("audio"), {
    apiKey: "test-key",
    vocabularyPrompt: null,
    fetchImpl: fetchSpy,
  });
  assert.equal(getBody().get("prompt"), null);
});

test("transcribeAudio sends no prompt when vocabularyPrompt is blank", async () => {
  const { fetchSpy, getBody } = makeTranscribeSpy();
  await transcribeAudio(Buffer.from("audio"), {
    apiKey: "test-key",
    vocabularyPrompt: "   ",
    fetchImpl: fetchSpy,
  });
  assert.equal(getBody().get("prompt"), null);
});

test("transcribeAudio sends prompt part when vocabularyPrompt is provided", async () => {
  const { fetchSpy, getBody } = makeTranscribeSpy();
  await transcribeAudio(Buffer.from("audio"), {
    apiKey: "test-key",
    vocabularyPrompt: "Prefer these spellings: ProjectZephyr; ExampleCorp.",
    fetchImpl: fetchSpy,
  });
  assert.equal(
    getBody().get("prompt"),
    "Prefer these spellings: ProjectZephyr; ExampleCorp.",
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
    apiKey: "test-key",
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
    apiKey: "test-key",
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
    apiKey: "test-key",
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
    apiKey: "test-key",
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
