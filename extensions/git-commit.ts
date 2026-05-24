/**
 * /git-commit
 *
 * Safely splits the current tangled working-tree diff into clean semantic commits.
 *
 * What it does:
 *   1. Requires a dirty working tree.
 *   2. Creates a WIP commit containing the full current final state.
 *   3. Stores that commit SHA as the "golden final answer."
 *   4. Creates a read-only reference worktree at the golden final commit.
 *   5. Switches the active repo to a replay branch at the original base commit.
 *   6. Sends the agent instructions, few-shot examples, and the final verification command.
 *
 * Finish condition:
 *   git diff --exit-code FINAL_SHA HEAD
 *
 * When that exits 0, the clean commit stack exactly matches the original tangled diff.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
} from "node:path";
import { execFileSync } from "node:child_process";

const RULES_PATH = join(process.env.HOME || "", ".pi/agent/git-commit-rules.md");

function exec(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function git(args: string[], cwd?: string): string {
  return exec("git", args, cwd);
}

function gitRoot(): string {
  return git(["rev-parse", "--show-toplevel"]);
}

function gitPath(root: string, path: string): string {
  const result = git(["rev-parse", "--git-path", path], root);
  return isAbsolute(result) ? result : join(root, result);
}

function readRules(): string {
  if (!existsSync(RULES_PATH)) {
    return [
      "# Git Commit Rules",
      "",
      "Use small semantic commits.",
      "Each commit should represent one logical idea.",
      "Each commit should build unless explicitly stated otherwise.",
      "Do not mix mechanical refactors with behavior changes.",
      "Do not include unrelated cleanup in feature or bug-fix commits.",
    ].join("\n");
  }

  return readFileSync(RULES_PATH, "utf-8");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function safeBranchNamePart(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function assertNoGitOperationInProgress(root: string): void {
  const blockers = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
    "BISECT_LOG",
  ];

  for (const blocker of blockers) {
    if (existsSync(gitPath(root, blocker))) {
      throw new Error(`repository has an in-progress Git operation: ${blocker}`);
    }
  }

  const rebaseMerge = gitPath(root, "rebase-merge");
  const rebaseApply = gitPath(root, "rebase-apply");

  if (existsSync(rebaseMerge) || existsSync(rebaseApply)) {
    throw new Error("repository appears to be in the middle of a rebase");
  }
}

function latestSplitStatePath(root: string): string | null {
  const gitDir = git(["rev-parse", "--git-dir"], root);
  const resolvedGitDir = isAbsolute(gitDir) ? gitDir : join(root, gitDir);

  if (!existsSync(resolvedGitDir)) {
    return null;
  }

  const files = readdirSync(resolvedGitDir)
    .filter((name) => name.startsWith("pi-git-commit-state-") && name.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    return null;
  }

  return join(resolvedGitDir, files[files.length - 1]);
}

const SEGMENT_FEW_SHOTS = `
Few-shot examples of good commit segmentation.

These examples are task-agnostic. Do not copy their domain details into the current task.
Use them only to understand the shape of a clean split.

Example 1: Feature, tests, and polish are tangled together

Bad segmentation:
- Commit 1: first half of changed files
- Commit 2: second half of changed files
- Commit 3: fixes

Good segmentation:
- Commit 1: add the core data/model support
  Purpose: introduce the underlying types, state, schema, or data structures needed by the feature.
  Include:
  - new types or interfaces
  - new state fields
  - parsing or serialization changes
  - minimal plumbing needed for later commits
  Exclude until later:
  - UI polish
  - broad refactors
  - unrelated cleanup
  - tests for behavior that does not exist yet
  Validation:
  - build/typecheck passes

- Commit 2: implement the user-visible behavior
  Purpose: make the feature actually work using the foundation from commit 1.
  Include:
  - main behavior change
  - integration into the existing flow
  - feature-specific control logic
  Exclude until later:
  - cosmetic styling
  - large cleanup
  - optional edge-case polish
  Validation:
  - build/typecheck passes
  - focused behavior check passes

- Commit 3: add tests and edge-case handling
  Purpose: lock in the new behavior and cover important failure modes.
  Include:
  - unit tests
  - integration tests
  - empty/loading/error/edge states when relevant
  Exclude until later:
  - cosmetic-only changes
  - unrelated refactors
  Validation:
  - relevant tests pass

- Commit 4: polish naming, copy, and presentation
  Purpose: improve clarity without changing the core behavior.
  Include:
  - UI text
  - styling
  - naming cleanup
  - comments where useful
  Validation:
  - build/typecheck passes

Example 2: Refactor and behavior change are tangled together

Bad segmentation:
- Commit 1: refactor and new behavior
- Commit 2: fix broken tests

Good segmentation:
- Commit 1: perform mechanical refactor with no behavior change
  Purpose: make a safe structural change before altering behavior.
  Include:
  - renames
  - moving code
  - extracting helpers
  - updating call sites
  Exclude until later:
  - new behavior
  - new validation rules
  - changed business logic
  Validation:
  - tests pass
  - diff should be mostly mechanical

- Commit 2: introduce the behavior change using the refactored structure
  Purpose: make the actual behavior change.
  Include:
  - changed logic
  - new branches or conditions
  - updated outputs
  Exclude until later:
  - unrelated cleanup
  - broad formatting
  Validation:
  - focused tests pass

- Commit 3: update tests and documentation for the new behavior
  Purpose: align expectations with the new behavior.
  Include:
  - test expectation updates
  - new regression tests
  - docs/comments where behavior changed
  Validation:
  - full relevant test suite passes

Example 3: Backend/API and frontend/client changes are tangled together

Bad segmentation:
- Commit 1: backend files
- Commit 2: frontend files
- Commit 3: misc

Good segmentation:
- Commit 1: add the contract/foundation
  Purpose: define the underlying capability or API/data contract.
  Include:
  - route/schema/type changes
  - validation
  - persistence/query support if needed
  Exclude until later:
  - UI usage
  - styling
  - unrelated cleanup
  Validation:
  - relevant backend/type/schema checks pass

- Commit 2: consume the contract in the caller/client
  Purpose: wire the consumer to the new capability.
  Include:
  - API/client call
  - state handling
  - integration with existing screens/components/callers
  Exclude until later:
  - polish
  - unrelated component or caller refactors
  Validation:
  - build/typecheck passes

- Commit 3: add UX states, errors, and tests
  Purpose: make the feature robust.
  Include:
  - loading states
  - error states
  - empty states
  - focused tests
  Validation:
  - relevant tests pass

Example 4: Bug fix, cleanup, and guardrails are tangled together

Bad segmentation:
- Commit 1: all bug fix files
- Commit 2: cleanup

Good segmentation:
- Commit 1: add regression coverage if practical
  Purpose: capture the bug before fixing it.
  Include:
  - focused regression test
  - minimal fixture changes
  Exclude until later:
  - implementation fix
  - broad cleanup
  Validation:
  - test should fail before the fix, if checking that is practical

- Commit 2: fix the bug
  Purpose: make the smallest behavior change that resolves the issue.
  Include:
  - targeted logic fix
  - minimal supporting changes
  Exclude until later:
  - unrelated cleanup
  - naming/style improvements
  Validation:
  - regression test passes

- Commit 3: clean up nearby code safely
  Purpose: improve readability after the fix is proven.
  Include:
  - small local cleanup
  - clearer names
  - comments if needed
  Exclude:
  - new behavior
  - broad refactors
  Validation:
  - tests still pass

Example 5: Config or migration plus code usage are tangled together

Bad segmentation:
- Commit 1: config, migration, and usage all together
- Commit 2: fix errors

Good segmentation:
- Commit 1: add config/schema/migration foundation
  Purpose: introduce the new environment, schema, migration, or config capability.
  Include:
  - config keys
  - migration files
  - schema updates
  - generated types if required
  Exclude until later:
  - feature usage
  - cleanup
  Validation:
  - migration/config validation passes if available

- Commit 2: update application code to use the new foundation
  Purpose: consume the new config/schema/migration in real code.
  Include:
  - call-site updates
  - feature logic using the new field/config
  - compatibility handling
  Validation:
  - build/tests pass

- Commit 3: remove obsolete compatibility code if safe
  Purpose: clean up old paths after the new path works.
  Include:
  - dead code removal
  - obsolete config removal
  - old fallback removal
  Validation:
  - tests pass

General lessons from the examples:
- Prefer semantic commits over file-based commits.
- A commit should answer: “what single idea changed?”
- Do not split by patch hunks.
- Do not split by first half / second half of files.
- Do not mix mechanical refactors with behavior changes.
- If two logical changes touch the same function, edit that function in multiple commits.
- It is okay for an intermediate commit to contain code that is not identical to either the original base or the final tangled diff.
- The final clean commit stack must exactly match the golden final state.

Required segment proposal format:

Commit 1:
Message:
Purpose:
Include:
Exclude until later:
Files/functions likely touched:
Validation:

Commit 2:
Message:
Purpose:
Include:
Exclude until later:
Files/functions likely touched:
Validation:

Continue for as many commits as needed.
`;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("git-commit", {
    description: "Split the current tangled diff into clean commits using a golden final snapshot",
    handler: async (_args: string, ctx: any) => {
      try {
        const root = gitRoot();

        assertNoGitOperationInProgress(root);

        const status = git(["status", "--porcelain=v1"], root);

        if (!status) {
          ctx.ui.notify("Nothing to commit: working tree is clean", "error");
          return;
        }

        const id = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
        const repoName = safeBranchNamePart(basename(root)) || "repo";

        const finalBranch = `split/final-${id}`;
        const replayBranch = `split/replay-${id}`;
        const finalWorktree = join(dirname(root), `${repoName}.final-${id}`);

        if (existsSync(finalWorktree)) {
          throw new Error(`final reference worktree already exists: ${finalWorktree}`);
        }

        git(["switch", "-c", finalBranch], root);
        git(["add", "-A"], root);
        git(["commit", "--no-verify", "-m", `WIP: golden final state for split ${id}`], root);

        const finalSha = git(["rev-parse", "HEAD"], root);
        const baseSha = git(["rev-parse", "HEAD~1"], root);

        git(["worktree", "add", "--detach", finalWorktree, finalSha], root);
        git(["switch", "-c", replayBranch, baseSha], root);

        const state = {
          id,
          root,
          finalBranch,
          replayBranch,
          finalSha,
          baseSha,
          finalWorktree,
          createdAt: new Date().toISOString(),
        };

        const statePath = gitPath(root, `pi-git-commit-state-${id}.json`);
        mkdirSync(dirname(statePath), { recursive: true });
        writeFileSync(statePath, JSON.stringify(state, null, 2));

        const rules = readRules();

        const message = [
          "We are splitting the current tangled diff into clean semantic commits.",
          "",
          "The safety setup has already been done.",
          "",
          `Golden final commit: ${finalSha}`,
          `Base commit: ${baseSha}`,
          `Replay branch: ${replayBranch}`,
          `Read-only final reference worktree: ${finalWorktree}`,
          "",
          "Mental model:",
          "",
          "The golden final commit is the exact messy final answer we need to reproduce.",
          "The current branch has been reset to the clean base.",
          "Your job is to rebuild the golden final state as a sequence of clean semantic commits.",
          "",
          "The goal command is:",
          "",
          `git diff --exit-code ${finalSha} HEAD`,
          "",
          "When that command exits 0, the clean commit stack exactly matches the original tangled final state.",
          "When it exits nonzero, inspect the remaining diff and keep replaying clean semantic commits.",
          "",
          "Useful commands:",
          "",
          `git diff HEAD ${finalSha}`,
          `git diff --stat HEAD ${finalSha}`,
          `git diff --exit-code ${finalSha} HEAD`,
          `git -C ${shellQuote(finalWorktree)} status --short`,
          "",
          "Required workflow:",
          "",
          "1. Inspect the diff between HEAD and the golden final commit.",
          "2. Propose clean commit segments before editing.",
          "3. Implement only the first proposed segment.",
          "4. Build/test.",
          "5. Commit that segment.",
          "6. Run the goal command.",
          "7. If the goal command is still nonzero, inspect the remaining diff and continue with the next semantic segment.",
          "8. Stop only when the goal command exits 0.",
          "",
          "Hard rules:",
          "",
          "- Do not use git add -p.",
          "- Do not use git commit -p.",
          "- Do not pipe y/n answers into interactive Git commands.",
          "- Do not split hunks mechanically.",
          "- Do not use git checkout -- <file>.",
          "- Do not use git restore <file>.",
          "- Do not use git stash.",
          "- Do not modify the read-only final reference worktree.",
          "- Work only on the replay branch.",
          "- It is okay to edit the same function across multiple commits.",
          "- It is okay for an intermediate commit to contain code that never existed in the original tangled diff.",
          "- Each commit should be semantic, not merely a chunk of nearby lines.",
          "- Each commit should build unless there is a clear reason it cannot.",
          "",
          "Why Git cannot do this automatically:",
          "",
          "Git only understands text differences. It cannot know which lines belong to which logical idea. If two logical changes touch the same function, Git may show them in one hunk even though they belong in separate commits. In that case, create an intermediate version of the function in one commit, then edit it again in a later commit.",
          "",
          "Recovery:",
          "",
          "If you damage the replay branch, the golden final state is still safe.",
          "You may restart the replay branch with:",
          "",
          `git reset --hard ${baseSha}`,
          "",
          "Then replay the clean commits again.",
          "",
          "Few-shot examples for commit segmentation:",
          "",
          SEGMENT_FEW_SHOTS,
          "",
          "Project commit rules:",
          "",
          rules,
          "",
          "Now inspect the diff and propose the clean commit plan before making changes.",
        ].join("\n");

        pi.sendUserMessage(message);
        ctx.ui.notify(`Golden final snapshot created. Agent is now on ${replayBranch}`, "success");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`/git-commit failed: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("git-commit-verify", {
    description: "Verify that the current replay branch exactly matches the latest golden final snapshot",
    handler: async (args: string, ctx: any) => {
      try {
        const root = gitRoot();
        let finalSha = args.trim();

        if (!finalSha) {
          const statePath = latestSplitStatePath(root);

          if (!statePath) {
            ctx.ui.notify("No split state found. Pass a FINAL_SHA manually.", "error");
            return;
          }

          const state = JSON.parse(readFileSync(statePath, "utf-8")) as {
            finalSha?: string;
          };

          if (!state.finalSha) {
            ctx.ui.notify(`Split state is missing finalSha: ${statePath}`, "error");
            return;
          }

          finalSha = state.finalSha;
        }

        git(["diff", "--exit-code", finalSha, "HEAD"], root);
        ctx.ui.notify("Verified: current HEAD exactly matches the golden final snapshot", "success");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`/git-commit-verify failed: ${message}`, "error");
      }
    },
  });
}
