import { spawn } from "node:child_process";

const STDERR_LIMIT = 64 * 1024;
const STOP_GRACE_MS = 1000;

export class RpcChild {
  constructor({ command, args = [], cwd, env = {} }) {
    if (typeof command !== "string" || command.length === 0) throw new Error("RPC command is required.");
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("RPC args must be strings.");
    this.command = command;
    this.args = [...args];
    this.cwd = cwd;
    this.env = { ...env };
    this.child = null;
    this.requestId = 0;
    this.pending = new Map();
    this.eventListeners = new Set();
    this.exitListeners = new Set();
    this.stderr = "";
    this.stdoutBuffer = "";
    this.exitError = null;
  }

  async start() {
    if (this.child) throw new Error("RPC child already started.");
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#consumeStdout(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-STDERR_LIMIT);
    });
    child.stdin.on("error", (error) => this.#recordExit(new Error(`RPC child stdin error: ${error.message}`)));
    child.once("error", (error) => this.#recordExit(new Error(`RPC child process error: ${error.message}`)));
    child.once("exit", (code, signal) => {
      this.#recordExit(new Error(`RPC child exited (code=${code} signal=${signal}).${this.stderr ? ` Stderr: ${this.stderr}` : ""}`));
    });

    await new Promise((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  onEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onExit(listener) {
    this.exitListeners.add(listener);
    if (this.exitError) queueMicrotask(() => listener(this.exitError));
    return () => this.exitListeners.delete(listener);
  }

  getStderr() {
    return this.stderr;
  }

  isAlive() {
    return Boolean(this.child && this.child.exitCode === null && !this.exitError);
  }

  prompt(message) { return this.#data("prompt", { message }); }
  steer(message) { return this.#data("steer", { message }); }
  abort() { return this.#data("abort"); }
  getState() { return this.#data("get_state"); }
  getSessionStats() { return this.#data("get_session_stats"); }
  async getLastAssistantText() {
    const data = await this.#data("get_last_assistant_text");
    return data?.text ?? null;
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, STOP_GRACE_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      setTimeout(resolve, STOP_GRACE_MS + 250).unref?.();
    });
    this.child = null;
  }

  async #data(type, fields = {}) {
    const response = await this.#send({ type, ...fields });
    if (!response.success) throw new Error(response.error || `RPC command ${type} failed.`);
    return response.data;
  }

  #send(command) {
    const child = this.child;
    const stdin = child?.stdin;
    if (!child || !stdin) return Promise.reject(new Error("RPC child is not started."));
    if (this.exitError) return Promise.reject(this.exitError);
    if (child.exitCode !== null || stdin.destroyed || !stdin.writable) {
      return Promise.reject(this.exitError ?? new Error("RPC child stdin is not writable."));
    }
    const id = `req_${++this.requestId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      stdin.write(`${JSON.stringify({ ...command, id })}\n`, "utf8", (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.reject(error);
      });
    });
  }

  #consumeStdout(chunk) {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      if (value?.type === "response" && typeof value.id === "string") {
        const pending = this.pending.get(value.id);
        if (pending) {
          this.pending.delete(value.id);
          pending.resolve(value);
        }
        continue;
      }
      for (const listener of [...this.eventListeners]) listener(value);
    }
  }

  #recordExit(error) {
    if (this.exitError) return;
    this.exitError = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const listener of [...this.exitListeners]) listener(error);
  }
}
