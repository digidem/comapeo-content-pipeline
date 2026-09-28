#!/usr/bin/env bun
/**
 * Autonomous Merge Gate Verification Script
 *
 * Enforces the triple-gate criteria defined in AGENTS.md before any PR merge:
 *   Gate 1: Deterministic CI & Quality Gates (lint, typecheck, test, and GitHub Actions checks)
 *   Gate 2: Greptile Review Cycle Verification (review completed, 0 unresolved threads)
 *   Gate 3: Frontier Model Review Consensus (DeepSeek-Reasoner R1 + Codestral APPROVE with Low risk)
 *
 * Usage:
 *   bun scripts/verify-pr-gate.ts [PR_NUMBER]
 *   npm run gate:verify [PR_NUMBER]
 */

import { execSync, spawnSync } from "node:child_process";

interface CheckRun {
  name: string;
  state: string;
  link: string;
}

interface ReviewThread {
  id: string;
  isResolved: boolean;
  comments: {
    nodes: Array<{
      author: { login: string };
      body: string;
    }>;
  };
}

interface PRGraphQLData {
  data?: {
    repository?: {
      pullRequest?: {
        reviews?: {
          nodes?: Array<{
            author: { login: string };
            state: string;
            body: string;
          }>;
        };
        reviewThreads?: {
          totalCount: number;
          nodes: ReviewThread[];
        };
      };
    };
  };
}

interface FrontierReviewResult {
  model: string;
  verdict: "APPROVE" | "REQUEST_CHANGES" | "HOLD";
  risk: "Very Low" | "Low" | "Medium" | "High";
  confidence: number;
  raw: string;
}

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (err: unknown) {
    const error = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const out = error.stdout?.toString() || "";
    const errOut = error.stderr?.toString() || "";
    throw new Error(`Command failed: ${cmd}\n${out}\n${errOut}\n${error.message || ""}`, {
      cause: err,
    });
  }
}

async function queryModel(
  modelName: string,
  url: string,
  apiKey: string,
  prompt: string,
): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      ...(modelName.includes("reasoner") ? {} : { temperature: 0.1 }),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${modelName} error (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
        reasoning_content?: string;
      };
    }>;
  };
  const reasoning = data.choices?.[0]?.message?.reasoning_content || "";
  const content = data.choices?.[0]?.message?.content || "";
  return reasoning ? `${reasoning}\n\n${content}` : content;
}

function parseFrontierReview(model: string, reviewText: string): FrontierReviewResult {
  const verdictMatch = reviewText.match(/Verdict:\s*(APPROVE|REQUEST_CHANGES|HOLD)/i) ||
    reviewText.match(/\b(APPROVE|REQUEST_CHANGES|HOLD)\b/i);
  const verdict = (verdictMatch ? verdictMatch[1].toUpperCase() : "HOLD") as FrontierReviewResult["verdict"];

  const riskMatch = reviewText.match(/Risk Level:\s*(Very Low|Low|Medium|High)/i) ||
    reviewText.match(/\b(Very Low|Low|Medium|High)\s+Risk\b/i);
  const risk = (riskMatch ? riskMatch[1] : "Medium") as FrontierReviewResult["risk"];

  const confMatch = reviewText.match(/Confidence(?:\s+Score)?:\s*([1-5])(?:\/5)?/i);
  const confidence = confMatch ? parseInt(confMatch[1], 10) : 3;

  return {
    model,
    verdict,
    risk,
    confidence,
    raw: reviewText,
  };
}

