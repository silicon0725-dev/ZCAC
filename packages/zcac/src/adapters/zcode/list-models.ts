/**
 * ZCAC 工具:枚举 Provider Registry 中当前可用的 Provider / Model。
 * 用途:确认默认模型、为 worker 选择替代模型(ZCAC_MODEL / --model)。
 */

import { startProcessProviderRegistryRuntime } from "@zcode/bootstrap";

function flag(value: unknown): string | undefined {
  return typeof value === "boolean" ? (value ? "yes" : "no") : undefined;
}

async function main(): Promise<void> {
  const runtime = await startProcessProviderRegistryRuntime(process.env, { standalone: {} });
  try {
    console.log(
      "[models] default selection :",
      JSON.stringify(runtime.configuredDefaultModelSelection ?? null),
    );
    console.log(
      "[models] runtime headers   :",
      runtime.providerRuntimeHeadersPort ? "present (account auth active)" : "absent",
    );

    const providers = runtime.runtime.registryService.listProviders();
    for (const provider of providers) {
      const header = `provider: ${provider.providerId}${
        provider.providerName ? ` (${provider.providerName})` : ""
      }`;
      console.log(`\n${header}`);
      for (const model of provider.models) {
        const config = model.config as unknown as Record<string, unknown> | undefined;
        const parts = [
          `enabled=${flag(config?.enabled) ?? "?"}`,
          `executable=${flag(config?.executable) ?? "?"}`,
          `selectable=${flag(config?.selectable) ?? "?"}`,
        ].join(" ");
        const optionSpecs = (config?.optionSpecs ?? {}) as Record<string, unknown>;
        const reasoning = optionSpecs.reasoningLevel as Record<string, unknown> | undefined;
        const levels = Array.isArray(reasoning?.values) ? (reasoning?.values as unknown[]).join("|") : "?";
        console.log(`  - ${model.modelId}  [${parts}] reasoning: ${levels}`);
      }
    }

    const snapshot = runtime.runtime.registryService.getSnapshot();
    const issues = snapshot?.resolution.issues ?? [];
    if (issues.length > 0) {
      console.log(`\n[models] resolution issues (${issues.length}):`);
      for (const issue of issues.slice(0, 10)) {
        console.log(`  ! ${JSON.stringify(issue)}`);
      }
    }
  } finally {
    runtime.dispose();
  }
}

main().catch((error: unknown) => {
  console.error("[models] fatal:", error);
  process.exitCode = 1;
});
