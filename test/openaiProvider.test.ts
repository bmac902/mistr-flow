import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createOpenAiProvider } from "../src/openaiProvider";

async function writeConfig(fields: Record<string, unknown>): Promise<NodeJS.ProcessEnv> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mistr-flow-"));
  const configDir = path.join(tempRoot, "MistrFlow");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify(fields),
    "utf8",
  );
  return { APPDATA: tempRoot };
}

test("createOpenAiProvider reads its own openaiApiKey and transcribes through it", async () => {
  const env = await writeConfig({ openaiApiKey: "sk-openai-test" });
  let sentAuth: string | undefined;
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    sentAuth = (init?.headers as Record<string, string>)?.Authorization;
    return {
      ok: true,
      async json() {
        return { text: "hello there" };
      },
    } as unknown as Response;
  }) as typeof fetch;

  const provider = await createOpenAiProvider({ env, fileSystem: fs, fetchImpl });
  const text = await provider.transcribe(Buffer.from("audio"), { vocabularyPrompt: null });

  assert.equal(text, "hello there");
  assert.equal(sentAuth, "Bearer sk-openai-test");
});

test("createOpenAiProvider forwards the vocabulary instruction to polish", async () => {
  const env = await writeConfig({ openaiApiKey: "sk-openai-test" });
  let capturedBody: Record<string, unknown> | undefined;
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(init?.body as string);
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: "Hello, world." } }] };
      },
    } as unknown as Response;
  }) as typeof fetch;

  const provider = await createOpenAiProvider({ env, fileSystem: fs, fetchImpl });
  const polished = await provider.polish("hello world", {
    vocabularyInstruction: "Vocabulary correction context: preserve ExampleCorp.",
  });

  assert.equal(polished, "Hello, world.");
  const messages = capturedBody?.messages as Array<{ role: string; content: string }>;
  const systemMessage = messages.find((m) => m.role === "system");
  assert.ok(systemMessage?.content.includes("ExampleCorp"));
});
