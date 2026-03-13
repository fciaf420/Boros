import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface AgentSecretsInput {
  rpcUrl?: string;
  accountId?: string;
  rootAddress?: string;
  privateKey?: string;
}

export interface AgentSecretsResolved {
  rpcUrl?: string;
  accountId?: string;
  rootAddress?: string;
  privateKey?: string;
}

export interface AgentSecretsStatus {
  configured: boolean;
  source: "secure-store" | "environment" | "mixed" | "none";
  hasRpcUrl: boolean;
  hasAccountId: boolean;
  hasRootAddress: boolean;
  hasPrivateKey: boolean;
  rpcUrlPreview?: string;
  accountId?: string;
  rootAddressMasked?: string;
  updatedAt?: number;
  message: string;
  missing: string[];
}

interface StoredSecretsFile {
  version: 1;
  provider: "windows-dpapi" | "plain";
  updatedAt: number;
  fields: Record<string, string>;
}

const SECRET_FIELDS = ["rpcUrl", "accountId", "rootAddress", "privateKey"] as const;

function maskAddress(value?: string): string | undefined {
  if (!value) return undefined;
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function previewRpcUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return value.length > 24 ? `${value.slice(0, 24)}...` : value;
  }
}

function isMeaningful(value: string | undefined | null): value is string {
  return Boolean(value && value.trim().length > 0);
}

export class AgentSecretStore {
  private readonly secretFilePath: string;

  constructor(rootDir: string) {
    const dataDir = path.join(rootDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    this.secretFilePath = path.join(dataDir, "agent_secrets.json");
  }

  private readStoredFile(): StoredSecretsFile | null {
    if (!fs.existsSync(this.secretFilePath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(this.secretFilePath, "utf-8")) as StoredSecretsFile;
    } catch {
      return null;
    }
  }

  private writeStoredFile(next: StoredSecretsFile): void {
    fs.writeFileSync(this.secretFilePath, JSON.stringify(next, null, 2), "utf-8");
  }

  private encrypt(value: string): string {
    if (process.platform !== "win32") {
      return Buffer.from(value, "utf8").toString("base64");
    }
    return execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$sec = ConvertTo-SecureString $env:CODEX_AGENT_SECRET -AsPlainText -Force; ConvertFrom-SecureString $sec",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, CODEX_AGENT_SECRET: value },
      },
    ).trim();
  }

  private decrypt(value: string, provider: StoredSecretsFile["provider"]): string {
    if (provider !== "windows-dpapi" || process.platform !== "win32") {
      return Buffer.from(value, "base64").toString("utf8");
    }
    return execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$sec = ConvertTo-SecureString $env:CODEX_AGENT_SECRET_BLOB; $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, CODEX_AGENT_SECRET_BLOB: value },
      },
    ).replace(/\r?\n$/, "");
  }

  save(input: AgentSecretsInput): AgentSecretsStatus {
    const current = this.readStoredFile();
    const provider: StoredSecretsFile["provider"] = process.platform === "win32" ? "windows-dpapi" : "plain";
    const next: StoredSecretsFile = {
      version: 1,
      provider,
      updatedAt: Date.now(),
      fields: { ...(current?.fields ?? {}) },
    };

    for (const key of SECRET_FIELDS) {
      const value = input[key];
      if (value === undefined) continue;
      if (!isMeaningful(value)) {
        delete next.fields[key];
        continue;
      }
      next.fields[key] = this.encrypt(value.trim());
    }

    this.writeStoredFile(next);
    return this.getStatus();
  }

  clear(): AgentSecretsStatus {
    if (fs.existsSync(this.secretFilePath)) {
      fs.unlinkSync(this.secretFilePath);
    }
    return this.getStatus();
  }

  resolve(): AgentSecretsResolved {
    const stored = this.readStoredFile();
    const resolved: AgentSecretsResolved = {};

    if (stored) {
      for (const key of SECRET_FIELDS) {
        const encrypted = stored.fields[key];
        if (!encrypted) continue;
        resolved[key] = this.decrypt(encrypted, stored.provider);
      }
    }

    if (!resolved.rpcUrl && isMeaningful(process.env.BOROS_RPC_URL)) {
      resolved.rpcUrl = process.env.BOROS_RPC_URL!.trim();
    }
    if (!resolved.accountId && isMeaningful(process.env.BOROS_ACCOUNT_ID)) {
      resolved.accountId = process.env.BOROS_ACCOUNT_ID!.trim();
    }
    if (!resolved.rootAddress && isMeaningful(process.env.BOROS_ROOT_ADDRESS)) {
      resolved.rootAddress = process.env.BOROS_ROOT_ADDRESS!.trim();
    }
    if (!resolved.privateKey && isMeaningful(process.env.BOROS_PRIVATE_KEY)) {
      resolved.privateKey = process.env.BOROS_PRIVATE_KEY!.trim();
    }

    return resolved;
  }

  getStatus(): AgentSecretsStatus {
    const stored = this.readStoredFile();
    const resolved = this.resolve();
    const secureCount = stored ? SECRET_FIELDS.filter((key) => Boolean(stored.fields[key])).length : 0;
    const envCount = SECRET_FIELDS.filter((key) => {
      const envKey =
        key === "rpcUrl" ? "BOROS_RPC_URL"
          : key === "accountId" ? "BOROS_ACCOUNT_ID"
            : key === "rootAddress" ? "BOROS_ROOT_ADDRESS"
              : "BOROS_PRIVATE_KEY";
      return isMeaningful(process.env[envKey]);
    }).length;

    const missing = SECRET_FIELDS.filter((key) => !resolved[key]).map((key) => {
      switch (key) {
        case "rpcUrl": return "RPC URL";
        case "accountId": return "Account ID";
        case "rootAddress": return "Root Address";
        default: return "Private Key";
      }
    });

    const source: AgentSecretsStatus["source"] =
      secureCount > 0 && envCount > 0 ? "mixed"
        : secureCount > 0 ? "secure-store"
          : envCount > 0 ? "environment"
            : "none";

    return {
      configured: missing.length === 0,
      source,
      hasRpcUrl: Boolean(resolved.rpcUrl),
      hasAccountId: Boolean(resolved.accountId),
      hasRootAddress: Boolean(resolved.rootAddress),
      hasPrivateKey: Boolean(resolved.privateKey),
      rpcUrlPreview: previewRpcUrl(resolved.rpcUrl),
      accountId: resolved.accountId,
      rootAddressMasked: maskAddress(resolved.rootAddress),
      updatedAt: stored?.updatedAt,
      message:
        missing.length === 0
          ? source === "secure-store"
            ? "Secure Boros signing credentials are stored locally."
            : source === "mixed"
              ? "Using a mix of secure-store and environment Boros credentials."
              : "Using Boros credentials from environment variables."
          : `Missing Boros credentials: ${missing.join(", ")}`,
      missing,
    };
  }
}