async function main() {
  const prArg = process.argv[2];
  let prNumber = prArg;

  if (!prNumber) {
    try {
      const prInfo = JSON.parse(run("gh pr view --json number")) as { number: number };
      prNumber = String(prInfo.number);
    } catch {
      console.error("❌ Error: No PR number provided and unable to detect PR for current branch.");
      console.error("Usage: bun scripts/verify-pr-gate.ts <PR_NUMBER>");
      process.exit(1);
    }
  }

  console.log(`\n=======================================================`);
  console.log(`     AUTONOMOUS MERGE GATE VERIFICATION (PR #${prNumber})`);
  console.log(`=======================================================\n`);

  let allGatesPassed = true;
  const failureReasons: string[] = [];

  // =========================================================
  // GATE 1: Deterministic CI & Local Quality Checks
  // =========================================================
  console.log(`[Gate 1/3] Checking deterministic quality checks & CI...`);

  // Local lint
  process.stdout.write("  • Running local lint (eslint)... ");
  const lintRes = spawnSync("npm", ["run", "lint"], { stdio: "pipe" });
  if (lintRes.status !== 0) {
    console.log("❌ FAILED");
    failureReasons.push(`Local lint failed:\n${lintRes.stderr.toString() || lintRes.stdout.toString()}`);
    allGatesPassed = false;
  } else {
    console.log("✓ PASSED");
  }

  // Local typecheck
  process.stdout.write("  • Running local typecheck (tsc)... ");
  const tscRes = spawnSync("npm", ["run", "typecheck"], { stdio: "pipe" });
  if (tscRes.status !== 0) {
    console.log("❌ FAILED");
    failureReasons.push(`Local typecheck failed:\n${tscRes.stderr.toString() || tscRes.stdout.toString()}`);
    allGatesPassed = false;
  } else {
    console.log("✓ PASSED");
  }

  // Local vitest
  process.stdout.write("  • Running local test suite (vitest)... ");
  const testRes = spawnSync("npm", ["test"], { stdio: "pipe" });
  if (testRes.status !== 0) {
    console.log("❌ FAILED");
    failureReasons.push(`Local tests failed:\n${testRes.stderr.toString() || testRes.stdout.toString()}`);
    allGatesPassed = false;
  } else {
    console.log("✓ PASSED");
  }

  // Remote GitHub Actions checks
  process.stdout.write(`  • Checking GitHub Actions check runs for PR #${prNumber}... `);
  try {
    const checksJson = run(`gh pr checks ${prNumber} --json name,state,link`);
    const checks: CheckRun[] = JSON.parse(checksJson);

    const pending = checks.filter((c) => c.state === "PENDING");
    const failed = checks.filter((c) => c.state !== "SUCCESS" && c.state !== "PENDING");

    if (pending.length > 0) {
      console.log(`⏳ PENDING (${pending.map((c) => c.name).join(", ")})`);
      failureReasons.push(`CI checks still pending: ${pending.map((c) => c.name).join(", ")}`);
      allGatesPassed = false;
    } else if (failed.length > 0) {
      console.log(`❌ FAILED (${failed.map((c) => `${c.name}: ${c.state}`).join(", ")})`);
      failureReasons.push(`CI checks failed: ${failed.map((c) => `${c.name}: ${c.state}`).join(", ")}`);
      allGatesPassed = false;
    } else {
      console.log(`✓ PASSED (${checks.length} checks green)`);
    }
  } catch (err: unknown) {
    console.log("❌ ERROR fetching checks");
    failureReasons.push(`Unable to query GitHub checks: ${(err as Error).message}`);
    allGatesPassed = false;
  }

  // =========================================================
  // GATE 2: Greptile Review Cycle Verification
  // =========================================================
  console.log(`\n[Gate 2/3] Checking Greptile review cycle...`);
  try {
    const gqlQuery = `
      query {
        repository(owner: "digidem", name: "comapeo-content-pipeline") {
          pullRequest(number: ${prNumber}) {
            reviews(first: 20) {
              nodes {
                author { login }
                state
                body
              }
            }
            reviewThreads(first: 50) {
              totalCount
              nodes {
                id
                isResolved
                comments(first: 2) {
                  nodes {
                    author { login }
                    body
                  }
                }
              }
            }
          }
        }
      }
    `;

    const gqlOutput = run(`gh api graphql -f query='${gqlQuery}'`);
    const parsedData = JSON.parse(gqlOutput) as PRGraphQLData;
    const prData = parsedData.data?.repository?.pullRequest;

    const greptileReviews = (prData?.reviews?.nodes || []).filter(
      (r) => r.author.login === "greptile-apps",
    );
    const threads = prData?.reviewThreads?.nodes || [];
    const openThreads = threads.filter((t) => !t.isResolved);

    process.stdout.write("  • Greptile review completion... ");
    if (greptileReviews.length === 0) {
      console.log("⏳ WAITING (Greptile has not posted a review yet)");
      failureReasons.push("Greptile has not completed a review pass on this PR.");
      allGatesPassed = false;
    } else {
      console.log(`✓ COMPLETED (${greptileReviews.length} review(s))`);
    }

    process.stdout.write("  • Unresolved review threads... ");
    if (openThreads.length > 0) {
      console.log(`❌ ${openThreads.length} UNRESOLVED THREAD(S)`);
      for (const t of openThreads) {
        const comment = t.comments.nodes[0];
        const preview = comment?.body.slice(0, 100).replace(/\n/g, " ") || "";
        console.log(`    - [${t.id}] ${comment?.author.login}: ${preview}...`);
      }
      failureReasons.push(
        `There are ${openThreads.length} unresolved review threads. All threads must be formally addressed and resolved before merge.`,
      );
      allGatesPassed = false;
    } else {
      console.log(`✓ 0 open threads (all resolved)`);
    }
  } catch (err: unknown) {
    console.log("❌ ERROR querying GitHub GraphQL API");
    failureReasons.push(`Greptile check failed: ${(err as Error).message}`);
    allGatesPassed = false;
  }

  // =========================================================
  // GATE 3: Frontier Model Review Consensus
  // =========================================================
  console.log(`\n[Gate 3/3] Checking frontier model review consensus...`);

  let prDiff: string;
  try {
    prDiff = run(`gh pr diff ${prNumber}`);
  } catch {
    try {
      prDiff = run("git diff main...HEAD");
    } catch {
      prDiff = "";
    }
  }

  let prContext = "";
  try {
    const prMeta = JSON.parse(run(`gh pr view ${prNumber} --json title,body`)) as { title: string; body: string };
    prContext = `### PR Title: ${prMeta.title}\n### PR Description:\n${prMeta.body}\n\n`;
  } catch {
    // context optional
  }

  if (!prDiff) {
    console.log("  ❌ Error: PR diff is empty or cannot be fetched.");
    failureReasons.push("PR diff is empty.");
    allGatesPassed = false;
  } else {
    const reviewPrompt = `Please evaluate the following git diff for PR #${prNumber} in 'digidem/comapeo-content-pipeline'.
You are acting as a Principal Systems and Security Architect.
Provide a rigorous, critical code review evaluating safety, potential regressions, path handling edge cases, and merge readiness.

${prContext}### Git Diff:
\`\`\`diff
${prDiff.slice(0, 30000)}
\`\`\`

You MUST explicitly include the following formatted header in your review:
Risk Level: [Very Low / Low / Medium / High]
Confidence: [1-5]/5
Verdict: [APPROVE / REQUEST_CHANGES / HOLD]

Explain your reasoning clearly.`;

    const frontierResults: FrontierReviewResult[] = [];

    // Query DeepSeek-Reasoner (R1)
    if (process.env.DEEPSEEK_API_KEY) {
      process.stdout.write("  • Querying DeepSeek-Reasoner (R1)... ");
      try {
        const reply = await queryModel(
          "deepseek-reasoner",
          "https://api.deepseek.com/v1/chat/completions",
          process.env.DEEPSEEK_API_KEY,
          reviewPrompt,
        );
        const result = parseFrontierReview("DeepSeek-Reasoner (R1)", reply);
        frontierResults.push(result);
        console.log(`${result.verdict} (Risk: ${result.risk}, Confidence: ${result.confidence}/5)`);
      } catch (e: unknown) {
        console.log(`❌ ERROR: ${(e as Error).message}`);
      }
    } else {
      console.log("  ⚠️  DEEPSEEK_API_KEY not set. Skipping DeepSeek-Reasoner check.");
    }

    // Query Codestral (Mistral)
    if (process.env.MISTRAL_API_KEY) {
      process.stdout.write("  • Querying Mistral Codestral... ");
      try {
        const reply = await queryModel(
          "codestral-latest",
          "https://api.mistral.ai/v1/chat/completions",
          process.env.MISTRAL_API_KEY,
          reviewPrompt,
        );
        const result = parseFrontierReview("Mistral Codestral", reply);
        frontierResults.push(result);
        console.log(`${result.verdict} (Risk: ${result.risk}, Confidence: ${result.confidence}/5)`);
      } catch (e: unknown) {
        console.log(`❌ ERROR: ${(e as Error).message}`);
      }
    } else {
      console.log("  ⚠️  MISTRAL_API_KEY not set. Skipping Codestral check.");
    }

    if (frontierResults.length === 0) {
      console.log("  ❌ No frontier models available for review (missing API keys).");
      failureReasons.push("Frontier model consensus could not be evaluated due to missing API keys.");
      allGatesPassed = false;
    } else {
      const nonApprovals = frontierResults.filter((r) => r.verdict !== "APPROVE");
      const highRisk = frontierResults.filter((r) => r.risk === "High" || r.risk === "Medium");

      if (nonApprovals.length > 0) {
        console.log(`  ❌ Frontier model consensus FAILED: ${nonApprovals.map((r) => `${r.model} (${r.verdict})`).join(", ")}`);
        for (const item of nonApprovals) {
          console.log(`\n--- Critique from ${item.model} ---`);
          console.log(item.raw.slice(0, 1000));
        }
        failureReasons.push(`Frontier models rejected merge: ${nonApprovals.map((r) => `${r.model}: ${r.verdict}`).join("; ")}`);
        allGatesPassed = false;
      } else if (highRisk.length > 0) {
        console.log(`  ❌ Frontier models assessed risk as ${highRisk.map((r) => `${r.model}: ${r.risk}`).join(", ")} (must be Low or Very Low)`);
        failureReasons.push("Frontier models assessed elevated risk (Medium/High).");
        allGatesPassed = false;
      } else {
        console.log(`  ✓ Frontier consensus achieved: All ${frontierResults.length} model(s) approved with Low risk.`);
      }
    }
  }

  // =========================================================
  // SUMMARY & VERDICT
  // =========================================================
  console.log(`\n=======================================================`);
  if (allGatesPassed) {
    console.log(`  🎉 ALL MERGE GATES PASSED`);
    console.log(`  PR #${prNumber} is certified for autonomous merge.`);
    console.log(`  You may proceed with: gh pr merge ${prNumber} --squash --delete-branch`);
    console.log(`=======================================================\n`);
    process.exit(0);
  } else {
    console.log(`  🚫 MERGE GATE FAILED: DO NOT MERGE PR #${prNumber}`);
    console.log(`  The following conditions were not met:`);
    for (const r of failureReasons) {
      console.log(`    - ${r}`);
    }
    console.log(`\n  Address the above issues and rerun: npm run gate:verify ${prNumber}`);
    console.log(`=======================================================\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected error in gate verification:", err);
  process.exit(1);
});
