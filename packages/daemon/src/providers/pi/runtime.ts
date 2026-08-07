// Pi JSONL-RPC 运行时：启动参数构造 + 会话封装（裁剪自 Paseo providers/pi/runtime.ts + cli-runtime.ts）

import { JsonlRpcProcess } from "../../jsonl-rpc-process.js";
import type {
  PiAgentMessage,
  PiModel,
  PiPromptAck,
  PiRpcSlashCommand,
  PiRuntimeEvent,
  PiSessionState,
  PiThinkingLevel,
} from "./rpc-types.js";

export type { PiRuntimeEvent } from "./rpc-types.js";

export interface PiStartSessionInput {
  cwd: string;
  env?: Record<string, string>;
  model?: string;
  thinkingLevel?: string;
  session?: string;
  noSession?: boolean;
  mcpConfigPath?: string;
  extensionPaths?: string[];
  extraArgs?: string[];
}

export interface PiRuntimeSession {
  onEvent(callback: (event: PiRuntimeEvent) => void): () => void;
  prompt(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<PiPromptAck>;
  abort(): Promise<void>;
  getState(): Promise<PiSessionState>;
  getMessages(): Promise<PiAgentMessage[]>;
  getAvailableModels(timeoutMs?: number | null): Promise<PiModel[]>;
  setModel(provider: string, modelId: string): Promise<PiModel>;
  setThinkingLevel(level: PiThinkingLevel): Promise<void>;
  getCommands(): Promise<PiRpcSlashCommand[]>;
  request(
    command: { type: string; [key: string]: unknown },
    timeoutMs?: number | null,
  ): Promise<unknown>;
  respondToExtensionUiRequest(
    id: string,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ): void;
  close(): Promise<void>;
}

export class PiJsonlRpcRuntime {
  constructor(
    private readonly options: {
      command?: [string, ...string[]];
    } = {},
  ) {}

  startSession(input: PiStartSessionInput): PiRuntimeSession {
    const command = this.options.command ?? [process.env.PI_COMMAND ?? "pi"];
    const argv = [...command];
    if (!argv.some((a) => a === "--mode" || a.startsWith("--mode="))) {
      argv.push("--mode", "rpc");
    }
    if (input.extraArgs?.length) {
      argv.push(...input.extraArgs);
    }
    if (input.model) {
      argv.push("--model", input.model);
    }
    if (input.thinkingLevel) {
      argv.push("--thinking", input.thinkingLevel);
    }
    if (input.noSession) {
      argv.push("--no-session");
    } else if (input.session) {
      argv.push("--session", input.session);
    }
    if (input.mcpConfigPath) {
      argv.push("--mcp-config", input.mcpConfigPath);
    }
    for (const extensionPath of input.extensionPaths ?? []) {
      argv.push("--extension", extensionPath);
    }

    const [cmd, ...args] = argv as [string, ...string[]];
    const rpcProcess = new JsonlRpcProcess({
      launch: { command: cmd, args, cwd: input.cwd, env: input.env },
      diagnosticName: "Pi RPC",
    });
    return new PiRuntimeSessionImpl(rpcProcess);
  }
}

class PiRuntimeSessionImpl implements PiRuntimeSession {
  private readonly subscribers = new Set<(event: PiRuntimeEvent) => void>();

  constructor(private readonly process: JsonlRpcProcess) {
    process.onMessage((message) => {
      this.emit(message as PiRuntimeEvent);
    });
    process.onExit(({ error }) => {
      this.emit({ type: "process_exit", error: error.message });
    });
  }

  onEvent(callback: (event: PiRuntimeEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async prompt(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<PiPromptAck> {
    const { id: requestId, promise } = this.process.startRequest({
      type: "prompt",
      message,
      ...(images?.length ? { images } : {}),
    });
    const data = await promise;
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      const { agentInvoked } = data as Record<string, unknown>;
      if (typeof agentInvoked === "boolean") {
        return { requestId, agentInvoked };
      }
    }
    return { requestId };
  }

  async abort(): Promise<void> {
    await this.request({ type: "abort" });
  }

  async getState(): Promise<PiSessionState> {
    return (await this.request({ type: "get_state" })) as PiSessionState;
  }

  async getMessages(): Promise<PiAgentMessage[]> {
    const data = (await this.request({ type: "get_messages" })) as { messages?: PiAgentMessage[] };
    return data.messages ?? [];
  }

  async getAvailableModels(timeoutMs?: number | null): Promise<PiModel[]> {
    const data = (await this.request({ type: "get_available_models" }, timeoutMs)) as {
      models?: PiModel[];
    };
    return data.models ?? [];
  }

  async setModel(provider: string, modelId: string): Promise<PiModel> {
    return (await this.request({ type: "set_model", provider, modelId })) as PiModel;
  }

  async setThinkingLevel(level: PiThinkingLevel): Promise<void> {
    await this.request({ type: "set_thinking_level", level });
  }

  async getCommands(): Promise<PiRpcSlashCommand[]> {
    const data = (await this.request({ type: "get_commands" })) as {
      commands?: PiRpcSlashCommand[];
    };
    return data.commands ?? [];
  }

  request(
    command: { type: string; [key: string]: unknown },
    timeoutMs?: number | null,
  ): Promise<unknown> {
    return this.process.request(command, timeoutMs);
  }

  respondToExtensionUiRequest(
    id: string,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ): void {
    this.process.send({ type: "extension_ui_response", id, ...response });
  }

  async close(): Promise<void> {
    await this.process.close(new Error("Pi RPC session is closed"));
  }

  private emit(event: PiRuntimeEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}
