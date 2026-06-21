import assert from "node:assert/strict";
import test from "node:test";

import { polishTranscript } from "../src/openai";


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
