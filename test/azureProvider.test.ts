import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAzureProvider } from "../src/azureProvider";

async function writeConfig(fields: Record<string, unknown>): Promise<NodeJS.ProcessEnv> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mistr-flow-"));
  const configDir = path.join(tempRoot, "MistrFlow");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify(fields),
    "utf8",
  );
  // Strip the ambient AZURE_* env vars so the file is the only source under test.
  return {
    APPDATA: tempRoot,
    AZURE_OPENAI_ENDPOINT: undefined,
    AZURE_OPENAI_API_KEY: undefined,
    AZURE_OPENAI_API_VERSION: undefined,
  };
}

test("createAzureProvider reads its own azure fields and transcribes through the api-key header", async () => {
  const env = await writeConfig({
    azureEndpoint: "https://test-resource.cognitiveservices.azure.com/",
    azureApiKey: "azure-test-key",
    transcribeDeployment: "gpt-4o-transcribe",
  });
  let sentUrl: string | undefined;
  let sentApiKey: string | undefined;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sentUrl = String(url);
    sentApiKey = (init?.headers as Record<string, string>)?.["api-key"];
    return {
      ok: true,
      async json() {
        return { text: "hello there" };
      },
    } as unknown as Response;
  }) as typeof fetch;

  const provider = await createAzureProvider({ env, fileSystem: fs, fetchImpl });
  const text = await provider.transcribe(Buffer.from("audio"), { vocabularyPrompt: null });

  assert.equal(text, "hello there");
  assert.equal(sentApiKey, "azure-test-key");
  assert.equal(
    sentUrl,
    "https://test-resource.cognitiveservices.azure.com/openai/deployments/gpt-4o-transcribe/audio/transcriptions?api-version=2025-04-01-preview",
  );
});

test("createAzureProvider polishes through the configured polish deployment and forwards vocabulary", async () => {
  const env = await writeConfig({
    azureEndpoint: "https://test-resource.cognitiveservices.azure.com/",
    azureApiKey: "azure-test-key",
    polishDeployment: "gpt-5-mini",
  });
  let sentUrl: string | undefined;
  let capturedBody: Record<string, unknown> | undefined;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sentUrl = String(url);
    capturedBody = JSON.parse(init?.body as string);
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: "Hello, world." } }] };
      },
    } as unknown as Response;
  }) as typeof fetch;

  const provider = await createAzureProvider({ env, fileSystem: fs, fetchImpl });
  const polished = await provider.polish("hello world", {
    vocabularyInstruction: "Vocabulary correction context: preserve ExampleCorp.",
  });

  assert.equal(polished, "Hello, world.");
  assert.equal(
    sentUrl,
    "https://test-resource.cognitiveservices.azure.com/openai/deployments/gpt-5-mini/chat/completions?api-version=2025-04-01-preview",
  );
  const messages = capturedBody?.messages as Array<{ role: string; content: string }>;
  const systemMessage = messages.find((m) => m.role === "system");
  assert.ok(systemMessage?.content.includes("ExampleCorp"));
});

test("createAzureProvider fails loudly when azureEndpoint is missing", async () => {
  const env = await writeConfig({ azureApiKey: "azure-test-key" });
  await assert.rejects(
    createAzureProvider({ env, fileSystem: fs }),
    /azureEndpoint/,
  );
});

test("createAzureProvider fails loudly when azureApiKey is missing", async () => {
  const env = await writeConfig({
    azureEndpoint: "https://test-resource.cognitiveservices.azure.com/",
  });
  await assert.rejects(
    createAzureProvider({ env, fileSystem: fs }),
    /azureApiKey/,
  );
});
