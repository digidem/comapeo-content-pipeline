import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface ExecError {
  status?: number;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

const hasBun = (() => {
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
})();

const cliPath = fileURLToPath(new URL("./index.ts", import.meta.url));

describe.skipIf(!hasBun)("CLI boot and smoke tests", () => {
  it("boots cleanly with no arguments and prints usage without TDZ ReferenceError", () => {
    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    try {
      execFileSync("bun", [cliPath], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10_000,
      });
    } catch (err) {
      const execErr = err as ExecError;
      exitCode = execErr.status ?? 1;
      stdout = execErr.stdout?.toString() || "";
      stderr = execErr.stderr?.toString() || "";
    }

    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("Usage: pnpm pipeline <command> [options]");
    expect(stderr).not.toContain("ReferenceError");
    expect(stderr).not.toContain("Cannot access 'VALUE_FLAGS' before initialization");
  });

  it("boots cleanly with an unknown flag and prints usage without crashing", () => {
    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    try {
      execFileSync("bun", [cliPath, "--unknown-flag"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10_000,
      });
    } catch (err) {
      const execErr = err as ExecError;
      exitCode = execErr.status ?? 1;
      stdout = execErr.stdout?.toString() || "";
      stderr = execErr.stderr?.toString() || "";
    }

    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("Unknown command: --unknown-flag");
    expect(stderr).not.toContain("ReferenceError");
  });
});

