import {
  openWorkbenchInBrowser,
  startWorkbenchServer,
} from "@reasoning-workbench/workbench";

import {
  nonNegativeInteger,
  option,
  outputJson,
  positional,
  type CliIo,
  type ParsedArguments,
} from "../helpers.js";

export async function handleWorkbenchCommand(
  parsed: ParsedArguments,
  io: CliIo,
): Promise<number | null> {
  if (parsed.positionals[0] !== "workbench") return null;

  const projectRoot = positional(parsed, 1, "project directory");
  const portOption = option(parsed, "port");
  const server = await startWorkbenchServer({
    projectRoot,
    ...(portOption === undefined
      ? {}
      : { port: nonNegativeInteger(portOption, "--port") }),
  });
  outputJson(io, {
    projectRoot: server.projectRoot,
    host: server.host,
    port: server.port,
    url: server.url,
    security: "loopback-only; per-launch bearer token in URL fragment",
  });
  if (!parsed.options.has("no-open")) openWorkbenchInBrowser(server.url);

  const stop = () => {
    void server.close().catch(() => undefined);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await server.closed;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  return 0;
}