describe.skipIf(!hasBun)("manifest:generate destination directory handling", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "manifest-gen-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates destination directory and writes manifest.json when --out points to a non-existent directory", () => {
    // Populate tempDir with a mock metadata file
    const mockPageId = "mock-page-1";
    const mockMetadata = {
      page_id: mockPageId,
      id: mockPageId,
      title: "Test Page",
      slug: "test-page",
      locale: "en",
      section: "getting-started",
      order: 1,
      element_type: "Page",
      drafting_status: "Draft published",
      last_edited_time: new Date().toISOString(),
      content_hash: "hash123",
      raw_hash: "raw123",
      source_page_id: mockPageId,
      r2_path: `docs/en/docs/getting-started/test-page.md`,
      notion_url: "https://notion.so/test",
    };

    writeFileSync(
      join(tempDir, `${mockPageId}.metadata.json`),
      JSON.stringify(mockMetadata, null, 2),
    );

    // Target a new subdirectory that does not exist yet
    const targetDir = join(tempDir, "nested", "newdir");
    expect(existsSync(targetDir)).toBe(false);

    execFileSync("bun", [
      cliPath,
      "manifest:generate",
      "--input",
      tempDir,
      "--out",
      targetDir,
    ], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    });

    const expectedManifest = join(targetDir, "manifest.json");
    expect(existsSync(expectedManifest)).toBe(true);

    const content = JSON.parse(readFileSync(expectedManifest, "utf-8"));
    expect(Array.isArray(content.docs)).toBe(true);
    expect(content.docs.length).toBe(1);
    expect(content.docs[0].page_id).toBe(mockPageId);
  });

  it("creates parent directory when --out points to a non-existent file path ending in .json", () => {
    const mockPageId = "mock-page-2";
    const mockMetadata = {
      page_id: mockPageId,
      id: mockPageId,
      title: "Test Page 2",
      slug: "test-page-2",
      locale: "en",
      section: "getting-started",
      order: 1,
      element_type: "Page",
      drafting_status: "Draft published",
      last_edited_time: new Date().toISOString(),
      content_hash: "hash456",
      raw_hash: "raw456",
      source_page_id: mockPageId,
      r2_path: `docs/en/docs/getting-started/test-page-2.md`,
      notion_url: "https://notion.so/test-2",
    };

    writeFileSync(
      join(tempDir, `${mockPageId}.metadata.json`),
      JSON.stringify(mockMetadata, null, 2),
    );

    const customManifestFile = join(tempDir, "custom", "sub", "output.json");
    expect(existsSync(join(tempDir, "custom"))).toBe(false);

    execFileSync("bun", [
      cliPath,
      "manifest:generate",
      "--input",
      tempDir,
      "--out",
      customManifestFile,
    ], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    });

    expect(existsSync(customManifestFile)).toBe(true);
    const content = JSON.parse(readFileSync(customManifestFile, "utf-8"));
    expect(content.docs.length).toBe(1);
    expect(content.docs[0].page_id).toBe(mockPageId);
  });

  it("creates destination directory when --out has a trailing slash", () => {
    const mockPageId = "mock-page-trailing";
    const mockMetadata = {
      page_id: mockPageId,
      id: mockPageId,
      title: "Test Page Trailing",
      slug: "test-page-trailing",
      locale: "en",
      section: "getting-started",
      order: 1,
      element_type: "Page",
      drafting_status: "Draft published",
      last_edited_time: new Date().toISOString(),
      content_hash: "hash789",
      raw_hash: "raw789",
      source_page_id: mockPageId,
      r2_path: `docs/en/docs/getting-started/test-page-trailing.md`,
      notion_url: "https://notion.so/test-trailing",
    };

    writeFileSync(
      join(tempDir, `${mockPageId}.metadata.json`),
      JSON.stringify(mockMetadata, null, 2),
    );

    const trailingDir = join(tempDir, "trailing-dir") + "/";

    execFileSync("bun", [
      cliPath,
      "manifest:generate",
      "--input",
      tempDir,
      "--out",
      trailingDir,
    ], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    });

    const expectedManifest = join(tempDir, "trailing-dir", "manifest.json");
    expect(existsSync(expectedManifest)).toBe(true);
  });

  it("fails with 'Input directory not found' when input directory does not exist and does not create an empty directory", () => {
    const nonExistentInput = join(tempDir, "does-not-exist");
    const nonExistentOut = join(tempDir, "should-not-be-created");
    let stderr = "";
    let exitCode = 0;

    try {
      execFileSync("bun", [
        cliPath,
        "manifest:generate",
        "--input",
        nonExistentInput,
        "--out",
        nonExistentOut,
      ], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10_000,
      });
    } catch (err) {
      const execErr = err as ExecError;
      exitCode = execErr.status ?? 1;
      stderr = execErr.stderr?.toString() || "";
    }

    expect(exitCode).toBe(1);
    expect(stderr).toContain(`Error: Input directory not found: ${nonExistentInput}`);
    expect(existsSync(nonExistentInput)).toBe(false);
    expect(existsSync(nonExistentOut)).toBe(false);
  });

  it("fails with 'Input directory not found' when input is a file rather than a directory", () => {
    const filePath = join(tempDir, "file-not-dir.txt");
    writeFileSync(filePath, "hello world");
    const nonExistentOut = join(tempDir, "should-not-exist");

    let stderr = "";
    let exitCode = 0;

    try {
      execFileSync("bun", [
        cliPath,
        "manifest:generate",
        "--input",
        filePath,
        "--out",
        nonExistentOut,
      ], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10_000,
      });
    } catch (err) {
      const execErr = err as ExecError;
      exitCode = execErr.status ?? 1;
      stderr = execErr.stderr?.toString() || "";
    }

    expect(exitCode).toBe(1);
    expect(stderr).toContain(`Error: Input path is not a directory: ${filePath}`);
    expect(existsSync(nonExistentOut)).toBe(false);
  });

  it("fails with 'No .metadata.json files found' when input directory is empty and does not create output directory", () => {
    const emptyInputDir = mkdtempSync(join(tempDir, "empty-"));
    const nonExistentOut = join(tempDir, "never-created-dir");

    let stderr = "";
    let exitCode = 0;

    try {
      execFileSync("bun", [
        cliPath,
        "manifest:generate",
        "--input",
        emptyInputDir,
        "--out",
        nonExistentOut,
      ], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10_000,
      });
    } catch (err) {
      const execErr = err as ExecError;
      exitCode = execErr.status ?? 1;
      stderr = execErr.stderr?.toString() || "";
    }

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Error: No .metadata.json files found");
    expect(existsSync(nonExistentOut)).toBe(false);
  });

  it("fails with error when --out points to an existing non-JSON file and does not clobber it", () => {
    const mockPageId = "mock-page-collision";
    const mockMetadata = {
      page_id: mockPageId,
      id: mockPageId,
      title: "Test Collision",
      slug: "test-collision",
      locale: "en",
      section: "getting-started",
      order: 1,
      element_type: "Page",
      drafting_status: "Draft published",
      last_edited_time: new Date().toISOString(),
      content_hash: "hash999",
      raw_hash: "raw999",
      source_page_id: mockPageId,
      r2_path: `docs/en/docs/getting-started/test-collision.md`,
      notion_url: "https://notion.so/test-collision",
    };

    writeFileSync(
      join(tempDir, `${mockPageId}.metadata.json`),
      JSON.stringify(mockMetadata, null, 2),
    );

    const existingTxtFile = join(tempDir, "existing-file.txt");
    writeFileSync(existingTxtFile, "do not touch this file");

    let stderr = "";
    let exitCode = 0;

    try {
      execFileSync("bun", [
        cliPath,
        "manifest:generate",
        "--input",
        tempDir,
        "--out",
        existingTxtFile,
      ], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10_000,
      });
    } catch (err) {
      const execErr = err as ExecError;
      exitCode = execErr.status ?? 1;
      stderr = execErr.stderr?.toString() || "";
    }

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Output path exists and is not a JSON file or directory");
    expect(readFileSync(existingTxtFile, "utf-8")).toBe("do not touch this file");
  });
});
